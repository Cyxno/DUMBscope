/**
 * Robust trend estimation for metric series (§7).
 *
 * Method: Theil–Sen slope — the median of all pairwise slopes. Unlike a
 * first-vs-last comparison it tolerates spikes and plateaus, and unlike a
 * least-squares fit a handful of outliers cannot drag it. Confidence is the
 * share of pairwise slopes agreeing with the median's sign; projections are
 * only produced when that agreement and the sample count are high enough, and
 * are always labelled as estimates.
 */

export interface TrendPoint {
	/** Epoch ms. */
	at: number;
	value: number;
}

export interface TrendEstimate {
	/** Robust slope in value per hour (positive = growing). */
	ratePerHour: number;
	/** 0..1 — share of pairwise slopes agreeing with the median sign. */
	confidence: number;
	/** Number of samples used (after capping). */
	samples: number;
	/** First→last value across the analysed window. */
	firstValue: number;
	lastValue: number;
	/** Window actually covered by the analysed samples (ms). */
	spanMs: number;
	/** Median of the middle 50% of values — a cheap robust "baseline" view. */
	baseline: number;
}

/** Projection of the current trend onto a threshold, when trustworthy. */
export interface TrendProjection {
	/** Epoch ms at which the trend is estimated to reach the threshold. */
	at: number;
	/** Hours until the threshold from the last sample (rounded by the caller). */
	hoursRemaining: number;
	threshold: number;
}

export const TREND_TUNING = {
	/** Maximum samples analysed per trend (older points are dropped). */
	maxSamples: 240,
	/** Minimum samples before any trend statement is made. */
	minSamples: 6,
	/** Minimum confidence (sign agreement) for a projection to be produced. */
	projectionMinConfidence: 0.8,
	/** Projections never reach further than this (ms); beyond that it is noise. */
	projectionHorizonMs: 72 * 60 * 60_000
} as const;

/** Widened tuning type (callers may raise confidence/horizon requirements). */
export type TrendTuning = { [K in keyof typeof TREND_TUNING]: number };

/**
 * Theil–Sen estimate over a bounded series. `cap` keeps the computation
 * O(min(n, cap)²) — with the 240-point cap that is well under 30k pairs.
 */
export function estimateTrend(
	points: TrendPoint[],
	tuning: TrendTuning = { ...TREND_TUNING }
): TrendEstimate | null {
	const trimmed = points
		.filter((p) => Number.isFinite(p.value) && Number.isFinite(p.at))
		.slice(-tuning.maxSamples);
	if (trimmed.length < tuning.minSamples) return null;

	const slopes: number[] = [];
	for (let i = 0; i < trimmed.length; i++) {
		for (let j = i + 1; j < trimmed.length; j++) {
			const dt = (trimmed[j]!.at - trimmed[i]!.at) / 3_600_000;
			if (dt <= 0) continue;
			slopes.push((trimmed[j]!.value - trimmed[i]!.value) / dt);
		}
	}
	if (slopes.length === 0) return null;

	const ratePerHour = median(slopes);
	const agreeing = slopes.filter((s) => (ratePerHour >= 0 ? s >= 0 : s <= 0)).length;
	const confidence = slopes.length > 0 ? agreeing / slopes.length : 0;

	const values = trimmed.map((p) => p.value);
	return {
		ratePerHour,
		confidence,
		samples: trimmed.length,
		firstValue: values[0]!,
		lastValue: values[values.length - 1]!,
		spanMs: trimmed[trimmed.length - 1]!.at - trimmed[0]!.at,
		baseline: median(values)
	};
}

/**
 * Project when a growing trend reaches `threshold`. Returns null when the
 * trend is not growing, the slope is not confident enough, or the projection
 * would land beyond the horizon — no estimate is better than a made-up one.
 */
export function projectToThreshold(
	trend: TrendEstimate,
	lastAt: number,
	threshold: number,
	tuning: TrendTuning = { ...TREND_TUNING }
): TrendProjection | null {
	if (trend.ratePerHour <= 0) return null;
	if (trend.confidence < tuning.projectionMinConfidence) return null;
	if (trend.lastValue >= threshold) return null;
	const hours = (threshold - trend.lastValue) / trend.ratePerHour;
	if (!Number.isFinite(hours) || hours <= 0) return null;
	const ms = hours * 3_600_000;
	if (ms > tuning.projectionHorizonMs) return null;
	return { at: lastAt + ms, hoursRemaining: hours, threshold };
}

export function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Human rate formatter: "95 MB/hour", "12 workers/hour", "31 FDs/hour". */
export function formatRate(valuePerHour: number, unit: string): string {
	const abs = Math.abs(valuePerHour);
	const rounded = abs >= 10 ? Math.round(abs) : Math.round(abs * 10) / 10;
	return `${valuePerHour < 0 ? '−' : ''}${rounded} ${unit}/hour`;
}
