/**
 * Per-service memory classification tests (observability spec §2/§9):
 * baseline derivation (p50/p95), leak vs plateau vs sawtooth determinism,
 * insufficient history and baseline-shift detection. The classifier must
 * never call a high-but-flat process a leak.
 */
import { describe, expect, it } from 'vitest';
import {
	buildServiceMemoryObservability,
	classifyServiceMemory,
	countResets,
	deriveServiceMemoryFeatures,
	detectBaselineShift,
	percentile,
	SERVICE_MEMORY_TUNING,
	type MemoryPoint
} from '../src/lib/server/reliability/service-memory';

const MB = 1024 ** 2;

function series(
	fn: (i: number, at: number) => number,
	count: number,
	stepMs = 30 * 60_000
): MemoryPoint[] {
	const out: MemoryPoint[] = [];
	const now = 1_800_000_000_000; // fixed epoch for determinism
	for (let i = count - 1; i >= 0; i--) {
		const at = now - i * stepMs;
		out.push({ at, bytes: fn(count - 1 - i, at) });
	}
	return out;
}

describe('baseline derivation', () => {
	it('computes p50/p95 over the trailing 24h', () => {
		const points = series((i) => (i + 1) * 100 * MB, 48); // 30m steps = 24h
		const f = deriveServiceMemoryFeatures(points, points[points.length - 1]!.at + 1);
		expect(f.p50).not.toBeNull();
		expect(f.p95!).toBeGreaterThan(f.p50!);
	});

	it('computes deltas 1h/6h/24h against the nearest older sample', () => {
		const points = series((i) => (1 + i * 0.01) * 1024 * MB, 72);
		const last = points[points.length - 1]!;
		const f = deriveServiceMemoryFeatures(points, last.at + 1);
		expect(f.delta1h).not.toBeNull();
		expect(f.delta1h!).toBeGreaterThan(0);
		expect(f.delta24h!).toBeGreaterThan(f.delta1h!);
	});

	it('flags insufficient history below the minimum span', () => {
		const points = series(() => 1024 * MB, 4); // ~90 min of data
		const f = deriveServiceMemoryFeatures(points, points[points.length - 1]!.at + 1);
		expect(classifyServiceMemory(f)).toBe('insufficient-history');
	});

	it('percentile interpolates', () => {
		expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
		expect(percentile([5], 0.95)).toBe(5);
	});
});

describe('leak vs plateau classification', () => {
	it('marks a high but flat process stable (never a leak)', () => {
		const points = series(() => 3 * 1024 * MB, 24 * 14); // 7d flat at 3 GiB
		const last = points[points.length - 1]!.at + 1;
		const f = deriveServiceMemoryFeatures(points, last);
		expect(classifyServiceMemory(f)).toBe('stable');
	});

	it('marks an elevated plateau after a level shift (never a leak)', () => {
		// Days 1-6 at 650 MB, day 7 at 1.3 GB, flat since.
		const points = series((i) => (i < 48 * 6 - 24 ? 650 * MB : 1300 * MB), 48 * 7);
		const last = points[points.length - 1]!.at + 1;
		const f = deriveServiceMemoryFeatures(points, last);
		expect(classifyServiceMemory(f)).toBe('elevated-plateau');
	});

	it('marks sustained confident growth above baseline as a possible leak', () => {
		// Days 1-6 flat at 700 MB, then a steady +40 MB/h climb.
		const points = series((i) => {
			return i < 48 * 6 ? 700 * MB : 700 * MB + (i - 48 * 6) * 20 * MB;
		}, 48 * 7);
		const last = points[points.length - 1]!.at + 1;
		const f = deriveServiceMemoryFeatures(points, last);
		expect(f.slopeBytesPerHour!).toBeGreaterThan(SERVICE_MEMORY_TUNING.leakSlopeBytesPerHour);
		expect(classifyServiceMemory(f)).toBe('possible-leak');
	});

	it('marks a sawtooth (GC) pattern as sawtooth, not leak', () => {
		// Repeated rise 1.0 → 1.55 GiB then a sharp reset, three times a day.
		const points = series((i) => {
			const phase = i % 16; // 16 x 30m = 8h cycle
			return phase < 12 ? (1000 + phase * 50) * MB : 1000 * MB;
		}, 48 * 7);
		const last = points[points.length - 1]!.at + 1;
		const f = deriveServiceMemoryFeatures(points, last);
		expect(f.resets).toBeGreaterThanOrEqual(SERVICE_MEMORY_TUNING.sawtoothMinResets);
		expect(classifyServiceMemory(f)).toBe('sawtooth');
	});

	it('countResets detects resets only on real drops', () => {
		const rising = series((i) => 1000 * MB + i * 5 * MB, 48);
		expect(countResets(rising)).toBe(0);
		const withDrop = [...rising, { at: rising[rising.length - 1]!.at + 1, bytes: 500 * MB }];
		expect(countResets(withDrop)).toBe(1);
	});

	it('treats high variability without trend as workload-driven', () => {
		const points = series((i) => (i % 8 === 0 ? 2600 * MB : 900 * MB), 48 * 7);
		const last = points[points.length - 1]!.at + 1;
		const f = deriveServiceMemoryFeatures(points, last);
		expect(classifyServiceMemory(f)).toBe('workload-driven');
	});
});

describe('baseline shift detection (§9)', () => {
	it('detects a stable upward baseline shift and its start', () => {
		// 6 days at 650 MB, then day 7 flat at 1.3 GB.
		const points = series((i) => (i < 48 * 6 ? 650 * MB : 1300 * MB), 48 * 7);
		const last = points[points.length - 1]!.at + 1;
		const f = deriveServiceMemoryFeatures(points, last);
		const shift = detectBaselineShift(points, f, last);
		expect(shift).not.toBeNull();
		expect(shift!.direction).toBe('plateau');
		expect(shift!.percent).toBeGreaterThanOrEqual(25);
		expect(shift!.startedAt).not.toBeNull();
	});

	it('does not report a shift while the level is still nominal', () => {
		const points = series(() => 700 * MB, 48 * 7);
		const last = points[points.length - 1]!.at + 1;
		const f = deriveServiceMemoryFeatures(points, last);
		expect(detectBaselineShift(points, f, last)).toBeNull();
	});

	it('reports "rising" while the shifted level keeps climbing', () => {
		const points = series(
			(i) => (i < 48 * 6 ? 650 * MB : 1300 * MB + (i - 48 * 6) * 30 * MB),
			48 * 7
		);
		const last = points[points.length - 1]!.at + 1;
		const f = deriveServiceMemoryFeatures(points, last);
		const shift = detectBaselineShift(points, f, last);
		expect(shift?.direction).toBe('rising');
	});
});

describe('full view build', () => {
	it('builds a view with classification, reasons and shift', () => {
		const points = series((i) => (i < 48 * 6 ? 650 * MB : 1300 * MB), 48 * 7);
		const now = points[points.length - 1]!.at + 1;
		const view = buildServiceMemoryObservability({
			key: 'sonarr',
			name: 'Sonarr',
			processName: 'sonarr instances Default',
			threads: 44,
			uptimeSeconds: 1234,
			version: '4.0.19',
			points,
			now
		});
		expect(view.classification).toBe('elevated-plateau');
		expect(view.baselineShift).not.toBeNull();
		expect(view.reasons.length).toBeGreaterThan(0);
		expect(view.uptimeSeconds).toBe(1234);
	});
});
