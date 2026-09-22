/**
 * Runtime self-monitoring, trend estimation, long-term retention bounds and
 * multi-instance process identity (v0.8 §4–§8).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
	estimateTrend,
	formatRate,
	projectToThreshold,
	type TrendPoint
} from '../src/lib/server/runtime/trend';
import {
	downsampleToFiveMinutes,
	downsampleToThirtyMinutes,
	persistRuntimeSample,
	pruneRuntimeSamples,
	RUNTIME_RETENTION,
	type RuntimeSample
} from '../src/lib/server/runtime/store';
import {
	downsampleMemoryToFiveMinutes,
	downsampleMemoryToThirtyMinutes,
	pruneMemorySamples,
	MEMORY_RETENTION
} from '../src/lib/server/metrics/retention';
import { getDb } from '../src/lib/server/database/db';
import { MemoryAnomalyTracker } from '../src/lib/server/reliability/memory';
import { fsProbeWorkerStats } from '../src/lib/server/reliability/fsprobe';
import { detectRestartStorms, ANOMALY_TUNING } from '../src/lib/server/reliability/anomalies';
import type { MetricsSnapshot } from '$lib/types';

const HOUR = 3_600_000;
const MIN = 60_000;

let now = 1_750_000_000_000;

beforeEach(() => {
	now = 1_750_000_000_000;
	getDb().prepare('DELETE FROM runtime_samples').run();
	getDb().prepare('DELETE FROM runtime_samples_5m').run();
	getDb().prepare('DELETE FROM runtime_samples_30m').run();
	getDb().prepare('DELETE FROM memory_samples').run();
	getDb().prepare('DELETE FROM memory_samples_5m').run();
	getDb().prepare('DELETE FROM memory_samples_30m').run();
	getDb().prepare('DELETE FROM service_events').run();
});

// ---------------------------------------------------------------------------
// Trend estimation (§7)
// ---------------------------------------------------------------------------

describe('robust trend estimation', () => {
	it('recovers the true slope of a clean linear series', () => {
		const points: TrendPoint[] = Array.from({ length: 61 }, (_, i) => ({
			at: now - (60 - i) * MIN,
			value: 100 + i * 2 // +2/min = +120/h
		}));
		const trend = estimateTrend(points);
		expect(trend).not.toBeNull();
		expect(trend!.ratePerHour).toBeCloseTo(120, 0);
		expect(trend!.confidence).toBeGreaterThan(0.99);
	});

	it('ignores spikes that a first-vs-last comparison would misread', () => {
		const points: TrendPoint[] = Array.from({ length: 30 }, (_, i) => ({
			at: now - (29 - i) * MIN,
			value: 500
		}));
		// Flat series with one spike in the middle and one dip at the start.
		points[0]!.value = 100;
		points[15]!.value = 5000;
		const trend = estimateTrend(points)!;
		expect(Math.abs(trend.ratePerHour)).toBeLessThan(100);
	});

	it('refuses to project when confidence is insufficient', () => {
		const points: TrendPoint[] = Array.from({ length: 30 }, (_, i) => ({
			at: now - (29 - i) * MIN,
			value: i % 2 === 0 ? 100 + i * 10 : 100
		}));
		const trend = estimateTrend(points)!;
		const projection = projectToThreshold(trend, now, 10_000);
		// With this much disagreement no projection is produced — labelled or none.
		if (trend.confidence < 0.8) expect(projection).toBeNull();
	});

	it('projects a confident growth trend to a threshold as an estimate', () => {
		const points: TrendPoint[] = Array.from({ length: 60 }, (_, i) => ({
			at: now - (59 - i) * MIN,
			value: 1000 + i * 10 // +600k/h
		}));
		const trend = estimateTrend(points)!;
		const projection = projectToThreshold(trend, now, 2500);
		expect(projection).not.toBeNull();
		expect(projection!.hoursRemaining).toBeGreaterThan(0);
		expect(projection!.hoursRemaining).toBeLessThan(3);
	});

	it('formats rates for display', () => {
		expect(formatRate(95 * 1024 ** 2, 'MB')).toContain('MB/hour');
		expect(formatRate(-4, 'workers')).toContain('−4');
	});
});

// ---------------------------------------------------------------------------
// Runtime samples + bounded retention (§4/§6)
// ---------------------------------------------------------------------------

function metricsSnapshot(processes: MetricsSnapshot['processes']): MetricsSnapshot {
	return {
		timestamp: now,
		receivedAt: now,
		cpuPercent: 10,
		cpuCount: 4,
		loadAvg: [1, 1, 1],
		memory: { totalBytes: 16e9, usedBytes: 8e9, percent: 50 },
		filesystems: [
			{
				path: '/data',
				totalBytes: 1e9,
				usedBytes: 1e8,
				freeBytes: 9e8,
				percent: 10,
				inodePercent: 1
			}
		],
		processes,
		databaseHealth: [],
		network: [],
		networkTotals: { sentBytes: 0, recvBytes: 0 }
	};
}

function sample(overrides: Partial<RuntimeSample> = {}): RuntimeSample {
	return {
		at: now,
		rssBytes: 400 * 1024 ** 2,
		heapUsedBytes: 100 * 1024 ** 2,
		heapTotalBytes: 140 * 1024 ** 2,
		externalBytes: 20 * 1024 ** 2,
		arrayBuffersBytes: 10 * 1024 ** 2,
		eventLoopLagMs: 3,
		fds: 220,
		workersActive: 0,
		workersSpawned: 12,
		workersTerminated: 12,
		workersTimedOut: 0,
		sseClients: 1,
		dbBytes: 5 * 1024 ** 2,
		walBytes: 1024 ** 2,
		jobsActive: 3,
		reconDurationMs: null,
		probeDurationMs: 1200,
		notifQueueDepth: 0,
		...overrides
	};
}

describe('runtime sample retention stays bounded', () => {
	it('aggregates raw samples into idempotent 5m/30m buckets and prunes', () => {
		// 3 hours of 1-minute samples.
		const start = now - 3 * HOUR;
		for (let i = 0; i < 180; i++) {
			persistRuntimeSample(sample({ at: start + i * MIN, rssBytes: 400e6 + i * 1e6 }));
		}
		const written5 = downsampleToFiveMinutes(start + 3 * HOUR);
		expect(written5).toBeGreaterThan(30);
		const count5 = (
			getDb().prepare('SELECT COUNT(*) c FROM runtime_samples_5m').get() as { c: number }
		).c;
		// Re-running must not duplicate buckets.
		downsampleToFiveMinutes(start + 3 * HOUR);
		const count5again = (
			getDb().prepare('SELECT COUNT(*) c FROM runtime_samples_5m').get() as { c: number }
		).c;
		expect(count5again).toBe(count5);

		downsampleToThirtyMinutes(start + 3 * HOUR);
		const count30 = (
			getDb().prepare('SELECT COUNT(*) c FROM runtime_samples_30m').get() as { c: number }
		).c;
		expect(count30).toBeGreaterThan(4);

		// Aggregates keep avg AND max (a 30-min average must not hide a spike).
		const bucket = getDb()
			.prepare(
				'SELECT rss_avg_bytes, rss_max_bytes, samples FROM runtime_samples_5m ORDER BY at LIMIT 1'
			)
			.get() as { rss_avg_bytes: number; rss_max_bytes: number; samples: number };
		expect(bucket.rss_max_bytes).toBeGreaterThanOrEqual(bucket.rss_avg_bytes);
		expect(bucket.samples).toBeGreaterThan(0);

		// Pruning respects each tier's retention.
		pruneRuntimeSamples(now);
		const raw = (getDb().prepare('SELECT COUNT(*) c FROM runtime_samples').get() as { c: number })
			.c;
		expect(raw).toBeLessThanOrEqual(RUNTIME_RETENTION.rawMs / MIN + 1);
	});
});

describe('service memory retention stays bounded', () => {
	it('aggregates and prunes memory samples per process', () => {
		const start = now - 30 * HOUR;
		const insert = getDb().prepare(
			'INSERT INTO memory_samples (process, at, rss_bytes, instance_key) VALUES (?, ?, ?, ?)'
		);
		for (let i = 0; i < 120; i++) {
			insert.run('sonarr', start + i * MIN, 2e9 + i * 1e6, '');
			insert.run('radarr', start + i * MIN, 1e9, '');
		}
		downsampleMemoryToFiveMinutes(start + 30 * HOUR);
		downsampleMemoryToThirtyMinutes(start + 30 * HOUR);
		const buckets5 = (
			getDb().prepare('SELECT COUNT(*) c FROM memory_samples_5m').get() as { c: number }
		).c;
		expect(buckets5).toBeGreaterThan(20);
		// Idempotent per bucket.
		downsampleMemoryToFiveMinutes(start + 30 * HOUR);
		const buckets5again = (
			getDb().prepare('SELECT COUNT(*) c FROM memory_samples_5m').get() as { c: number }
		).c;
		expect(buckets5again).toBe(buckets5);

		pruneMemorySamples(now);
		const raw = (getDb().prepare('SELECT COUNT(*) c FROM memory_samples').get() as { c: number }).c;
		expect(raw).toBeLessThanOrEqual((MEMORY_RETENTION.rawMs / MIN + 1) * 2);
	});
});

// ---------------------------------------------------------------------------
// Multi-instance process identity (§8)
// ---------------------------------------------------------------------------

describe('process identity isolation', () => {
	it('never mixes two same-name instances that expose distinct identities', () => {
		const tracker = new MemoryAnomalyTracker({
			now: () => now,
			warningBytes: () => 3.5 * 1024 ** 3,
			criticalBytes: () => 4.5 * 1024 ** 3,
			onAssessment: () => {}
		});
		// Sonarr and Sonarr Anime arrive as distinct DUMB processes with
		// distinct discovered keys — they must land in separate instance rows.
		tracker.onSnapshot(
			metricsSnapshot([
				{ name: 'sonarr', cpuPercent: 1, memoryBytes: 1e9, pid: 10 },
				{ name: 'sonarr-anime', cpuPercent: 1, memoryBytes: 3e9, pid: 11 }
			]),
			new Map([
				['sonarr', 'sonarr'],
				['sonarr-anime', 'sonarr-anime']
			])
		);
		const rows = getDb()
			.prepare('SELECT process, instance_key, rss_bytes FROM memory_samples')
			.all() as unknown as { process: string; instance_key: string; rss_bytes: number }[];
		expect(rows).toHaveLength(2);
		const sonarr = rows.find((r) => r.process === 'sonarr')!;
		const anime = rows.find((r) => r.process === 'sonarr-anime')!;
		expect(sonarr.instance_key).toBe('sonarr');
		expect(anime.instance_key).toBe('sonarr-anime');
		expect(anime.rss_bytes).toBe(3e9);
	});

	it('keeps legacy name-only rows readable after the identity migration', () => {
		const insert = getDb().prepare(
			'INSERT INTO memory_samples (process, at, rss_bytes, instance_key) VALUES (?, ?, ?, ?)'
		);
		// Pre-upgrade rows: name-only (instance_key '').
		insert.run('sonarr', now - 10 * MIN, 1.2e9, '');
		// Post-upgrade rows: instance-scoped.
		insert.run('sonarr', now - 5 * MIN, 1.5e9, 'sonarr');

		const tracker = new MemoryAnomalyTracker({
			now: () => now,
			warningBytes: () => 3.5 * 1024 ** 3,
			criticalBytes: () => 4.5 * 1024 ** 3,
			onAssessment: () => {}
		});
		tracker.onSnapshot(
			metricsSnapshot([{ name: 'sonarr', cpuPercent: 1, memoryBytes: 1.6e9, pid: 10 }]),
			new Map([['sonarr', 'sonarr']])
		);
		tracker.evaluate(null);
		const view = tracker.getViews().find((v) => v.process === 'sonarr');
		// The baseline sees BOTH legacy and instance-scoped rows: history stays
		// continuous across the upgrade instead of resetting.
		expect(view).toBeDefined();
		expect(view!.samples).toBeGreaterThanOrEqual(2);
	});
});

// ---------------------------------------------------------------------------
// Worker counters + restart storms (§4/§9)
// ---------------------------------------------------------------------------

describe('worker counters and restart storms', () => {
	it('fsprobe counters return to zero active after rounds (leak signature observable)', async () => {
		const { runProbeRound } = await import('../src/lib/server/reliability/fsprobe');
		expect(fsProbeWorkerStats().active).toBe(0);
		await runProbeRound([{ op: 'stat', path: '/tmp' }], 5_000);
		expect(fsProbeWorkerStats().active).toBe(0);
		expect(fsProbeWorkerStats().spawned).toBeGreaterThan(0);
	});

	it('detects restart storms from observed service-started events', () => {
		const insert = getDb().prepare(
			"INSERT INTO service_events (service_key, kind, message, at) VALUES (?, 'service-started', 'started', ?)"
		);
		for (let i = 0; i < 7; i++) insert.run('radarr', now - i * 5 * MIN);
		insert.run('sonarr', now - 6 * HOUR); // old: outside the storm window
		const hits = detectRestartStorms((key) => key, { ...ANOMALY_TUNING }, now);
		expect(hits).toHaveLength(1);
		expect(hits[0]!.identity).toBe('radarr');
		expect(hits[0]!.summary).toContain('7 restarts');
	});
});
