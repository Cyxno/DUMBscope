/**
 * Bounded long-term storage for DUMBscope runtime metrics (§4/§6).
 *
 * Three tiers with fixed, documented retention:
 * - `runtime_samples`       1-minute rows, kept ~26 hours (~1.5k rows)
 * - `runtime_samples_5m`    5-minute aggregates, kept 7 days (~2k rows)
 * - `runtime_samples_30m`   30-minute aggregates, kept 30 days (~1.4k rows)
 *
 * Rows are fixed-width; total steady-state growth is a few thousand rows /
 * well under 1 MB. Aggregation keeps avg AND max (a 30-minute average must
 * not hide a leak spike). All writes are idempotent per bucket, so overlaps
 * never duplicate samples.
 */
import { getDb } from '../database/db';

export interface RuntimeSample {
	at: number;
	rssBytes: number | null;
	heapUsedBytes: number | null;
	heapTotalBytes: number | null;
	externalBytes: number | null;
	arrayBuffersBytes: number | null;
	eventLoopLagMs: number | null;
	fds: number | null;
	workersActive: number | null;
	workersSpawned: number | null;
	workersTerminated: number | null;
	workersTimedOut: number | null;
	sseClients: number | null;
	dbBytes: number | null;
	walBytes: number | null;
	jobsActive: number | null;
	reconDurationMs: number | null;
	probeDurationMs: number | null;
	notifQueueDepth: number | null;
}

export interface RuntimeAggregate {
	at: number;
	rssAvgBytes: number | null;
	rssMaxBytes: number | null;
	heapAvgBytes: number | null;
	heapMaxBytes: number | null;
	lagAvgMs: number | null;
	lagMaxMs: number | null;
	fdsMax: number | null;
	workersMax: number | null;
	sseMax: number | null;
	reconAvgMs: number | null;
	reconMaxMs: number | null;
	probeAvgMs: number | null;
	samples: number;
}

export const RUNTIME_RETENTION = {
	/** Cadence of persisted raw samples (ms). */
	sampleMs: 60_000,
	rawMs: 26 * 60 * 60_000,
	fiveMinMs: 7 * 24 * 60 * 60_000,
	thirtyMinMs: 30 * 24 * 60 * 60_000,
	/** Aggregate bucket sizes (ms). */
	fiveMinBucketMs: 5 * 60_000,
	thirtyMinBucketMs: 30 * 60_000
} as const;

const SAMPLE_COLUMNS = `at, rss_bytes, heap_used_bytes, heap_total_bytes, external_bytes, array_buffers_bytes,
	event_loop_lag_ms, fds, workers_active, workers_spawned, workers_terminated, workers_timed_out,
	sse_clients, db_bytes, wal_bytes, jobs_active, recon_duration_ms, probe_duration_ms, notif_queue_depth`;

