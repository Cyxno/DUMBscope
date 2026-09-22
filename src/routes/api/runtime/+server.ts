import { jsonOk } from '$lib/server/security/validation';
import { getHub } from '$lib/server/telemetry/hub';
import { loadSeries } from '$lib/server/runtime/store';
import { estimateTrend, projectToThreshold, type TrendPoint } from '$lib/server/runtime/trend';
import type { RequestHandler } from './$types';

/**
 * DUMBscope runtime self-monitoring (§4/§7): current sample, reconciliation
 * observability, safety-net bookkeeping and bounded history series with
 * trend estimates. All read-only; sampling cost is documented in
 * docs/RELIABILITY.md.
 */
export const GET: RequestHandler = async ({ url }) => {
	const hub = getHub();
	const hours = Math.min(720, Math.max(1, Number(url.searchParams.get('hours') ?? 26)));
	const since = Date.now() - hours * 3_600_000;

	const series: Record<
		'rss' | 'heap' | 'lag' | 'fds' | 'workers' | 'sse' | 'recon' | 'probe',
		{ at: number; value: number }[]
	> = {
		rss: loadSeries('rss', since),
		heap: loadSeries('heap', since),
		lag: loadSeries('lag', since),
		fds: loadSeries('fds', since),
		workers: loadSeries('workers', since),
		sse: loadSeries('sse', since),
		recon: loadSeries('recon', since),
		probe: loadSeries('probe', since)
	};

	/** Trend summaries: current, baseline, change, rate/hour, projection. */
	const trend = (
		key: keyof typeof series,
		unit: 'bytes' | 'workers' | 'FDs' | 'ms' | 's',
		threshold: number | null
	) => {
		const points: TrendPoint[] = series[key];
		const estimate = estimateTrend(points);
		if (!estimate || points.length === 0) return null;
		const projection =
			threshold !== null && estimate.ratePerHour > 0
				? projectToThreshold(estimate, points[points.length - 1]!.at, threshold)
				: null;
		return {
			current: points[points.length - 1]!.value,
			baseline: estimate.baseline,
			change: estimate.lastValue - estimate.firstValue,
			ratePerHour: estimate.ratePerHour,
			rateLabel: `${estimate.ratePerHour >= 0 ? '' : '−'}${unit === 'bytes' ? Math.round(Math.abs(estimate.ratePerHour) / 1024 ** 2) : Math.round(Math.abs(estimate.ratePerHour) * 10) / 10} ${unit === 'bytes' ? 'MB' : unit}/h`,
			confidence: estimate.confidence,
			samples: estimate.samples,
			/** Labelled estimate; null when confidence/data quality is insufficient. */
			projectionToThreshold: projection
				? {
						at: projection.at,
						hoursRemaining: Math.round(projection.hoursRemaining),
						threshold,
						estimate: true
					}
				: null
		};
	};

	return jsonOk({
		current: hub.getRuntimeSnapshot(),
		reconciliation: hub.getReconciliationObservability(),
		safetyNet: hub.getSafetyNetInfo(),
		series,
		trends: {
			rss: trend('rss', 'bytes', 4 * 1024 ** 3),
			workers: trend('workers', 'workers', null),
			fds: trend('fds', 'FDs', null),
			lag: trend('lag', 'ms', null),
			recon: trend('recon', 's', null)
		}
	});
};
