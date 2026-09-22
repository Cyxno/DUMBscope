/**
 * Long-term retention for per-process memory samples (§6).
 *
 * Raw samples (one row per process per minute) are kept ~26h for anomaly
 * detection. Two aggregate tiers extend the visible history without growing
 * the raw table: 5-minute buckets for 7 days, 30-minute buckets for 30 days.
 * Aggregates carry avg AND max per bucket and are idempotent per bucket, so
 * overlapping runs never duplicate rows. Steady-state size is bounded and
 * documented in docs/RELIABILITY.md (§Database & retention).
 */
import { getDb } from '../database/db';

export const MEMORY_RETENTION = {
	rawMs: 26 * 60 * 60_000,
	fiveMinMs: 7 * 24 * 60 * 60_000,
	thirtyMinMs: 30 * 24 * 60 * 60_000,
	fiveMinBucketMs: 5 * 60_000,
	thirtyMinBucketMs: 30 * 60_000
} as const;

/** Aggregate raw memory samples into the 5-minute tier. Returns rows written. */
export function downsampleMemoryToFiveMinutes(now: number): number {
	return aggregateMemory(
		'memory_samples_5m',
		Math.max(now - MEMORY_RETENTION.fiveMinMs, 0),
		now - MEMORY_RETENTION.fiveMinBucketMs,
		MEMORY_RETENTION.fiveMinBucketMs
	);
}

/** Aggregate raw memory samples into the 30-minute tier. Returns rows written. */
export function downsampleMemoryToThirtyMinutes(now: number): number {
	return aggregateMemory(
		'memory_samples_30m',
		Math.max(now - MEMORY_RETENTION.thirtyMinMs, 0),
		now - MEMORY_RETENTION.thirtyMinBucketMs,
		MEMORY_RETENTION.thirtyMinBucketMs
	);
}

function aggregateMemory(
	table: 'memory_samples_5m' | 'memory_samples_30m',
	from: number,
	before: number,
	bucketMs: number
): number {
	if (before <= from) return 0;
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT process, instance_key, at, rss_bytes FROM memory_samples
			 WHERE at >= ? AND at < ? ORDER BY at ASC`
		)
		.all(from, before) as {
		process: string;
		instance_key: string;
		at: number;
		rss_bytes: number;
	}[];
	if (rows.length === 0) return 0;

	const buckets = new Map<string, { at: number; values: number[] }>();
	for (const row of rows) {
		const bucketAt = Math.floor(row.at / bucketMs) * bucketMs;
		const key = `${row.process}\u0000${row.instance_key}\u0000${bucketAt}`;
		const entry = buckets.get(key) ?? { at: bucketAt, values: [] };
		entry.values.push(row.rss_bytes);
		buckets.set(key, entry);
	}

	const upsert = db.prepare(
		`INSERT OR REPLACE INTO ${table} (process, instance_key, at, avg_bytes, max_bytes, samples)
		 VALUES (?, ?, ?, ?, ?, ?)`
	);
	let written = 0;
	for (const [key, entry] of buckets) {
		const [process, instanceKey] = key.split('\u0000');
		if (!process) continue;
		const avg = Math.round(entry.values.reduce((a, b) => a + b, 0) / entry.values.length);
		upsert.run(
			process,
			instanceKey ?? '',
			entry.at,
			avg,
			Math.max(...entry.values),
			entry.values.length
		);
		written++;
	}
	return written;
}

/** Prune every memory tier to its retention window. Returns deleted counts. */
export function pruneMemorySamples(now: number): {
	raw: number;
	fiveMin: number;
	thirtyMin: number;
} {
	const db = getDb();
	const raw = db
		.prepare('DELETE FROM memory_samples WHERE at < ?')
		.run(now - MEMORY_RETENTION.rawMs);
	const fiveMin = db
		.prepare('DELETE FROM memory_samples_5m WHERE at < ?')
		.run(now - MEMORY_RETENTION.fiveMinMs);
	const thirtyMin = db
		.prepare('DELETE FROM memory_samples_30m WHERE at < ?')
		.run(now - MEMORY_RETENTION.thirtyMinMs);
	return {
		raw: Number(raw.changes ?? 0),
		fiveMin: Number(fiveMin.changes ?? 0),
		thirtyMin: Number(thirtyMin.changes ?? 0)
	};
}

export interface MemorySeriesPoint {
	at: number;
	avgBytes: number;
	maxBytes: number;
}

/** Long history for one process across tiers (UI graphs, trend context). */
export function loadMemorySeries(
	process: string,
	instanceKey: string,
	sinceMs: number
): MemorySeriesPoint[] {
	const now = Date.now();
	const out: MemorySeriesPoint[] = [];
	if (sinceMs <= now - MEMORY_RETENTION.thirtyMinMs) {
		out.push(...loadMemoryAggregates('memory_samples_30m', process, instanceKey, sinceMs));
	}
	if (sinceMs <= now - MEMORY_RETENTION.rawMs) {
		out.push(
			...loadMemoryAggregates(
				'memory_samples_5m',
				process,
				instanceKey,
				Math.max(sinceMs, now - MEMORY_RETENTION.thirtyMinMs)
			)
		);
	}
	const rows = getDb()
		.prepare(
			`SELECT at, rss_bytes FROM memory_samples
			 WHERE process = ? AND (instance_key = ? OR instance_key = '') AND at >= ?
			 ORDER BY at ASC`
		)
		.all(process, instanceKey, Math.max(sinceMs, now - MEMORY_RETENTION.rawMs)) as {
		at: number;
		rss_bytes: number;
	}[];
	for (const row of rows)
		out.push({ at: row.at, avgBytes: row.rss_bytes, maxBytes: row.rss_bytes });
	return out;
}

function loadMemoryAggregates(
	table: 'memory_samples_5m' | 'memory_samples_30m',
	process: string,
	instanceKey: string,
	since: number
): MemorySeriesPoint[] {
	const rows = getDb()
		.prepare(
			`SELECT at, avg_bytes, max_bytes FROM ${table}
			 WHERE process = ? AND (instance_key = ? OR instance_key = '') AND at >= ?
			 ORDER BY at ASC`
		)
		.all(process, instanceKey, since) as { at: number; avg_bytes: number; max_bytes: number }[];
	return rows.map((r) => ({ at: r.at, avgBytes: r.avg_bytes, maxBytes: r.max_bytes }));
}