function insertSample(sample: RuntimeSample): void {
	getDb()
		.prepare(
			`INSERT OR REPLACE INTO runtime_samples (${SAMPLE_COLUMNS})
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			sample.at,
			sample.rssBytes,
			sample.heapUsedBytes,
			sample.heapTotalBytes,
			sample.externalBytes,
			sample.arrayBuffersBytes,
			sample.eventLoopLagMs,
			sample.fds,
			sample.workersActive,
			sample.workersSpawned,
			sample.workersTerminated,
			sample.workersTimedOut,
			sample.sseClients,
			sample.dbBytes,
			sample.walBytes,
			sample.jobsActive,
			sample.reconDurationMs,
			sample.probeDurationMs,
			sample.notifQueueDepth
		);
}

/**
 * Aggregate raw samples older than the newest 5m bucket into 5-minute rows.
 * Returns the number of aggregates written. Idempotent per bucket.
 */
export function downsampleToFiveMinutes(now: number): number {
	const bucketMs = RUNTIME_RETENTION.fiveMinBucketMs;
	const currentBucket = Math.floor(now / bucketMs) * bucketMs;
	return aggregateBuckets(
		'runtime_samples_5m',
		Math.max(currentBucket - RUNTIME_RETENTION.fiveMinMs, 0),
		currentBucket,
		bucketMs
	);
}

/** Aggregate raw samples older than the newest 30m bucket into 30-minute rows. */
export function downsampleToThirtyMinutes(now: number): number {
	const bucketMs = RUNTIME_RETENTION.thirtyMinBucketMs;
	const currentBucket = Math.floor(now / bucketMs) * bucketMs;
	return aggregateBuckets(
		'runtime_samples_30m',
		Math.max(currentBucket - RUNTIME_RETENTION.thirtyMinMs, 0),
		currentBucket,
		bucketMs
	);
}

function aggregateBuckets(
	table: 'runtime_samples_5m' | 'runtime_samples_30m',
	from: number,
	beforeBucket: number,
	bucketMs: number
): number {
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT at, rss_bytes, heap_used_bytes, event_loop_lag_ms, fds, workers_active,
			        sse_clients, recon_duration_ms, probe_duration_ms
			 FROM runtime_samples WHERE at >= ? AND at < ? ORDER BY at ASC`
		)
		.all(from, beforeBucket) as {
		at: number;
		rss_bytes: number | null;
		heap_used_bytes: number | null;
		event_loop_lag_ms: number | null;
		fds: number | null;
		workers_active: number | null;
		sse_clients: number | null;
		recon_duration_ms: number | null;
		probe_duration_ms: number | null;
	}[];
	if (rows.length === 0) return 0;

	const buckets = new Map<number, typeof rows>();
	for (const row of rows) {
		const key = Math.floor(row.at / bucketMs) * bucketMs;
		const list = buckets.get(key) ?? [];
		list.push(row);
		buckets.set(key, list);
	}

	const upsert = db.prepare(
		`INSERT OR REPLACE INTO ${table} (at, rss_avg_bytes, rss_max_bytes, heap_avg_bytes, heap_max_bytes,
		   lag_avg_ms, lag_max_ms, fds_max, workers_max, sse_max, recon_avg_ms, recon_max_ms, probe_avg_ms, samples)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	let written = 0;
	for (const [bucket, list] of buckets) {
		if (list.length === 0) continue;
		const avg = (pick: (r: (typeof list)[number]) => number | null): number | null => {
			const vals = list.map(pick).filter((v): v is number => v !== null);
			return vals.length === 0 ? null : Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
		};
		const max = (pick: (r: (typeof list)[number]) => number | null): number | null => {
			const vals = list.map(pick).filter((v): v is number => v !== null);
			return vals.length === 0 ? null : Math.max(...vals);
		};
		upsert.run(
			bucket,
			avg((r) => r.rss_bytes),
			max((r) => r.rss_bytes),
			avg((r) => r.heap_used_bytes),
			max((r) => r.heap_used_bytes),
			avg((r) => r.event_loop_lag_ms),
			max((r) => r.event_loop_lag_ms),
			max((r) => r.fds),
			max((r) => r.workers_active),
			max((r) => r.sse_clients),
			avg((r) => r.recon_duration_ms),
			max((r) => r.recon_duration_ms),
			avg((r) => r.probe_duration_ms),
			list.length
		);
		written++;
	}
	return written;
}

/** Delete samples beyond each tier's retention. Returns deleted row counts. */
export function pruneRuntimeSamples(now: number): {
	raw: number;
	fiveMin: number;
	thirtyMin: number;
} {
	const db = getDb();
	const raw = db
		.prepare('DELETE FROM runtime_samples WHERE at < ?')
		.run(now - RUNTIME_RETENTION.rawMs);
	const fiveMin = db
		.prepare('DELETE FROM runtime_samples_5m WHERE at < ?')
		.run(now - RUNTIME_RETENTION.fiveMinMs);
	const thirtyMin = db
		.prepare('DELETE FROM runtime_samples_30m WHERE at < ?')
		.run(now - RUNTIME_RETENTION.thirtyMinMs);
	return {
		raw: Number(raw.changes ?? 0),
		fiveMin: Number(fiveMin.changes ?? 0),
		thirtyMin: Number(thirtyMin.changes ?? 0)
	};
}

export function persistRuntimeSample(sample: RuntimeSample): void {
	try {
		insertSample(sample);
	} catch {
		// A failed sample write must never disturb the sampler.
	}
}

interface RawRow {
	at: number;
	rss_bytes: number | null;
	heap_used_bytes: number | null;
	heap_total_bytes: number | null;
	external_bytes: number | null;
	array_buffers_bytes: number | null;
	event_loop_lag_ms: number | null;
	fds: number | null;
	workers_active: number | null;
	workers_spawned: number | null;
	workers_terminated: number | null;
	workers_timed_out: number | null;
	sse_clients: number | null;
	db_bytes: number | null;
	wal_bytes: number | null;
	jobs_active: number | null;
	recon_duration_ms: number | null;
	probe_duration_ms: number | null;
	notif_queue_depth: number | null;
}

function rowToSample(row: RawRow): RuntimeSample & { heapTotalBytes: number | null } {
	return {
		at: row.at,
		rssBytes: row.rss_bytes,
		heapUsedBytes: row.heap_used_bytes,
		heapTotalBytes: row.heap_total_bytes,
		externalBytes: row.external_bytes,
		arrayBuffersBytes: row.array_buffers_bytes,
		eventLoopLagMs: row.event_loop_lag_ms,
		fds: row.fds,
		workersActive: row.workers_active,
		workersSpawned: row.workers_spawned,
		workersTerminated: row.workers_terminated,
		workersTimedOut: row.workers_timed_out,
		sseClients: row.sse_clients,
		dbBytes: row.db_bytes,
		walBytes: row.wal_bytes,
		jobsActive: row.jobs_active,
		reconDurationMs: row.recon_duration_ms,
		probeDurationMs: row.probe_duration_ms,
		notifQueueDepth: row.notif_queue_depth
	};
}

/** Raw 1-minute series (used for trends over hours, capped by `since`). */
export function loadRawSamples(since: number, limit = 1600): RuntimeSample[] {
	const rows = getDb()
		.prepare(`SELECT * FROM runtime_samples WHERE at >= ? ORDER BY at DESC LIMIT ?`)
		.all(since, limit) as unknown as RawRow[];
	return rows.map(rowToSample).reverse();
}

/** Aggregated series from a specific tier (oldest first). */
export function loadAggregates(tier: '5m' | '30m', since: number, limit = 700): RuntimeAggregate[] {
	const table = tier === '5m' ? 'runtime_samples_5m' : 'runtime_samples_30m';
	const rows = getDb()
		.prepare(`SELECT * FROM ${table} WHERE at >= ? ORDER BY at DESC LIMIT ?`)
		.all(since, limit) as unknown as {
		at: number;
		rss_avg_bytes: number | null;
		rss_max_bytes: number | null;
		heap_avg_bytes: number | null;
		heap_max_bytes: number | null;
		lag_avg_ms: number | null;
		lag_max_ms: number | null;
		fds_max: number | null;
		workers_max: number | null;
		sse_max: number | null;
		recon_avg_ms: number | null;
		recon_max_ms: number | null;
		probe_avg_ms: number | null;
		samples: number;
	}[];
	return rows
		.map((r) => ({
			at: r.at,
			rssAvgBytes: r.rss_avg_bytes,
			rssMaxBytes: r.rss_max_bytes,
			heapAvgBytes: r.heap_avg_bytes,
			heapMaxBytes: r.heap_max_bytes,
			lagAvgMs: r.lag_avg_ms,
			lagMaxMs: r.lag_max_ms,
			fdsMax: r.fds_max,
			workersMax: r.workers_max,
			sseMax: r.sse_max,
			reconAvgMs: r.recon_avg_ms,
			reconMaxMs: r.recon_max_ms,
			probeAvgMs: r.probe_avg_ms,
			samples: r.samples
		}))
		.reverse();
}

/** Combined series for one metric key across tiers (UI graphs + trends). */
export function loadSeries(
	key: 'rss' | 'heap' | 'lag' | 'fds' | 'workers' | 'sse' | 'recon' | 'probe',
	sinceMs: number
): { at: number; value: number }[] {
	const now = Date.now();
	const out: { at: number; value: number }[] = [];
	const pickRaw = (s: RuntimeSample): number | null =>
		key === 'rss'
			? s.rssBytes
			: key === 'heap'
				? s.heapUsedBytes
				: key === 'lag'
					? s.eventLoopLagMs
					: key === 'fds'
						? s.fds
						: key === 'workers'
							? s.workersActive
							: key === 'sse'
								? s.sseClients
								: key === 'recon'
									? s.reconDurationMs
									: s.probeDurationMs;
	if (sinceMs <= now - RUNTIME_RETENTION.thirtyMinMs) {
		for (const agg of loadAggregates('30m', sinceMs)) {
			const value =
				key === 'rss'
					? agg.rssAvgBytes
					: key === 'heap'
						? agg.heapAvgBytes
						: key === 'lag'
							? agg.lagAvgMs
							: key === 'fds'
								? agg.fdsMax
								: key === 'workers'
									? agg.workersMax
									: key === 'sse'
										? agg.sseMax
										: key === 'recon'
											? agg.reconAvgMs
											: agg.probeAvgMs;
			if (value !== null) out.push({ at: agg.at, value });
		}
	}
	if (sinceMs <= now - RUNTIME_RETENTION.rawMs) {
		for (const agg of loadAggregates(
			'5m',
			Math.max(sinceMs, now - RUNTIME_RETENTION.thirtyMinMs)
		)) {
			const value =
				key === 'rss'
					? agg.rssAvgBytes
					: key === 'heap'
						? agg.heapAvgBytes
						: key === 'lag'
							? agg.lagAvgMs
							: key === 'fds'
								? agg.fdsMax
								: key === 'workers'
									? agg.workersMax
									: key === 'sse'
										? agg.sseMax
										: key === 'recon'
											? agg.reconAvgMs
											: agg.probeAvgMs;
			if (value !== null) out.push({ at: agg.at, value });
		}
	}
	for (const sample of loadRawSamples(Math.max(sinceMs, now - RUNTIME_RETENTION.rawMs))) {
		const value = pickRaw(sample);
		if (value !== null) out.push({ at: sample.at, value });
	}
	return out;
}

/** Bounded in-memory ring used before the first persisted minute completes. */
export class LagMonitor {
	private lastTickAt = Date.now();
	private window: number[] = [];
	private readonly windowSize: number;

	constructor(windowSize = 60) {
		this.windowSize = windowSize;
	}

	/** Call every ~1s; records the drift between expected and actual fire time. */
	tick(expectedIntervalMs = 1000): void {
		const now = Date.now();
		const lag = Math.max(0, now - this.lastTickAt - expectedIntervalMs);
		this.lastTickAt = now;
		this.window.push(lag);
		if (this.window.length > this.windowSize) this.window.shift();
	}

	averageMs(): number | null {
		if (this.window.length === 0) return null;
		return Math.round(this.window.reduce((a, b) => a + b, 0) / this.window.length);
	}

	maxMs(): number | null {
		if (this.window.length === 0) return null;
		return Math.max(...this.window);
	}
}
