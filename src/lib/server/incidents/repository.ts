/**
 * Incident persistence: SQLite is the source of truth for incident history.
 *
 * Lifecycle rules encoded here:
 * - `open` = active + acknowledged (acknowledged problems are still open).
 * - Archive is a soft state, never a deletion; recurrence under an archived
 *   fingerprint opens a fresh row instead of un-archiving history.
 */
import { randomUUID } from 'node:crypto';
import type {
	Incident,
	IncidentCounts,
	IncidentEvidence,
	IncidentResolutionKind,
	IncidentSeverity,
	IncidentStatus,
	IncidentTimelineEntry
} from '$lib/types';
import { getDb } from '../database/db';

interface IncidentRow {
	id: string;
	fingerprint: string;
	severity: string;
	status: string;
	title: string;
	summary: string | null;
	root_cause_service: string | null;
	root_cause_fingerprint: string | null;
	affected_services: string;
	first_seen: number;
	last_seen: number;
	resolved_at: number | null;
	occurrences: number;
	detector: string | null;
	last_evaluated_at: number | null;
	last_evidence_at: number | null;
	acknowledged_at: number | null;
	resolution_kind: string | null;
	resolution_reason: string | null;
}

function rowToIncident(
	row: IncidentRow,
	events: { at: number; kind: string; message: string; severity: string | null }[]
): Incident {
	let evidence: IncidentEvidence[] = [];
	const timeline: IncidentTimelineEntry[] = [];
	let lastEvidenceAt: number | null = null;
	for (const event of events) {
		if (event.kind === 'evidence') {
			evidence.push({ at: event.at, source: 'logs', message: event.message });
			lastEvidenceAt = event.at;
			continue;
		}
		if (evidence.length > 0 || timeline.length > 0) {
			// Evidence rows always precede later timeline rows in practice.
			evidence = evidence.slice(-10);
		}
		timeline.push({
			at: event.at,
			message: event.message,
			severity: (event.severity as IncidentSeverity) ?? 'info'
		});
	}
	return {
		id: row.id,
		fingerprint: row.fingerprint,
		severity: row.severity as IncidentSeverity,
		status: row.status as IncidentStatus,
		title: row.title,
		summary: row.summary,
		rootCauseService: row.root_cause_service,
		rootCauseFingerprint: row.root_cause_fingerprint,
		affectedServices: JSON.parse(row.affected_services) as string[],
		firstSeen: row.first_seen,
		lastSeen: row.last_seen,
		resolvedAt: row.resolved_at,
		occurrences: row.occurrences,
		detector: row.detector ?? '',
		lastEvaluatedAt: row.last_evaluated_at,
		lastEvidenceAt: row.last_evidence_at ?? lastEvidenceAt,
		acknowledgedAt: row.acknowledged_at,
		resolutionKind: (row.resolution_kind as IncidentResolutionKind | null) ?? null,
		resolutionReason: row.resolution_reason,
		evidence: evidence.slice(-10),
		timeline: timeline.slice(-100)
	};
}

function loadEvents(
	incidentIds: string[]
): Map<string, { at: number; kind: string; message: string; severity: string | null }[]> {
	const map = new Map<
		string,
		{ at: number; kind: string; message: string; severity: string | null }[]
	>();
	if (incidentIds.length === 0) return map;
	const placeholders = incidentIds.map(() => '?').join(',');
	const rows = getDb()
		.prepare(
			`SELECT incident_id, at, kind, message, severity FROM incident_events
			 WHERE incident_id IN (${placeholders}) ORDER BY at ASC, id ASC`
		)
		.all(...incidentIds) as unknown as {
		incident_id: string;
		at: number;
		kind: string;
		message: string;
		severity: string | null;
	}[];
	for (const row of rows) {
		const list = map.get(row.incident_id) ?? [];
		list.push({ at: row.at, kind: row.kind, message: row.message, severity: row.severity });
		map.set(row.incident_id, list);
	}
	return map;
}

/** Statuses that represent an open problem (the engine keeps evaluating these). */
const OPEN_STATUSES = "('active', 'acknowledged')";

