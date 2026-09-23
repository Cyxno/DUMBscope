/**
 * Combined DUMB timeline (brief §8): one append-only store for the facts that
 * matter around a DUMB incident — restarts, memory anomalies, repair loops,
 * mount failures, OOM, cgroup high/max bursts, thermal spikes, deploys and
 * download failures — merged from the detectors that already produce them.
 *
 * The timeline is correlation *display*: it never claims causality and never
 * notifies (Hermes remains the alerting layer). Retention is bounded at 30
 * days; a daily prune keeps the table fixed-size in steady state.
 */
import type { TimelineEvent } from '$lib/types';
import { getDb } from '../database/db';

export const TIMELINE_RETENTION = {
	/** Events older than this are pruned. */
	retentionMs: 30 * 24 * 60 * 60_000,
	/** Hard cap on rows (safety net under a runaway producer). */
	maxRows: 20_000,
	/** Cap on events of one kind recorded per minute (producer stamp guard). */
	sameKindQuietMs: 60_000
} as const;

const KINDS: ReadonlySet<TimelineEvent['kind']> = new Set([
	'restart',
	'memory-anomaly',
	'repair-loop',
	'mount',
	'oom',
	'cgroup-high',
	'cgroup-max',
	'thermal',
	'deploy',
	'download-failure',
	'health'
]);

export interface TimelineInput {
	at: number;
	kind: TimelineEvent['kind'];
	service?: string | null;
	severity?: TimelineEvent['severity'];
	title: string;
	detail?: string | null;
	/** Free-form JSON payload (correlation snapshot, versions, …). */
	data?: unknown;
}

let lastAtByKind = new Map<string, number>();

/** Record one timeline event. Failure-isolated: never throws. */
export function recordObservabilityEvent(event: TimelineInput): void {
	if (!KINDS.has(event.kind)) return;
	try {
		getDb()
			.prepare(
				`INSERT INTO observability_events (at, kind, service, severity, title, detail, data)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`
			)
			.run(
				event.at,
				event.kind,
				event.service ?? null,
				event.severity ?? null,
				event.title,
				event.detail ?? null,
				event.data === undefined ? null : JSON.stringify(event.data)
			);
	} catch {
		// best-effort by design
	}
}

/** Persist only if this kind has not been recorded within the quiet window. */
export function recordTimelineThrottled(
	event: TimelineInput,
	quietMs = TIMELINE_RETENTION.sameKindQuietMs
): boolean {
	const last = lastAtByKind.get(event.kind + '\u0000' + (event.service ?? ''));
	if (last !== undefined && event.at - last < quietMs) return false;
	lastAtByKind.set(event.kind + '\u0000' + (event.service ?? ''), event.at);
	recordObservabilityEvent(event);
	return true;
}

/** Test hook: reset the in-memory throttle state. */
export function resetTimelineThrottle(): void {
	lastAtByKind = new Map();
}

/** Query the merged timeline, newest first. */
export function queryTimeline(
	options: {
		hours?: number;
		kinds?: TimelineEvent['kind'][];
		service?: string | null;
		limit?: number;
		now?: number;
	} = {}
): TimelineEvent[] {
	const now = options.now ?? Date.now();
	const hours = Math.min(Math.max(options.hours ?? 24, 1), 24 * 30);
	const limit = Math.min(Math.max(options.limit ?? 200, 1), 1000);
	const since = now - hours * 3_600_000;
	try {
		const rows = getDb()
			.prepare(
				`SELECT id, at, kind, service, severity, title, detail, data
				 FROM observability_events
				 WHERE at >= ? ${options.kinds && options.kinds.length > 0 ? `AND kind IN (${options.kinds.map(() => '?').join(',')})` : ''}
				 ${options.service ? 'AND service = ?' : ''}
				 ORDER BY at DESC LIMIT ?`
			)
			.all(...buildParams(options, since, limit)) as {
			id: number;
			at: number;
			kind: string;
			service: string | null;
			severity: string | null;
			title: string;
			detail: string | null;
			data: string | null;
		}[];
		return rows.map((r) => ({
			id: r.id,
			at: r.at,
			kind: r.kind as TimelineEvent['kind'],
			service: r.service,
			severity: (r.severity as TimelineEvent['severity']) ?? null,
			title: r.title,
			detail: r.detail
		}));
	} catch {
		return [];
	}
}

function buildParams(
	options: { kinds?: TimelineEvent['kind'][]; service?: string | null },
	since: number,
	limit: number
): (string | number)[] {
	const params: (string | number)[] = [since];
	for (const k of options.kinds ?? []) params.push(k);
	if (options.service) params.push(options.service);
	params.push(limit);
	return params;
}

/** Prune old rows and enforce the hard cap. Returns deleted counts. */
export function pruneTimeline(now = Date.now()): { expired: number; capped: number } {
	try {
		const db = getDb();
		const expired = db
			.prepare('DELETE FROM observability_events WHERE at < ?')
			.run(now - TIMELINE_RETENTION.retentionMs);
		const count = db.prepare('SELECT COUNT(*) AS c FROM observability_events').get() as {
			c: number;
		};
		let capped = 0;
		if (count.c > TIMELINE_RETENTION.maxRows) {
			const excess = count.c - TIMELINE_RETENTION.maxRows;
			const del = db
				.prepare(
					`DELETE FROM observability_events WHERE id IN (
						SELECT id FROM observability_events ORDER BY at ASC LIMIT ?)`
				)
				.run(excess);
			capped = Number(del.changes ?? 0);
		}
		return { expired: Number(expired.changes ?? 0), capped };
	} catch {
		return { expired: 0, capped: 0 };
	}
}

/** Row count + oldest row age (System → Observability diagnostics). */
export function timelineStats(): { rows: number; oldestAt: number | null } {
	try {
		const row = getDb()
			.prepare('SELECT COUNT(*) AS c, MIN(at) AS oldest FROM observability_events')
			.get() as { c: number; oldest: number | null };
		return { rows: Number(row.c ?? 0), oldestAt: row.oldest ?? null };
	} catch {
		return { rows: 0, oldestAt: null };
	}
}
