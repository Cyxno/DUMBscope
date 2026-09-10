import { jsonError, jsonOk } from '$lib/server/security/validation';
import {
	getIntegrationStatus,
	testIntegration,
	triggerNow
} from '$lib/server/integrations/manager';
import { getIntegration } from '$lib/server/integrations/store';
import type { RequestHandler } from './$types';

/** Run the connection probe on demand (Settings "Test"). */
export const POST: RequestHandler = async ({ params }) => {
	const existing = getIntegration(params.id);
	if (!existing) return jsonError('Unknown integration', 404);
	const result = await testIntegration(existing.id);
	// A successful test proves fresh, correct configuration: poll immediately
	// instead of waiting out an old backoff (brief §2).
	if (result.ok) triggerNow(existing.id);
	const status = getIntegrationStatus(existing.id);
	return jsonOk({ ...result, status });
};
