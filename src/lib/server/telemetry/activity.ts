/**
 * Activity feed: observed facts (health transitions, restarts, connection
 * changes, incidents) recorded with timestamps. No invented activity —
 * everything here comes from a DUMB observation or a DUMBscope state change.
 */
import { getDb } from '../database/db';
import type { ActivityEntry, ActivityKind } from '$lib/types';

export type { ActivityEntry, ActivityKind };

type Listener = (entry: ActivityEntry) => void;
const listeners = new Set<Listener>();

export function onActivity(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function recordActivity(
	kind: ActivityKind,
	message: string,
	serviceKey: string | null = null,
	confidence: 'observed' | 'inferred' = 'observed'
): ActivityEntry {
	const entry: ActivityEntry = {
		id: 0,
		at: Date.now(),
		serviceKey,
		kind,
		message,
		confidence
	};
	try {
		const result = getDb()
			.prepare('INSERT INTO service_events (service_key, kind, message, at) VALUES (?, ?, ?, ?)')
			.run(serviceKey, kind, message, entry.at);
		entry.id = Number(result.lastInsertRowid);
	} catch (err) {
		console.warn(
			'[dumbscope] failed to persist activity:',
			err instanceof Error ? err.message : err
		);
	}
	for (const listener of listeners) {
		try {
			listener(entry);
		} catch {
			// A slow SSE subscriber must never break the feed.
		}
	}
	return entry;
}

export function recentActivity(limit = 100, beforeId?: number): ActivityEntry[] {
	const db = getDb();
	const rows =
		beforeId !== undefined
			? (db
					.prepare(
						'SELECT id, service_key, kind, message, at FROM service_events WHERE id < ? ORDER BY id DESC LIMIT ?'
					)
					.all(beforeId, limit) as Record<string, unknown>[])
			: (db
					.prepare(
						'SELECT id, service_key, kind, message, at FROM service_events ORDER BY id DESC LIMIT ?'
					)
					.all(limit) as Record<string, unknown>[]);
	return rows.map((row) => ({
		id: row.id as number,
		at: row.at as number,
		serviceKey: (row.service_key as string | null) ?? null,
		kind: row.kind as ActivityKind,
		message: row.message as string,
		confidence: 'observed'
	}));
}

export function pruneActivity(olderThanMs: number): void {
	getDb()
		.prepare('DELETE FROM service_events WHERE at < ?')
		.run(Date.now() - olderThanMs);
}
