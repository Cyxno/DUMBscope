/**
 * Incident persistence: SQLite is the source of truth for incident history.
 */
import { randomUUID } from 'node:crypto';
import type {
	Incident,
	IncidentEvidence,
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
}

function rowToIncident(
	row: IncidentRow,
	events: { at: number; kind: string; message: string; severity: string | null }[]
): Incident {
	let evidence: IncidentEvidence[] = [];
	const timeline: IncidentTimelineEntry[] = [];
	for (const event of events) {
		if (event.kind === 'evidence') {
			evidence.push({ at: event.at, source: 'logs', message: event.message });
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

export const incidentRepository = {
	create(incident: Incident): void {
		getDb()
			.prepare(
				`INSERT INTO incidents (id, fingerprint, severity, status, title, summary, root_cause_service,
				 root_cause_fingerprint, affected_services, first_seen, last_seen, resolved_at, occurrences)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
				incident.occurrences
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
				 root_cause_fingerprint = ?, affected_services = ?, last_seen = ?, resolved_at = ?, occurrences = ?
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

	active(): Incident[] {
		const rows = getDb()
			.prepare("SELECT * FROM incidents WHERE status = 'active' ORDER BY first_seen ASC")
			.all() as unknown as IncidentRow[];
		const events = loadEvents(rows.map((r) => r.id));
		return rows.map((row) => rowToIncident(row, events.get(row.id) ?? []));
	},

	recent(limit: number): Incident[] {
		const rows = getDb()
			.prepare('SELECT * FROM incidents ORDER BY last_seen DESC LIMIT ?')
			.all(limit) as unknown as IncidentRow[];
		const events = loadEvents(rows.map((r) => r.id));
		return rows.map((row) => rowToIncident(row, events.get(row.id) ?? []));
	},

	/** Find an open incident with the same fingerprint (for dedup/reopen). */
	findActiveByFingerprint(fingerprint: string): Incident | null {
		const row = getDb()
			.prepare("SELECT * FROM incidents WHERE fingerprint = ? AND status = 'active' LIMIT 1")
			.get(fingerprint) as unknown as IncidentRow | undefined;
		if (!row) return null;
		const events = loadEvents([row.id]).get(row.id) ?? [];
		return rowToIncident(row, events);
	},

	/** Most recent incident for a fingerprint regardless of status. */
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
