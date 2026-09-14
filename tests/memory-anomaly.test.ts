/**
 * FASE C — per-process memory anomaly detection.
 *
 * Drives the tracker with a controlled clock and the real SQLite sample
 * store. Pins the rules that make the warning trustworthy (brief §31–§38):
 * not a bare threshold rule (needs baseline/growth evidence), spikes that
 * recover within the persistence window never open a finding, sustained
 * leaks escalate to critical, recovery resolves only after ~10 minutes of
 * sustained normalisation, and samples are retention-pruned.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryAnomalyTracker, type MemoryAssessment } from '../src/lib/server/reliability/memory';
import { IncidentEngine } from '../src/lib/server/incidents/engine';
import { Fingerprints } from '../src/lib/server/incidents/fingerprint';
import { getDb } from '../src/lib/server/database/db';
import type { MetricsSnapshot } from '$lib/types';

const GB = 1024 ** 3;
const MIN = 60_000;

function snapshotWith(processes: Record<string, number>): MetricsSnapshot {
	return {
		timestamp: Date.now(),
		receivedAt: Date.now(),
		cpuPercent: null,
		cpuCount: null,
		loadAvg: null,
		memory: { totalBytes: 6 * GB, usedBytes: 5 * GB, percent: 83 },
		filesystems: [],
		network: [],
		networkTotals: null,
		processes: Object.entries(processes).map(([name, rss]) => ({
			name,
			pid: 100,
			cpuPercent: null,
			memoryBytes: rss
		})),
		databaseHealth: []
	};
}

function makeTracker(
	onAssessment: (a: MemoryAssessment) => void,
	clock: () => number,
	overrides: Record<string, number> = {}
): MemoryAnomalyTracker {
	return new MemoryAnomalyTracker({
		now: clock,
		warningBytes: () => 3.5 * GB,
		criticalBytes: () => 4.5 * GB,
		onAssessment,
		tuning: { baselineMinSamples: 5, ...overrides }
	});
}

describe('MemoryAnomalyTracker rules', () => {
	let now: number;
	let clock: () => number;
	let assessments: MemoryAssessment[];
	let tracker: MemoryAnomalyTracker;

	beforeEach(() => {
		now = 1_700_000_000_000;
		clock = () => now;
		assessments = [];
		tracker = makeTracker((a) => assessments.push(a), clock);
	});

	/** Advance one minute: record the given RSS and run detection. */
	function step(processRss: Record<string, number>, hostPercent: number | null = null): void {
		now += MIN;
		tracker.onSnapshot(snapshotWith(processRss));
		tracker.evaluate(hostPercent);
	}

	it('a spike that recovers within the persistence window never opens a finding', () => {
		for (let i = 0; i < 6; i++) step({ worker: 1 * GB });
		step({ worker: 4.2 * GB }); // spike
		step({ worker: 4.2 * GB });
		for (let i = 0; i < 12; i++) step({ worker: 1 * GB }); // recovered
		expect(assessments).toHaveLength(0);
		expect(tracker.getViews().find((v) => v.process === 'worker')?.level).toBe('ok');
	});

	it('a sustained leak opens a warning, escalates to critical, and resolves with hysteresis', () => {
		// Baseline: ~1 GB for 6 minutes.
		for (let i = 0; i < 6; i++) step({ leaker: 1 * GB });
		// Jump to 3.8 GB (above the 3.5 GB bar, ≥1.75× baseline). The lagged
		// baseline keeps judging against ~1 GB; the 10-minute persistence
		// window is satisfied from the moment the relative rule arms.
		for (let i = 0; i < 17; i++) step({ leaker: 3.8 * GB });
		const warnings = assessments.filter((a) => a.level === 'warning');
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings[0]!.currentBytes).toBeCloseTo(3.8 * GB, 0);
		expect(warnings[0]!.baselineBytes).toBeCloseTo(1 * GB, 0);

		// Continued growth past the critical bar with a rising 15-min trend.
		step({ leaker: 4.7 * GB });
		const critical = assessments.filter((a) => a.level === 'critical');
		expect(critical.length).toBeGreaterThan(0);

		// Recovery to baseline: resolve only after sustained normalisation.
		for (let i = 0; i < 5; i++) step({ leaker: 1.05 * GB });
		expect(assessments.some((a) => a.level === 'ok')).toBe(false); // inside sustain window
		for (let i = 0; i < 6; i++) step({ leaker: 1.05 * GB });
		expect(assessments.some((a) => a.level === 'ok')).toBe(true);
		expect(tracker.getViews().find((v) => v.process === 'leaker')?.level).toBe('ok');
	});

	it('a high but stable process stays quiet (no bare-threshold rule)', () => {
		// 3.8 GB forever: above the warning bar, but it *is* the typical level.
		for (let i = 0; i < 30; i++) step({ steady: 3.8 * GB });
		expect(assessments).toHaveLength(0);
	});

	it('host memory pressure strengthens a critical verdict', () => {
		for (let i = 0; i < 6; i++) step({ pressured: 1 * GB });
		for (let i = 0; i < 17; i++) step({ pressured: 4.6 * GB }, 95);
		const critical = assessments.filter((a) => a.level === 'critical');
		expect(critical.length).toBeGreaterThan(0);
		expect(critical[0]!.reasons.some((r) => r.includes('host memory pressure'))).toBe(true);
	});

	it('records 1h/6h/24h features for the UI drawer', () => {
		for (let i = 0; i < 6; i++) step({ drawer: 1 * GB });
		// Simulate six hours of history at one sample per 5 minutes by writing
		// older samples directly (the tracker samples once per minute).
		const db = getDb();
		const insert = db.prepare(
			'INSERT INTO memory_samples (process, at, rss_bytes) VALUES (?, ?, ?)'
		);
		for (let h = 1; h <= 6; h++) insert.run('drawer', now - h * 60 * MIN, 0.8 * GB);
		now += MIN;
		tracker.onSnapshot(snapshotWith({ drawer: 2 * GB }));
		tracker.evaluate(null);
		const view = tracker.getViews().find((v) => v.process === 'drawer');
		expect(view).toBeDefined();
		expect(view!.currentBytes).toBe(2 * GB);
		expect(view!.delta1hBytes).toBeGreaterThan(0.5 * GB);
		expect(view!.delta6hBytes).toBeGreaterThan(1 * GB);
		expect(view!.peak24hBytes).toBeGreaterThanOrEqual(2 * GB);
		expect(view!.baselineBytes).not.toBeNull();
	});

	it('prunes samples outside the retention window', () => {
		const db = getDb();
		const insert = db.prepare(
			'INSERT INTO memory_samples (process, at, rss_bytes) VALUES (?, ?, ?)'
		);
		insert.run('prune-me', now - 27 * 60 * MIN, 1 * GB); // stale
		insert.run('prune-me', now - MIN, 1 * GB); // fresh
		const pruner = makeTracker(() => {}, clock, { pruneIntervalMs: 0 });
		now += MIN;
		pruner.onSnapshot(snapshotWith({ 'prune-me': 1 * GB })); // samples again + prunes
		const stale = db
			.prepare('SELECT COUNT(*) c FROM memory_samples WHERE process = ? AND at < ?')
			.get('prune-me', now - 26 * 60 * MIN) as { c: number };
		const fresh = db
			.prepare('SELECT COUNT(*) c FROM memory_samples WHERE process = ? AND at >= ?')
			.get('prune-me', now - 26 * 60 * MIN) as { c: number };
		expect(stale.c).toBe(0);
		expect(fresh.c).toBeGreaterThanOrEqual(2); // pre-existing fresh row + new sample
	});
});

