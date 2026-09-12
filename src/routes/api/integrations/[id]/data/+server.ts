import { jsonError, jsonOk } from '$lib/server/security/validation';
import {
	getIntegrationCacheStaleAware,
	getIntegrationStatus
} from '$lib/server/integrations/manager';
import { getIntegration } from '$lib/server/integrations/store';
import type { RequestHandler } from './$types';

/** Cached poll data (whole per-integration cache) for drawer/overview. */
export const GET: RequestHandler = async ({ params }) => {
	const existing = getIntegration(params.id);
	if (!existing) return jsonError('Unknown integration', 404);
	return jsonOk({
		status: getIntegrationStatus(existing.id),
		data: getIntegrationCacheStaleAware(existing.id)
	});
};
