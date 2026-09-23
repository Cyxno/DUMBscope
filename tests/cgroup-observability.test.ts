/**
 * Cgroup v2 memory tests (observability spec §3): parsing, the
 * applications/anon vs reclaimable-cache vs kernel distinction, the
 * high/max interpretation rules ("high memory.current alone is NOT a
 * problem"), rollups and retention.
 */
import { describe, expect, it } from 'vitest';
import {
	cgroupBreakdown,
	interpretCgroupMemory,
	parseCgroupMemory,
	readCgroupDir,
	CGROUP_TUNING
} from '../src/lib/server/reliability/cgroup';
import {
	downsampleCgroupToFiveMinutes,
	downsampleCgroupToThirtyMinutes,
	pruneCgroupSamples
} from '../src/lib/server/metrics/cgroup-retention';
import { getDb } from '../src/lib/server/database/db';

function fixture(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		'memory.current': String(6_714_466_304),
		'memory.high': String(6_979_321_856),
		'memory.max': String(8_589_934_592),
		'memory.peak': String(7_500_000_000),
		'memory.stat': [
			'anon 4812546048',
			'file 1572114432',
			'shmem 262832128',
			'slab 263187048',
			'slab_reclaimable 255901016',
			'slab_unreclaimable 7286032',
			'kernel_stack 7258112',
			'sock 65536',
			'percpu 188744',
			'pgscan 95659540',
			'pgscan_direct 92652704',
			'workingset_refault_file 11140992'
		].join('\n'),
		'memory.events': 'low 0\nhigh 475787\nmax 3232114\noom 0\noom_kill 0',
		...overrides
	};
}

describe('parse', () => {
	it('parses limits, stat and events; "max" maps to null', () => {
		const raw = parseCgroupMemory(fixture({ 'memory.max': 'max' }));
		expect(raw.high).toBe(6_979_321_856);
		expect(raw.max).toBeNull();
		expect(raw.stat['anon']).toBe(4_812_546_048);
		expect(raw.events.high).toBe(475_787);
		expect(raw.events.oomKill).toBe(0);
	});

	it('tolerates missing files (older kernels)', () => {
		const raw = parseCgroupMemory({ 'memory.current': '1000' });
		expect(raw.current).toBe(1000);
		expect(raw.high).toBeNull();
		expect(raw.stat).toEqual({});
	});

	it('readCgroupDir returns null for unreadable dirs', () => {
		expect(readCgroupDir('/nonexistent-cgroup-path-xyz')).toBeNull();
	});
});

describe('breakdown: applications vs reclaimable cache vs kernel', () => {
	it('splits anon, file-cache (file − shmem), shared and kernel', () => {
		const raw = parseCgroupMemory(fixture());
		const b = cgroupBreakdown(raw);
		expect(b.applicationsBytes).toBe(4_812_546_048);
		// shmem is charged to file by the kernel but displayed separately.
		expect(b.sharedBytes).toBe(262_832_128);
		expect(b.cacheBytes).toBe(1_572_114_432 - 262_832_128);
		expect(b.slabReclaimableBytes).toBe(255_901_016);
		expect(b.kernelBytes).toBeGreaterThan(0);
	});

	it('sums to approximately memory.current (misc remainder absorbed)', () => {
		const raw = parseCgroupMemory(fixture());
		const b = cgroupBreakdown(raw);
		const total = b.applicationsBytes + b.sharedBytes + b.cacheBytes + b.kernelBytes;
		// The kernel's named accounting may exceed or undershoot current; the
		// remainder must be small either way.
		expect(Math.abs(total - (raw.current ?? 0))).toBeLessThan(0.05 * (raw.current ?? 1));
	});
});

