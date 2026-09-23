import { jsonOk } from '$lib/server/security/validation';
import { loadCgroupHistory } from '$lib/server/metrics/cgroup-retention';
import { getHub } from '$lib/server/telemetry/hub';
import type { RequestHandler } from './$types';

/**
 * Observability history for charts (brief §3/§7): DUMB cgroup memory across
 * the raw/5m/30m tiers plus the in-memory thermal series (~6h at 1/min).
 * Bounded by the retention tiers — no unbounded queries.
 */
export const GET: RequestHandler = async ({ url }) => {
	const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get('hours') ?? 24)));
	const since = Date.now() - hours * 3_600_000;
	const hub = getHub();
	return jsonOk({
		hours,
		cgroup: loadCgroupHistory(since),
		thermal: hub.observabilityThermalSeries().filter((p) => p.at >= since)
	});
};
