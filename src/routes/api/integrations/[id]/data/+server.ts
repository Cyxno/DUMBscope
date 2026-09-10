import { jsonError, jsonOk } from '$lib/server/security/validation';
import { getCachedData, getIntegrationStatus } from '$lib/server/integrations/manager';
import { getIntegration } from '$lib/server/integrations/store';
import type { RequestHandler } from './$types';

/** Cached poll data for the service drawer / overview cards. */
export const GET: RequestHandler = async ({ params }) => {
	const existing = getIntegration(params.id);
	if (!existing) return jsonError('Unknown integration', 404);
	return jsonOk({
		status: getIntegrationStatus(existing.id),
		data: {
			app: getCachedData(existing.id, 'status'),
			queue: getCachedData(existing.id, 'queue'),
			health: getCachedData(existing.id, 'health'),
			wanted: getCachedData(existing.id, 'wanted'),
			upcoming: getCachedData(existing.id, 'upcoming')
		}
	});
};
