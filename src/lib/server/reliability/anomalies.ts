/**
 * Resource anomaly layer (§9): findings for non-memory resource signals
 * where DUMB exposes data. Deliberately evidence-gated with the same
 * persistence/hysteresis rules as every other detector, and wired into the
 * ONE incident engine (no separate pipeline).
 *
 * Implemented here:
 * - **Restart storms** — observed `service-started` transitions (the hub
 *   records them from status frames). A service restarting many times within
 *   an hour against a normal baseline of <1/day is a distinct, actionable
 *   failure class that plain restart-failure counters miss (a crash loop
 *   between probes never accumulates `failures`).
 * - **Disk-space exhaustion trend** — Theil–Sen over the in-memory host disk
 *   history ring; a confident growth trend projected to reach the warning
 *   bar inside 48h opens an early informational finding (labelled estimate).
 *
 * Layered for future signals (CPU, error-rate) as data sources allow; no
 * metrics are invented for what DUMB does not expose.
 */
import { getDb } from '../database/db';
import {
	TREND_TUNING,
	estimateTrend,
	formatRate,
	projectToThreshold,
	type TrendPoint
} from '../runtime/trend';
import type { MetricsHistoryPoint } from '$lib/types';

export const ANOMALY_TUNING = {
	/** Storm window: restarts within this horizon count together. */
	stormWindowMs: 60 * 60_000,
	/** Restarts within the window that constitute a storm. */
	stormThreshold: 3,
	/** A storm finding stays open (deduped) until the window is clean this long. */
	stormCleanMs: 2 * 60 * 60_000,
	/** Disk trend: minimum history before a trend statement. */
	diskTrendMinSamples: 30,
	/** Disk percent the projection targets. */
	diskProjectionTarget: 92,
	/** Projection must land within this horizon to be actionable. */
	diskProjectionHorizonMs: 48 * 60 * 60_000
} as const;

export interface ResourceAnomalyFinding {
	fingerprint: string;
	severity: 'warning' | 'info';
	title: string;
	summary: string;
	evidence: string;
	identity: string;
}

export interface RestartStormHit extends ResourceAnomalyFinding {
	kind: 'restart-storm';
}

/** Count observed starts per service inside the window (bounded SQL). */
function recentStarts(
	windowMs: number,
	now = Date.now()
): Map<string, { count: number; lastAt: number }> {
	const since = now - windowMs;
	const rows = getDb()
		.prepare(
			`SELECT service_key, COUNT(*) AS c, MAX(at) AS last_at
			 FROM service_events WHERE kind = 'service-started' AND service_key IS NOT NULL AND at >= ?
			 GROUP BY service_key`
		)
		.all(since) as { service_key: string; c: number; last_at: number }[];
	const out = new Map<string, { count: number; lastAt: number }>();
	for (const row of rows)
		out.set(row.service_key, { count: Number(row.c), lastAt: Number(row.last_at) });
	return out;
}

/** Detect restart storms. Returns one finding per storming service. */
export function detectRestartStorms(
	displayNameFor: (serviceKey: string) => string,
	tuning: { [K in keyof typeof ANOMALY_TUNING]: number } = { ...ANOMALY_TUNING },
	now = Date.now()
): RestartStormHit[] {
	const hits: RestartStormHit[] = [];
	try {
		for (const [serviceKey, stats] of recentStarts(tuning.stormWindowMs, now)) {
			if (stats.count < tuning.stormThreshold) continue;
			const name = displayNameFor(serviceKey);
			hits.push({
				kind: 'restart-storm',
				fingerprint: `restart-storm:${serviceKey}`,
				severity: 'warning',
				identity: serviceKey,
				title: `${name} is restarting repeatedly`,
				summary: `${stats.count} restarts in ${Math.round(tuning.stormWindowMs / 60_000)} minutes — normal baseline is under 1 per day`,
				evidence: `observed starts in the last ${Math.round(tuning.stormWindowMs / 60_000)} min: ${stats.count} · last at ${new Date(stats.lastAt).toLocaleTimeString()}`
			});
		}
	} catch {
		// Observation layer must never throw into the hub.
	}
	return hits;
}

/**
 * Disk-space exhaustion trend over the host metrics ring (≈1h of samples).
 * Returns a finding only for confident growth trends that project into the
 * horizon — the projection is explicitly an estimate.
 */
export function detectDiskTrend(
	history: MetricsHistoryPoint[],
	tuning = ANOMALY_TUNING
): ResourceAnomalyFinding | null {
	const points: TrendPoint[] = history
		.filter((p) => p.disk !== null)
		.map((p) => ({ at: p.t, value: p.disk as number }));
	if (points.length < tuning.diskTrendMinSamples) return null;
	const trend = estimateTrend(points);
	if (!trend || trend.ratePerHour <= 0) return null;
	const projection = projectToThreshold(
		trend,
		points[points.length - 1]!.at,
		tuning.diskProjectionTarget,
		{
			...TREND_TUNING,
			projectionMinConfidence: 0.85,
			projectionHorizonMs: tuning.diskProjectionHorizonMs
		}
	);
	if (!projection) return null;
	return {
		fingerprint: 'disk-trend:host',
		severity: 'info',
		identity: 'host-disk',
		title: 'Disk usage is trending towards full',
		summary: `Disk usage growing ${formatRate(trend.ratePerHour, '%/h')} — estimate: warning level (${tuning.diskProjectionTarget}%) in ~${Math.round(projection.hoursRemaining)}h`,
		evidence: `trend=${formatRate(trend.ratePerHour, '%/h')} · now ${trend.lastValue.toFixed(1)}% · ${trend.samples} samples · ${Math.round(trend.confidence * 100)}% slope agreement (estimate, not a prediction)`
	};
}
