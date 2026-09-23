/**
 * Per-service memory observability (Observability page, brief §2/§9).
 *
 * DUMBscope already stores per-process RSS in three tiers (raw ~26h,
 * 5-minute 7d, 30-minute 30d). This module turns those series into a
 * deterministic classification per service — deliberately *level-blind*:
 *
 *   a high but flat process is NOT a leak (elevated plateau);
 *   a leak needs sustained, confident growth across windows;
 *   a sawtooth (GC/workload resets) is its own class;
 *   too little history is reported as exactly that.
 *
 * Baseline-shift detection (§9) compares the lagged 7-day baseline
 * (days 2–7 of the 30-minute tier) against the trailing 24h and reports
 * when, and in which direction, a service re-based itself.
 */
import type { BaselineShift, ServiceMemoryClass, ServiceMemoryObservability } from '$lib/types';
import { estimateTrend, type TrendPoint } from '../runtime/trend';
import { getDb } from '../database/db';

export const SERVICE_MEMORY_TUNING = {
	/** p50/p95 ratio above which usage is considered variable (workload). */
	variabilityRatio: 1.8,
	/** A drop of ≥ this fraction from the rolling peak counts as a reset. */
	resetDropFraction: 0.25,
	/** Resets needed inside the window to call a series sawtooth. */
	sawtoothMinResets: 3,
	/** Minimum confident 24h slope (bytes/hour) that can indicate a leak. */
	leakSlopeBytesPerHour: 16 * 1024 * 1024,
	/** Minimum trend confidence before a leak classification is allowed. */
	leakMinConfidence: 0.7,
	/** Leak must also be clearly above its own trailing 24h median. */
	leakVsBaselineFactor: 1.4,
	/** Slope below this is "flat" (bytes/hour) — well under daily noise. */
	flatSlopeBytesPerHour: 8 * 1024 * 1024,
	/** Current ≥ baseline7d × this factor counts as "elevated" (not a leak). */
	elevatedFactor: 1.3,
	/** History required before any classification beyond "insufficient". */
	minHistoryMs: 6 * 60 * 60_000,
	/** Baseline shift: trailing 24h p50 ≥ lagged 7d p50 × this factor. */
	shiftUpFactor: 1.25,
	/** …or ≤ lagged 7d p50 × this factor (a service shrank). */
	shiftDownFactor: 0.75,
	/** How many 30m buckets may dip back before a shift start is rejected. */
	shiftConfirmBuckets: 4,
	/** Cap on samples pulled per tier query (bounded memory). */
	maxPoints: 2200
} as const;

export type ServiceMemoryTuning = { [K in keyof typeof SERVICE_MEMORY_TUNING]: number };

export interface MemoryPoint {
	at: number;
	bytes: number;
}

export interface ServiceMemoryFeatures {
	latest: number | null;
	latestAt: number | null;
	p50: number | null;
	p95: number | null;
	baseline24h: number | null;
	baseline7d: number | null;
	delta1h: number | null;
	delta6h: number | null;
	delta24h: number | null;
	slopeBytesPerHour: number | null;
	slopeConfidence: number | null;
	historySpanMs: number;
	resets: number;
	classification: ServiceMemoryClass;
	reasons: string[];
}

/** All samples for one process across the raw/5m/30m tiers, oldest first. */
export function loadServiceMemoryPoints(
	process: string,
	instanceKey: string,
	sinceMs: number,
	now = Date.now()
): MemoryPoint[] {
	const db = getDb();
	const out: MemoryPoint[] = [];
	const push = (rows: { at: number; bytes: number }[]) => {
		for (const r of rows) out.push({ at: r.at, bytes: r.bytes });
	};
	// 30-minute tier covers the long window (30d retention).
	push(
		db
			.prepare(
				`SELECT at, avg_bytes AS bytes FROM memory_samples_30m
				 WHERE process = ? AND (instance_key = ? OR instance_key = '') AND at >= ?
				 ORDER BY at ASC LIMIT ?`
			)
			.all(process, instanceKey, Math.max(sinceMs, now - 30 * 24 * 60 * 60_000), 2000) as {
			at: number;
			bytes: number;
		}[]
	);
	// 5-minute tier refines the trailing week.
	push(
		db
			.prepare(
				`SELECT at, avg_bytes AS bytes FROM memory_samples_5m
				 WHERE process = ? AND (instance_key = ? OR instance_key = '') AND at >= ?
				 ORDER BY at ASC LIMIT ?`
			)
			.all(
				process,
				instanceKey,
				Math.max(sinceMs, now - 7 * 24 * 60 * 60_000),
				SERVICE_MEMORY_TUNING.maxPoints
			) as { at: number; bytes: number }[]
	);
	// Raw samples are the most recent and most precise.
	push(
		db
			.prepare(
				`SELECT at, rss_bytes AS bytes FROM memory_samples
				 WHERE process = ? AND (instance_key = ? OR instance_key = '') AND at >= ?
				 ORDER BY at ASC LIMIT ?`
			)
			.all(process, instanceKey, Math.max(sinceMs, now - 26 * 60 * 60_000), 200) as {
			at: number;
			bytes: number;
		}[]
	);
	// Dedupe by timestamp (tiers overlap), keep the last write.
	const byAt = new Map<number, number>();
	for (const p of out) byAt.set(p.at, p.bytes);
	return [...byAt.entries()].map(([at, bytes]) => ({ at, bytes })).sort((a, b) => a.at - b.at);
}

