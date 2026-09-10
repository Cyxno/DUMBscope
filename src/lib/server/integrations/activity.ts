/**
 * Persisted semantic activity feed (brief §15/§16).
 *
 * `observed` rows come straight from a source system. Correlated/inferred
 * rows must always set observed=0 and carry the evidence in detail.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../database/db';
import type { ActivityEvent } from './types';

/** Retention defaults (brief §21). Housekeeper prunes periodically. */
export const ACTIVITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function insertActivity(events: ActivityEvent[]): void {
	if (events.length === 0) return;
	const db = getDb();
	const stmt = db.prepare(
		`INSERT OR IGNORE INTO activity
		 (id, at, source, service_key, category, title, detail, severity, observed, correlation_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	for (const e of events) {
		stmt.run(
			e.id || randomUUID(),
			e.at,
			e.source,
			e.serviceKey,
			e.category,
			e.title,
			e.detail,
			e.severity,
			e.observed ? 1 : 0,
			e.correlationId
		);
	}
}

export function listActivity(options: {
	from?: number;
	to?: number;
	serviceKey?: string;
	category?: string;
	source?: string;
	limit?: number;
}): ActivityEvent[] {
	const clauses: string[] = [];
	const params: (string | number)[] = [];
	if (options.from !== undefined) {
		clauses.push('at >= ?');
		params.push(options.from);
	}
	if (options.to !== undefined) {
		clauses.push('at <= ?');
		params.push(options.to);
	}
	if (options.serviceKey) {
		clauses.push('service_key = ?');
		params.push(options.serviceKey);
	}
	if (options.category) {
		clauses.push('category = ?');
		params.push(options.category);
	}
	if (options.source) {
		clauses.push('source = ?');
		params.push(options.source);
	}
	const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
	const limit = Math.min(options.limit ?? 200, 1000);
	const rows = getDb()
		.prepare(`SELECT * FROM activity ${where} ORDER BY at DESC, id DESC LIMIT ${limit}`)
		.all(...params) as Record<string, unknown>[];
	return rows.map((r) => ({
		id: r.id as string,
		at: r.at as number,
		source: r.source as string,
		serviceKey: (r.service_key as string) ?? null,
		category: r.category as ActivityEvent['category'],
		title: r.title as string,
		detail: (r.detail as string) ?? null,
		severity: (r.severity as ActivityEvent['severity']) ?? null,
		observed: r.observed === 1,
		correlationId: (r.correlation_id as string) ?? null
	}));
}

export function pruneActivity(maxAgeMs = ACTIVITY_MAX_AGE_MS): number {
	const result = getDb()
		.prepare('DELETE FROM activity WHERE at < ?')
		.run(Date.now() - maxAgeMs);
	return Number(result.changes);
}
