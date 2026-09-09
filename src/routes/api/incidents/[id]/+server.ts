import { jsonError, jsonOk } from '$lib/server/security/validation';
import { incidentRepository } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
	const incident = incidentRepository.get(params.id ?? '');
	if (!incident) return jsonError('Incident not found', 404);
	return jsonOk({ incident });
};
