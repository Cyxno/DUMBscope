/**
 * Retention for DUMB cgroup memory samples (migration v10 tables) — mirrors
 * the runtime/memory tiers: raw 26h, 5-minute 7d, 30-minute 30d. Aggregates
 * are idempotent per bucket (INSERT OR REPLACE), so overlapping runs never
 * duplicate rows and steady-state size is bounded and predictable.
 */
import { getDb } from '../database/db';
import { CGROUP_TUNING } from '../reliability/cgroup';

export const CGROUP_RETENTION = {
	rawMs: CGROUP_TUNING.rawRetentionMs,
	fiveMinMs: CGROUP_TUNING.fiveMinRetentionMs,
	thirtyMinMs: CGROUP_TUNING.thirtyMinRetentionMs,
	fiveMinBucketMs: CGROUP_TUNING.fiveMinBucketMs,
	thirtyMinBucketMs: CGROUP_TUNING.thirtyMinBucketMs
} as const;

/** Aggregate raw cgroup samples into a rollup tier. Returns rows written. */
export function downsampleCgroupToTier(
	table: 'cgroup_samples_5m' | 'cgroup_samples_30m',
	bucketMs: number,
	fromMs: number,
	beforeMs: number
): number {
	if (beforeMs <= fromMs) return 0;
	const db = getDb();
	const rows = db
		.prepare(
			`SELECT at, current_bytes, anon_bytes, file_bytes, kernel_bytes,
					events_high, events_max, events_oom, events_oom_kill,
					pgscan_direct, refault_file
			 FROM cgroup_samples WHERE at >= ? AND at < ? ORDER BY at ASC`
		)
		.all(fromMs, beforeMs) as {
		at: number;
		current_bytes: number | null;
		anon_bytes: number | null;
		file_bytes: number | null;
		kernel_bytes: number | null;
		events_high: number | null;
		events_max: number | null;
		events_oom: number | null;
		events_oom_kill: number | null;
		pgscan_direct: number | null;
		refault_file: number | null;
	}[];
	if (rows.length === 0) return 0;

	const buckets = new Map<
		number,
		{
			current: number[];
			anon: number[];
			file: number[];
			kernel: number[];
			highMax: number | null;
			maxMax: number | null;
			oomMax: number | null;
			oomKillMax: number | null;
			pgscanMax: number | null;
			refaultMax: number | null;
		}
	>();
	const bump = (cur: number | null, set: { cur: number | null; v: number | null }) => {
		if (set.v === null) return set.cur;
		if (set.cur === null || set.v > set.cur) return set.v;
		return set.cur;
	};
	for (const row of rows) {
		const at = Math.floor(row.at / bucketMs) * bucketMs;
		const entry = buckets.get(at) ?? {
			current: [],
			anon: [],
			file: [],
			kernel: [],
			highMax: null,
			maxMax: null,
			oomMax: null,
			oomKillMax: null,
			pgscanMax: null,
			refaultMax: null
		};
		if (row.current_bytes !== null) entry.current.push(row.current_bytes);
		if (row.anon_bytes !== null) entry.anon.push(row.anon_bytes);
		if (row.file_bytes !== null) entry.file.push(row.file_bytes);
		if (row.kernel_bytes !== null) entry.kernel.push(row.kernel_bytes);
		entry.highMax = bump(entry.highMax, { cur: null, v: row.events_high });
		entry.maxMax = bump(entry.maxMax, { cur: null, v: row.events_max });
		entry.oomMax = bump(entry.oomMax, { cur: null, v: row.events_oom });
		entry.oomKillMax = bump(entry.oomKillMax, { cur: null, v: row.events_oom_kill });
		entry.pgscanMax = bump(entry.pgscanMax, { cur: null, v: row.pgscan_direct });
		entry.refaultMax = bump(entry.refaultMax, { cur: null, v: row.refault_file });
		buckets.set(at, entry);
	}

	const avg = (values: number[]): number | null =>
		values.length === 0 ? null : Math.round(values.reduce((a, b) => a + b, 0) / values.length);
	const upsert = db.prepare(
		`INSERT OR REPLACE INTO ${table}
		 (at, current_avg_bytes, current_max_bytes, anon_avg_bytes, anon_max_bytes,
		  file_avg_bytes, file_max_bytes, kernel_avg_bytes, kernel_max_bytes,
		  events_high_max, events_max_max, oom_max, oom_kill_max,
		  pgscan_direct_max, refault_file_max, samples)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	let written = 0;
	for (const [at, e] of buckets) {
		upsert.run(
			at,
			avg(e.current),
			e.current.length > 0 ? Math.max(...e.current) : null,
			avg(e.anon),
			e.anon.length > 0 ? Math.max(...e.anon) : null,
			avg(e.file),
			e.file.length > 0 ? Math.max(...e.file) : null,
			avg(e.kernel),
			e.kernel.length > 0 ? Math.max(...e.kernel) : null,
			e.highMax,
			e.maxMax,
			e.oomMax,
			e.oomKillMax,
			e.pgscanMax,
			e.refaultMax,
			e.current.length
		);
		written++;
	}
	return written;
}

export function downsampleCgroupToFiveMinutes(now: number): number {
	return downsampleCgroupToTier(
		'cgroup_samples_5m',
		CGROUP_RETENTION.fiveMinBucketMs,
		Math.max(now - CGROUP_RETENTION.fiveMinMs, 0),
		now - CGROUP_RETENTION.fiveMinBucketMs
	);
}

export function downsampleCgroupToThirtyMinutes(now: number): number {
	return downsampleCgroupToTier(
		'cgroup_samples_30m',
		CGROUP_RETENTION.thirtyMinBucketMs,
		Math.max(now - CGROUP_RETENTION.thirtyMinMs, 0),
		now - CGROUP_RETENTION.thirtyMinBucketMs
	);
}

/** Prune every cgroup tier. Returns deleted counts. */
export function pruneCgroupSamples(now: number): {
	raw: number;
	fiveMin: number;
	thirtyMin: number;
} {
	const db = getDb();
	const raw = db
		.prepare('DELETE FROM cgroup_samples WHERE at < ?')
		.run(now - CGROUP_RETENTION.rawMs);
	const fiveMin = db
		.prepare('DELETE FROM cgroup_samples_5m WHERE at < ?')
		.run(now - CGROUP_RETENTION.fiveMinMs);
	const thirtyMin = db
		.prepare('DELETE FROM cgroup_samples_30m WHERE at < ?')
		.run(now - CGROUP_RETENTION.thirtyMinMs);
	return {
		raw: Number(raw.changes ?? 0),
		fiveMin: Number(fiveMin.changes ?? 0),
		thirtyMin: Number(thirtyMin.changes ?? 0)
	};
}

/** Chart-ready history across tiers, newest last (Observability page). */
export function loadCgroupHistory(
	sinceMs: number,
	now = Date.now()
): {
	t: number;
	currentAvg: number | null;
	currentMax: number | null;
	anonAvg: number | null;
	fileAvg: number | null;
	kernelAvg: number | null;
}[] {
	const out: {
		t: number;
		currentAvg: number | null;
		currentMax: number | null;
		anonAvg: number | null;
		fileAvg: number | null;
		kernelAvg: number | null;
	}[] = [];
	type AggregateRow = {
		at: number;
		current_avg_bytes: number | null;
		current_max_bytes: number | null;
		anon_avg_bytes: number | null;
		file_avg_bytes: number | null;
		kernel_avg_bytes: number | null;
	};
	const pushAggregates = (table: 'cgroup_samples_5m' | 'cgroup_samples_30m', from: number) => {
		try {
			const rows = getDb()
				.prepare(
					`SELECT at, current_avg_bytes, current_max_bytes, anon_avg_bytes, file_avg_bytes, kernel_avg_bytes
					 FROM ${table} WHERE at >= ? ORDER BY at ASC`
				)
				.all(from) as AggregateRow[];
			for (const r of rows) {
				out.push({
					t: r.at,
					currentAvg: r.current_avg_bytes,
					currentMax: r.current_max_bytes,
					anonAvg: r.anon_avg_bytes,
					fileAvg: r.file_avg_bytes,
					kernelAvg: r.kernel_avg_bytes
				});
			}
		} catch {
			// table not migrated yet — empty series
		}
	};

	if (sinceMs <= now - CGROUP_RETENTION.thirtyMinMs) {
		pushAggregates('cgroup_samples_30m', Math.max(sinceMs, now - CGROUP_RETENTION.thirtyMinMs));
	}
	if (sinceMs <= now - CGROUP_RETENTION.rawMs) {
		pushAggregates('cgroup_samples_5m', Math.max(sinceMs, now - CGROUP_RETENTION.thirtyMinMs));
	}
	type RawRow = {
		at: number;
		current_bytes: number | null;
		anon_bytes: number | null;
		file_bytes: number | null;
		kernel_bytes: number | null;
	};
	let rawRows: RawRow[] = [];
	try {
		rawRows = getDb()
			.prepare(
				`SELECT at, current_bytes, anon_bytes, file_bytes, kernel_bytes
				 FROM cgroup_samples WHERE at >= ? ORDER BY at ASC`
			)
			.all(Math.max(sinceMs, now - CGROUP_RETENTION.rawMs)) as RawRow[];
	} catch {
		rawRows = [];
	}
	for (const r of rawRows) {
		out.push({
			t: r.at,
			currentAvg: r.current_bytes,
			currentMax: r.current_bytes,
			anonAvg: r.anon_bytes,
			fileAvg: r.file_bytes,
			kernelAvg: r.kernel_bytes
		});
	}
	return out;
}