export const incidentRepository = {
	create(incident: Incident): void {
		getDb()
			.prepare(
				`INSERT INTO incidents (id, fingerprint, severity, status, title, summary, root_cause_service,
				 root_cause_fingerprint, affected_services, first_seen, last_seen, resolved_at, occurrences,
				 detector, last_evaluated_at, last_evidence_at, acknowledged_at, resolution_kind, resolution_reason)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				incident.id,
				incident.fingerprint,
				incident.severity,
				incident.status,
				incident.title,
				incident.summary,
				incident.rootCauseService,
				incident.rootCauseFingerprint,
				JSON.stringify(incident.affectedServices),
				incident.firstSeen,
				incident.lastSeen,
				incident.resolvedAt,
				incident.occurrences,
				incident.detector,
				incident.lastEvaluatedAt,
				incident.lastEvidenceAt,
				incident.acknowledgedAt,
				incident.resolutionKind,
				incident.resolutionReason
			);
		this.appendTimeline(incident.id, {
			at: incident.firstSeen,
			message: `Incident opened: ${incident.title}`,
			severity: incident.severity
		});
	},

	update(incident: Incident): void {
		getDb()
			.prepare(
				`UPDATE incidents SET severity = ?, status = ?, title = ?, summary = ?, root_cause_service = ?,
				 root_cause_fingerprint = ?, affected_services = ?, last_seen = ?, resolved_at = ?, occurrences = ?,
				 detector = ?, last_evaluated_at = ?, last_evidence_at = ?, acknowledged_at = ?,
				 resolution_kind = ?, resolution_reason = ?
				 WHERE id = ?`
			)
			.run(
				incident.severity,
				incident.status,
				incident.title,
				incident.summary,
				incident.rootCauseService,
				incident.rootCauseFingerprint,
				JSON.stringify(incident.affectedServices),
				incident.lastSeen,
				incident.resolvedAt,
				incident.occurrences,
				incident.detector,
				incident.lastEvaluatedAt,
				incident.lastEvidenceAt,
				incident.acknowledgedAt,
				incident.resolutionKind,
				incident.resolutionReason,
				incident.id
			);
	},

	appendTimeline(incidentId: string, entry: IncidentTimelineEntry): void {
		getDb()
			.prepare(
				'INSERT INTO incident_events (incident_id, at, kind, message, severity) VALUES (?, ?, ?, ?, ?)'
			)
			.run(incidentId, entry.at, 'timeline', entry.message, entry.severity);
	},

	appendEvidence(incidentId: string, evidence: IncidentEvidence): void {
		getDb()
			.prepare(
				'INSERT INTO incident_events (incident_id, at, kind, message, severity) VALUES (?, ?, ?, ?, ?)'
			)
			.run(incidentId, evidence.at, 'evidence', evidence.message, null);
	},

	get(id: string): Incident | null {
		const row = getDb().prepare('SELECT * FROM incidents WHERE id = ?').get(id) as unknown as
			IncidentRow | undefined;
		if (!row) return null;
		const events = loadEvents([row.id]).get(row.id) ?? [];
		return rowToIncident(row, events);
	},

	/** Strictly `active` rows (used by hydration: acknowledged rows must not re-arm streaks). */
	active(): Incident[] {
		const rows = getDb()
			.prepare("SELECT * FROM incidents WHERE status = 'active' ORDER BY first_seen ASC")
			.all() as unknown as IncidentRow[];
		const events = loadEvents(rows.map((r) => r.id));
		return rows.map((row) => rowToIncident(row, events.get(row.id) ?? []));
	},

	/** Open problems: active + acknowledged. */
	open(): Incident[] {
		const rows = getDb()
			.prepare(`SELECT * FROM incidents WHERE status IN ${OPEN_STATUSES} ORDER BY first_seen ASC`)
			.all() as unknown as IncidentRow[];
		const events = loadEvents(rows.map((r) => r.id));
		return rows.map((row) => rowToIncident(row, events.get(row.id) ?? []));
	},

	/** History query by status group; `resolved` covers resolved only, `archived` archived only. */
	byStatusGroup(group: 'open' | 'resolved' | 'archived' | 'all', limit: number): Incident[] {
		const where =
			group === 'open'
				? `status IN ${OPEN_STATUSES}`
				: group === 'resolved'
					? "status = 'resolved'"
					: group === 'archived'
						? "status = 'archived'"
						: '1=1';
		const rows = getDb()
			.prepare(`SELECT * FROM incidents WHERE ${where} ORDER BY last_seen DESC LIMIT ?`)
			.all(limit) as unknown as IncidentRow[];
		const events = loadEvents(rows.map((r) => r.id));
		return rows.map((row) => rowToIncident(row, events.get(row.id) ?? []));
	},

	counts(): IncidentCounts {
		const row = getDb()
			.prepare(
				`SELECT
				 SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
				 SUM(CASE WHEN status = 'acknowledged' THEN 1 ELSE 0 END) AS acknowledged,
				 SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved
				 FROM incidents`
			)
			.get() as { active: number | null; acknowledged: number | null; resolved: number | null };
		return {
			active: row.active ?? 0,
			acknowledged: row.acknowledged ?? 0,
			resolved: row.resolved ?? 0
		};
	},

	/**
	 * Operator actions. Acknowledge keeps the incident technically open (the
	 * engine keeps evaluating it); archive is only valid for closed incidents.
	 * Returns the updated incident or null when the transition is not allowed.
	 */
	acknowledge(id: string, at: number, message: string): Incident | null {
		const incident = this.get(id);
		if (!incident) return null;
		if (incident.status !== 'active' && incident.status !== 'acknowledged') return null;
		incident.status = 'acknowledged';
		incident.acknowledgedAt = incident.acknowledgedAt ?? at;
		this.update(incident);
		this.appendTimeline(incident.id, { at, message, severity: 'info' });
		return incident;
	},

	unacknowledge(id: string, at: number, message: string): Incident | null {
		const incident = this.get(id);
		if (!incident || incident.status !== 'acknowledged') return null;
		incident.status = 'active';
		incident.acknowledgedAt = null;
		this.update(incident);
		this.appendTimeline(incident.id, { at, message, severity: 'info' });
		return incident;
	},

	archive(id: string, at: number, message: string): Incident | null {
		const incident = this.get(id);
		if (!incident) return null;
		if (incident.status !== 'resolved' && incident.status !== 'archived') return null;
		if (incident.status === 'archived') return incident;
		incident.status = 'archived';
		this.update(incident);
		this.appendTimeline(incident.id, { at, message, severity: 'info' });
		return incident;
	},

	/** Bulk-archive resolved incidents (optionally only those resolved before `beforeMs`). */
	archiveResolved(beforeMs: number | null, at: number, message: string): number {
		const result = beforeMs
			? getDb()
					.prepare(
						`UPDATE incidents SET status = 'archived'
						 WHERE status = 'resolved' AND resolved_at IS NOT NULL AND resolved_at < ?`
					)
					.run(beforeMs)
			: getDb().prepare("UPDATE incidents SET status = 'archived' WHERE status = 'resolved'").run();
		const count = Number(result.changes ?? 0);
		if (count > 0) {
			const ids = getDb()
				.prepare(
					`SELECT id FROM incidents WHERE status = 'archived'
					 AND ${beforeMs ? 'resolved_at < ? AND ' : ''}id NOT IN (
					     SELECT incident_id FROM incident_events WHERE message = ?)`
				)
				.all(...(beforeMs ? [beforeMs, message] : [message]));
			for (const row of ids as { id: string }[]) {
				this.appendTimeline(row.id, { at, message, severity: 'info' });
			}
		}
		return count;
	},

	/** Most recent incidents regardless of status (snapshot/diagnostics views). */
	recent(limit: number): Incident[] {
		return this.byStatusGroup('all', limit);
	},

	/** Find an open incident with the same fingerprint (for dedup/reopen). */
	findActiveByFingerprint(fingerprint: string): Incident | null {
		const row = getDb()
			.prepare(
				`SELECT * FROM incidents WHERE fingerprint = ? AND status IN ${OPEN_STATUSES} LIMIT 1`
			)
			.get(fingerprint) as unknown as IncidentRow | undefined;
		if (!row) return null;
		const events = loadEvents([row.id]).get(row.id) ?? [];
		return rowToIncident(row, events);
	},

	/**
	 * Most recent incident for a fingerprint regardless of status. Archive-aware
	 * reopen semantics live in the engine: `resolved` rows re-open with an
	 * occurrence bump, `archived` rows stay archived and a fresh row is created.
	 */
	findLatestByFingerprint(fingerprint: string): Incident | null {
		const row = getDb()
			.prepare('SELECT * FROM incidents WHERE fingerprint = ? ORDER BY last_seen DESC LIMIT 1')
			.get(fingerprint) as unknown as IncidentRow | undefined;
		if (!row) return null;
		const events = loadEvents([row.id]).get(row.id) ?? [];
		return rowToIncident(row, events);
	},

	pruneHistory(keepCount: number): void {
		getDb()
			.prepare(
				`DELETE FROM incidents WHERE id NOT IN (
					SELECT id FROM incidents ORDER BY last_seen DESC LIMIT ?
				)`
			)
			.run(keepCount);
	}
};

export function newIncidentId(): string {
	return randomUUID();
}
