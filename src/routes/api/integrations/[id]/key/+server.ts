import { jsonError, jsonOk, readJson } from '$lib/server/security/validation';
import { reloadIntegration } from '$lib/server/integrations/manager';
import { clearApiKey, getIntegration, setApiKey } from '$lib/server/integrations/store';
import type { RequestHandler } from './$types';

/** Replace the stored API key. The old key is never returned. */
export const PUT: RequestHandler = async ({ params, request }) => {
	const existing = getIntegration(params.id);
	if (!existing) return jsonError('Unknown integration', 404);
	const body = (await readJson(request)) as { apiKey?: unknown } | null;
	if (!body || typeof body.apiKey !== 'string' || body.apiKey.trim().length === 0) {
		return jsonError('An API key is required');
	}
	if (body.apiKey.length > 512) return jsonError('API key too long');
	setApiKey(existing.id, body.apiKey.trim());
	reloadIntegration(existing.id);
	return jsonOk({ ok: true });
};

/** Remove the stored API key. */
export const DELETE: RequestHandler = async ({ params }) => {
	const existing = getIntegration(params.id);
	if (!existing) return jsonError('Unknown integration', 404);
	clearApiKey(existing.id);
	reloadIntegration(existing.id);
	return jsonOk({ ok: true });
};