describe('memory finding lifecycle in the incident engine', () => {
	it('opens, escalates and resolves one deduplicated finding', () => {
		const now = { value: 1_000_000_000 };
		const engine = new IncidentEngine({}, () => now.value);
		const base = {
			process: 'NzbWebDAV',
			baselineBytes: 1 * GB,
			delta1hBytes: 0.9 * GB,
			peak24hBytes: 4.2 * GB,
			hostMemPercent: 96,
			reasons: ['4.2 GB vs typical 1.0 GB'],
			samples: 40,
			lastSampleAt: now.value
		};

		engine.onMemory({ ...base, level: 'warning', currentBytes: 4.2 * GB, delta6hBytes: 1.8 * GB });
		const open = engine.getActive();
		expect(open).toHaveLength(1);
		expect(open[0]!.fingerprint).toBe(Fingerprints.memoryAnomaly('NzbWebDAV'));
		expect(open[0]!.severity).toBe('warning');
		expect(open[0]!.title).toBe('NzbWebDAV memory use is unusually high');
		expect(open[0]!.summary).toContain('4.2 GB');
		expect(open[0]!.summary).toContain('+1.8 GB over 6h');
		expect(open[0]!.summary).toContain('typical 1.0 GB');
		expect(open[0]!.summary).toContain('host memory pressure 96%');

		// Still growing: escalate to critical, recorded in the timeline.
		now.value += 60_000;
		engine.onMemory({ ...base, level: 'critical', currentBytes: 4.8 * GB, delta6hBytes: 2.4 * GB });
		const escalated = engine.getActive();
		expect(escalated).toHaveLength(1);
		expect(escalated[0]!.severity).toBe('critical');
		expect(escalated[0]!.timeline.some((t) => t.message.includes('Escalated'))).toBe(true);

		// Recovery resolves; occurrences stay as history (no flapping rows).
		now.value += 60_000;
		engine.onMemory({ ...base, level: 'ok', currentBytes: 1.1 * GB, delta6hBytes: 0.1 * GB });
		expect(engine.getActive()).toHaveLength(0);
	});
});
