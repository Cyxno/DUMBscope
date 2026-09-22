import { jsonOk } from '$lib/server/security/validation';
import { getHub } from '$lib/server/telemetry/hub';
import {
	allServiceSlos,
	firstObservedAtFor,
	serviceSlo,
	WINDOWS
} from '$lib/server/reliability/slo';
import type { RequestHandler } from './$types';

/**
 * Per-service operational statistics (§12) computed from the existing
 * incident + service-event history. `availability` is the share of
 * MONITORED time without open unhealthy/stopped/degraded evidence — periods
 * before DUMBscope first observed the service and periods while DUMBscope
 * itself was down are excluded (and reported as coverage, never implied as
 * available).
 */
export const GET: RequestHandler = async ({ url }) => {
	const hub = getHub();
	const serviceKey = url.searchParams.get('service');
	const nameFor = (key: string): string =>
		hub.getServices().find((s) => s.key === key)?.name ??
		hub.getDiscovered().find((d) => d.key === key)?.name ??
		key;

	if (serviceKey) {
		const firstObserved = firstObservedAtFor(serviceKey);
		return jsonOk({
			service: WINDOWS.map((windowMs) =>
				serviceSlo(serviceKey, nameFor(serviceKey), windowMs, firstObserved)
			)
		});
	}
	return jsonOk({
		services: allServiceSlos(nameFor, firstObservedAtFor).map((slo) => ({
			...slo,
			windows: WINDOWS.map((windowMs) =>
				serviceSlo(slo.serviceKey, slo.name, windowMs, slo.firstObservedAt)
			)
		}))
	});
};