describe('interpretation: high/max rules', () => {
	const rawAt = (
		events: { high: number; max: number; oom?: number },
		pgscan: number
	): ReturnType<typeof parseCgroupMemory> =>
		parseCgroupMemory(
			fixture({
				'memory.events': `low 0\nhigh ${events.high}\nmax ${events.max}\noom ${events.oom ?? 0}\noom_kill 0`,
				'memory.stat': `anon 1000\nfile 500\nshmem 0\npgscan_direct ${pgscan}\nworkingset_refault_file 10`
			})
		);

	it('high memory.current alone is not a problem', () => {
		const raw = rawAt({ high: 100, max: 5 }, 10);
		const i = interpretCgroupMemory(raw, raw);
		expect(i.softReclaimActive).toBe(false);
		expect(i.hardLimitHit).toBe(false);
		expect(i.pressure).toBe(false);
	});

	it('flags soft reclaim when memory.events.high moves', () => {
		const prev = rawAt({ high: 100, max: 5 }, 10);
		const now = rawAt({ high: 160, max: 5 }, 10);
		const i = interpretCgroupMemory(now, prev);
		expect(i.softReclaimActive).toBe(true);
		expect(i.hardLimitHit).toBe(false);
	});

	it('flags hard-limit hits when memory.events.max moves', () => {
		const prev = rawAt({ high: 100, max: 5 }, 10);
		const now = rawAt({ high: 160, max: 3200 }, 10);
		const i = interpretCgroupMemory(now, prev);
		expect(i.hardLimitHit).toBe(true);
	});

	it('flags pressure on heavy direct reclaim under the soft limit', () => {
		const prev = rawAt({ high: 100, max: 5 }, 1_000);
		const now = rawAt({ high: 105, max: 5 }, 5_000);
		const i = interpretCgroupMemory(now, prev);
		expect(i.softReclaimActive).toBe(true);
		expect(i.pressure).toBe(true);
	});

	it('does not call reclaim pressure when no limits are involved', () => {
		const prev = rawAt({ high: 100, max: 5 }, 1_000);
		const now = rawAt({ high: 100, max: 5 }, 50_000);
		const i = interpretCgroupMemory(now, prev);
		expect(i.pressure).toBe(false);
	});

	it('reports OOM movement', () => {
		const prev = rawAt({ high: 1, max: 1, oom: 0 }, 0);
		const now = rawAt({ high: 1, max: 1, oom: 2 }, 0);
		const i = interpretCgroupMemory(now, prev);
		expect(i.oom).toBe(true);
	});

	it('treats usage at the hard limit as at-limit context', () => {
		const raw = parseCgroupMemory(
			fixture({
				'memory.current': String(Math.floor(8_589_934_592 * CGROUP_TUNING.hardLimitFraction)),
				'memory.events': 'low 0\nhigh 5\nmax 5\noom 0\noom_kill 0',
				'memory.stat': 'anon 1000\nfile 500'
			})
		);
		const i = interpretCgroupMemory(raw, raw);
		// At the limit without movement: not "hit" (rate-based), but a fresh
		// hit event would flag it — the fraction only feeds the pressure rule.
		expect(i.hardLimitHit).toBe(false);
	});
});

describe('rollups and retention', () => {
	it('downsamples raw rows into 5m/30m tiers idempotently and prunes', () => {
		const db = getDb();
		const now = Date.now();
		const ins = db.prepare(
			`INSERT OR REPLACE INTO cgroup_samples
			 (at, current_bytes, high_bytes, max_bytes, anon_bytes, file_bytes, shmem_bytes,
			  slab_bytes, slab_reclaimable_bytes, kernel_bytes,
			  events_high, events_max, events_oom, events_oom_kill, pgscan, pgscan_direct, refault_file)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		);
		// Three raw rows inside one 5-minute bucket, older than the 30-minute
		// rollup cutoff so both tiers pick them up + one ancient row.
		const base = Math.floor(now / 300_000) * 300_000 - 45 * 60_000;
		ins.run(base + 1_000, 100, 200, 300, 40, 30, 5, 10, 8, 12, 1, 1, 0, 0, 5, 5, 5);
		ins.run(base + 2_000, 200, 200, 300, 60, 30, 5, 10, 8, 12, 2, 1, 0, 0, 5, 9, 7);
		ins.run(base + 3_000, 300, 200, 300, 80, 30, 5, 10, 8, 12, 3, 1, 0, 0, 5, 12, 9);
		ins.run(base - 40 * 24 * 3600_000, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0);

		const written5 = downsampleCgroupToFiveMinutes(now);
		const written30 = downsampleCgroupToThirtyMinutes(now);
		expect(written5).toBeGreaterThanOrEqual(1);
		expect(written30).toBeGreaterThanOrEqual(1);

		const bucketAt = Math.floor(base / 300_000) * 300_000;
		const bucket = db
			.prepare('SELECT * FROM cgroup_samples_5m WHERE at = ?')
			.get(bucketAt) as Record<string, number>;
		expect(bucket.current_avg_bytes).toBe(200);
		expect(bucket.current_max_bytes).toBe(300);
		expect(bucket.anon_avg_bytes).toBe(60);
		expect(bucket.events_high_max).toBe(3);
		expect(bucket.pgscan_direct_max).toBe(12);
		expect(bucket.samples).toBe(3);

		// Idempotent: a second run does not change values or row counts.
		downsampleCgroupToFiveMinutes(now);
		const rows = db
			.prepare('SELECT COUNT(*) c FROM cgroup_samples_5m WHERE at = ?')
			.get(bucketAt) as { c: number };
		expect(rows.c).toBe(1);

		// Prune drops the ancient raw row.
		const pruned = pruneCgroupSamples(now);
		expect(pruned.raw).toBeGreaterThanOrEqual(1);
	});
});
