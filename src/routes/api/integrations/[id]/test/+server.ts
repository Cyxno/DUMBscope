import { jsonError, jsonOk } from '$lib/server/security/validation';
import { getIntegrationStatus, testIntegration } from '$lib/server/integrations/manager';
import { getIntegration } from '$lib/server/integrations/store';
import type { RequestHandler } from './$types';

/** Run the connection probe on demand (Settings "Test"). */
export const POST: RequestHandler = async ({ params }) => {
	const existing = getIntegration(params.id);
	if (!existing) return jsonError('Unknown integration', 404);
	const result = await testIntegration(existing.id);
	const status = getIntegrationStatus(existing.id);
	return jsonOk({ ...result, status });
};
