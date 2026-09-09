import { jsonOk } from '$lib/server/security/validation';
import { getHub } from '$lib/server/telemetry/hub';
import { incidentRepository } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

/** Full current snapshot: services, discovered list, overview, topology, incidents. */
export const GET: RequestHandler = async () => {
	const hub = getHub();
	return jsonOk({
		connection: hub.getConnection(),
		services: hub.getServices(),
		discovered: hub.getDiscovered(),
		overview: hub.overview(),
		topology: hub.topology(),
		capabilities: hub.getCapabilities().raw,
		activeIncidents: hub.getActiveIncidents(),
		recentIncidents: incidentRepository.recent(25)
	});
};