/** Percentile of a numeric array (linear interpolation, like a box plot). */
export function percentile(values: number[], p: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = (sorted.length - 1) * p;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sorted[lo]!;
	return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function nearestBefore(points: MemoryPoint[], now: number, targetMs: number): number | null {
	let best: number | null = null;
	for (const p of points) {
		if (p.at <= now - targetMs) best = p.bytes;
		else break;
	}
	return best;
}

/**
 * Count downward resets: a fall of ≥ resetDropFraction from the running peak,
 * followed by recovery above (peak − drop). This is the sawtooth/GC signature.
 */
export function countResets(
	points: MemoryPoint[],
	drop: number = SERVICE_MEMORY_TUNING.resetDropFraction
): number {
	let peak = 0;
	let resets = 0;
	let armed = false;
	// Rising streak length: a sawtooth drop is preceded by a gradual ramp
	// (>= 2 consecutive rises). A single-point spike (instant jump up, instant
	// return) is workload noise, not a GC-style reset, so it never counts.
	let rises = 0;
	let prev: number | null = null;
	for (const p of points) {
		const rampBeforeDrop = rises >= 2;
		if (prev !== null) rises = p.bytes > prev ? rises + 1 : 0;
		prev = p.bytes;
		if (p.bytes > peak) peak = p.bytes;
		if (armed && p.bytes > peak * (1 - drop / 2)) {
			armed = false;
			peak = p.bytes;
		}
		if (!armed && peak > 0 && rampBeforeDrop && p.bytes <= peak * (1 - drop)) {
			resets++;
			armed = true;
			peak = p.bytes;
			rises = 0;
		}
	}
	return resets;
}

/** Derive all features used by the classifier from a point series. */
export function deriveServiceMemoryFeatures(
	points: MemoryPoint[],
	now = Date.now(),
	tuning: ServiceMemoryTuning = { ...SERVICE_MEMORY_TUNING }
): ServiceMemoryFeatures {
	const f: ServiceMemoryFeatures = {
		latest: null,
		latestAt: null,
		p50: null,
		p95: null,
		baseline24h: null,
		baseline7d: null,
		delta1h: null,
		delta6h: null,
		delta24h: null,
		slopeBytesPerHour: null,
		slopeConfidence: null,
		historySpanMs: 0,
		resets: 0,
		classification: 'insufficient-history',
		reasons: []
	};
	if (points.length === 0) return f;
	const last = points[points.length - 1]!;
	f.latest = last.bytes;
	f.latestAt = last.at;
	f.historySpanMs = last.at - points[0]!.at;

	const day = 24 * 60 * 60_000;
	const last24h = points.filter((p) => p.at >= now - day);
	const values24h = last24h.map((p) => p.bytes);
	f.p50 = percentile(values24h, 0.5);
	f.p95 = percentile(values24h, 0.95);
	f.baseline24h = f.p50;
	const lagged7d = points.filter((p) => p.at >= now - 7 * day && p.at < now - day);
	f.baseline7d =
		lagged7d.length > 0
			? percentile(
					lagged7d.map((p) => p.bytes),
					0.5
				)
			: null;

	const hourAgo = nearestBefore(points, now, 60 * 60_000);
	if (hourAgo !== null) f.delta1h = last.bytes - hourAgo;
	const sixAgo = nearestBefore(points, now, 6 * 60 * 60_000);
	if (sixAgo !== null) f.delta6h = last.bytes - sixAgo;
	const dayAgo = nearestBefore(points, now, day);
	if (dayAgo !== null) f.delta24h = last.bytes - dayAgo;

	const trend = estimateTrend(last24h.map((p): TrendPoint => ({ at: p.at, value: p.bytes })));
	if (trend) {
		f.slopeBytesPerHour = trend.ratePerHour;
		f.slopeConfidence = trend.confidence;
	}
	f.resets = countResets(last24h, tuning.resetDropFraction);
	return f;
}

/**
 * Deterministic classification. Order matters — the first matching rule wins:
 *   1. insufficient history (no statements without data)
 *   2. sawtooth/GC (regular resets dominate the shape)
 *   3. possible leak (sustained, confident growth AND clearly above baseline)
 *   4. workload-driven (high variability, no trend)
 *   5. elevated plateau (high but flat — explicitly NOT a leak)
 *   6. stable
 */
export function classifyServiceMemory(
	f: ServiceMemoryFeatures,
	tuning: ServiceMemoryTuning = { ...SERVICE_MEMORY_TUNING }
): ServiceMemoryClass {
	if (f.latest === null || f.historySpanMs < tuning.minHistoryMs || f.baseline24h === null) {
		return 'insufficient-history';
	}
	const rising =
		f.slopeBytesPerHour !== null && f.slopeBytesPerHour >= tuning.flatSlopeBytesPerHour;
	const confidentRise =
		f.slopeBytesPerHour !== null &&
		f.slopeBytesPerHour >= tuning.leakSlopeBytesPerHour &&
		f.slopeConfidence !== null &&
		f.slopeConfidence >= tuning.leakMinConfidence;
	const aboveBaseline =
		f.baseline24h !== null && f.latest >= f.baseline24h * tuning.leakVsBaselineFactor;

	if (f.resets >= tuning.sawtoothMinResets) {
		// A sawtooth that also drifts steadily upward at both ends is still a
		// leak concern: the resets are real but the floor is climbing. Only the
		// combination (rising floor AND high peak) downgrades sawtooth.
		const floorRising = f.delta24h !== null && f.delta24h >= tuning.leakSlopeBytesPerHour * 24;
		if (!floorRising) return 'sawtooth';
	}
	if (confidentRise && aboveBaseline) return 'possible-leak';
	const variable =
		f.p95 !== null && f.p50 !== null && f.p50 > 0 && f.p95 / f.p50 >= tuning.variabilityRatio;
	if (variable && !confidentRise) return 'workload-driven';
	if (
		f.baseline7d !== null &&
		f.baseline7d > 0 &&
		f.latest >= f.baseline7d * tuning.elevatedFactor &&
		!rising
	) {
		return 'elevated-plateau';
	}
	return 'stable';
}

/** Baseline shift (§9): trailing 24h p50 vs the lagged days-2..7 p50. */
export function detectBaselineShift(
	points: MemoryPoint[],
	features: ServiceMemoryFeatures,
	now = Date.now(),
	tuning: ServiceMemoryTuning = { ...SERVICE_MEMORY_TUNING }
): BaselineShift | null {
	if (features.baseline7d === null || features.baseline24h === null) return null;
	if (features.baseline7d <= 0) return null;
	const ratio = features.baseline24h / features.baseline7d;
	if (ratio < tuning.shiftUpFactor && ratio > tuning.shiftDownFactor) return null;
	const up = ratio >= tuning.shiftUpFactor;

	// Find the first 30m-scale bucket after which the level stayed on the new
	// side: scan from oldest to newest, require shiftConfirmBuckets consecutive
	// crossings so a single spike does not start a shift.
	const day = 24 * 60 * 60_000;
	const window = points.filter((p) => p.at >= now - 7 * day);
	if (window.length < tuning.shiftConfirmBuckets * 2) return null;
	const bucketMs = 30 * 60_000;
	const buckets = new Map<number, number[]>();
	for (const p of window) {
		const b = Math.floor(p.at / bucketMs) * bucketMs;
		const arr = buckets.get(b) ?? [];
		arr.push(p.bytes);
		buckets.set(b, arr);
	}
	const ordered = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
	let consecutive = 0;
	let startedAt: number | null = null;
	for (const [at, values] of ordered) {
		const avg = values.reduce((a, b) => a + b, 0) / values.length;
		const crossed = up
			? avg >= features.baseline7d * tuning.shiftUpFactor
			: avg <= features.baseline7d * tuning.shiftDownFactor;
		if (crossed) {
			if (consecutive === 0) startedAt = at;
			consecutive++;
		} else {
			consecutive = 0;
			startedAt = null;
		}
	}
	// The shift only stands if the series is still on the new side now.
	if (consecutive < tuning.shiftConfirmBuckets || startedAt === null) return null;

	// Direction: compare the most recent slope evidence with the plateau test.
	const stillRising =
		features.slopeBytesPerHour !== null &&
		features.slopeBytesPerHour >= tuning.leakSlopeBytesPerHour;
	return {
		fromBytes: Math.round(features.baseline7d),
		toBytes: Math.round(features.baseline24h),
		percent: Math.round((ratio - 1) * 100),
		startedAt,
		direction: up ? (stillRising ? 'rising' : 'plateau') : 'declining'
	};
}

/** Build the full per-service view (classification + shift) from samples. */
export function buildServiceMemoryObservability(input: {
	key: string;
	name: string;
	processName: string;
	threads: number | null;
	uptimeSeconds: number | null;
	version: string | null;
	points: MemoryPoint[];
	now?: number;
	tuning?: ServiceMemoryTuning;
}): ServiceMemoryObservability {
	const now = input.now ?? Date.now();
	const features = deriveServiceMemoryFeatures(input.points, now, input.tuning);
	const classification = classifyServiceMemory(features, input.tuning);
	const reasons = explain(features, classification, input.tuning ?? { ...SERVICE_MEMORY_TUNING });
	const shift = detectBaselineShift(input.points, features, now, input.tuning);
	return {
		key: input.key,
		name: input.name,
		processName: input.processName,
		currentBytes: features.latest,
		baseline24hBytes: features.baseline24h,
		p50Bytes: features.p50,
		p95Bytes: features.p95,
		baseline7dBytes: features.baseline7d,
		delta1hBytes: features.delta1h,
		delta6hBytes: features.delta6h,
		delta24hBytes: features.delta24h,
		slopeBytesPerHour: features.slopeBytesPerHour,
		slopeConfidence: features.slopeConfidence,
		classification,
		reasons: reasons,
		threads: input.threads,
		uptimeSeconds: input.uptimeSeconds,
		version: input.version,
		baselineShift: shift
	};
}

function explain(
	f: ServiceMemoryFeatures,
	classification: ServiceMemoryClass,
	t: ServiceMemoryTuning
): string[] {
	const gb = (b: number | null) =>
		b === null
			? '?'
			: b >= 1024 ** 3
				? `${(b / 1024 ** 3).toFixed(2)} GB`
				: `${Math.round(b / 1024 ** 2)} MB`;
	const reasons: string[] = [];
	if (classification === 'insufficient-history') {
		reasons.push(
			`history spans ${Math.round(f.historySpanMs / 60_000)} min — classification waits for ≥ ${Math.round(t.minHistoryMs / 3_600_000)}h`
		);
		return reasons;
	}
	reasons.push(`current ${gb(f.latest)} | 24h p50 ${gb(f.p50)} | p95 ${gb(f.p95)}`);
	if (f.baseline7d !== null) reasons.push(`lagged 7d baseline ${gb(f.baseline7d)}`);
	if (f.delta1h !== null)
		reasons.push(`Δ1h ${f.delta1h >= 0 ? '+' : '−'}${gb(Math.abs(f.delta1h))}`);
	if (f.delta24h !== null)
		reasons.push(`Δ24h ${f.delta24h >= 0 ? '+' : '−'}${gb(Math.abs(f.delta24h))}`);
	if (f.slopeBytesPerHour !== null) {
		reasons.push(
			`trend ${f.slopeBytesPerHour >= 0 ? '+' : '−'}${gb(Math.abs(f.slopeBytesPerHour))}/h (confidence ${(f.slopeConfidence ?? 0).toFixed(2)})`
		);
	}
	if (classification === 'sawtooth') {
		reasons.push(`${f.resets} regular resets in 24h — GC/workload cycle, not a leak`);
	}
	if (classification === 'elevated-plateau') {
		reasons.push('elevated but flat — high usage is not growth');
	}
	if (classification === 'workload-driven') {
		reasons.push('p95/p50 variability indicates workload swings');
	}
	if (classification === 'possible-leak') {
		reasons.push('sustained, confident growth above its own baseline');
	}
	return reasons;
}
