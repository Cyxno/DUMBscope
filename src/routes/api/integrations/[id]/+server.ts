import { jsonError, jsonOk, readJson } from '$lib/server/security/validation';
import { reloadIntegration } from '$lib/server/integrations/manager';
import {
	deleteIntegration,
	getIntegration,
	upsertIntegration
} from '$lib/server/integrations/store';
import { validateIntegrationUrl } from '$lib/server/integrations/url-validation';
import type { RequestHandler } from './$types';

function configOr404(id: string) {
	return getIntegration(id);
}

/** Update URL/enabled for one integration. */
export const PUT: RequestHandler = async ({ params, request }) => {
	const existing = configOr404(params.id);
	if (!existing) return jsonError('Unknown integration', 404);
	const body = (await readJson(request)) as {
		url?: unknown;
		enabled?: unknown;
	} | null;
	if (!body || typeof body.url !== 'string') return jsonError('A service URL is required');

	let url: string;
	try {
		url = validateIntegrationUrl(body.url);
	} catch (err) {
		return jsonError(err instanceof Error ? err.message : 'Invalid URL');
	}

	const config = upsertIntegration({
		id: existing.id,
		type: existing.type,
		url,
		enabled: body.enabled === undefined ? existing.enabled : body.enabled === true
	});
	reloadIntegration(existing.id);
	return jsonOk({ ok: true, config });
};

/** Remove the integration and its pollers. */
export const DELETE: RequestHandler = async ({ params }) => {
	const existing = configOr404(params.id);
	if (!existing) return jsonError('Unknown integration', 404);
	deleteIntegration(existing.id);
	reloadIntegration(existing.id);
	return jsonOk({ ok: true });
};
