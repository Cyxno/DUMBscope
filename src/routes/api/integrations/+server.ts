import { jsonError, jsonOk, readJson } from '$lib/server/security/validation';
import {
	ensureIntegrationsStarted,
	getIntegrationStatuses,
	reloadIntegration
} from '$lib/server/integrations/manager';
import {
	getIntegration,
	listIntegrations,
	newIntegrationId,
	upsertIntegration
} from '$lib/server/integrations/store';
import { validateIntegrationUrl } from '$lib/server/integrations/url-validation';
import { isIntegrationType } from '$lib/server/integrations/types';
import { ensureIntegrationsUp } from '$lib/server/integrations/register';
import type { RequestHandler } from './$types';

/** List integration connections + live status (no secrets). */
export const GET: RequestHandler = async () => {
	ensureIntegrationsUp();
	const statuses = new Map(getIntegrationStatuses().map((s) => [s.id, s]));
	return jsonOk({
		integrations: listIntegrations().map((config) => ({
			config,
			status: statuses.get(config.id) ?? null
		}))
	});
};

/** Add or update an integration connection. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await readJson(request)) as {
		id?: unknown;
		type?: unknown;
		url?: unknown;
		enabled?: unknown;
	} | null;
	if (!body) return jsonError('Invalid request body');
	if (!isIntegrationType(body.type)) return jsonError('Unknown integration type');
	if (typeof body.url !== 'string') return jsonError('A service URL is required');

	let url: string;
	try {
		url = validateIntegrationUrl(body.url);
	} catch (err) {
		return jsonError(err instanceof Error ? err.message : 'Invalid URL');
	}

	const existing =
		typeof body.id === 'string' && body.id.length > 0 ? getIntegration(body.id) : null;
	const id = existing?.id ?? newIntegrationId(body.type as string);
	const config = upsertIntegration({
		id,
		type: body.type as Parameters<typeof upsertIntegration>[0]['type'],
		url,
		enabled: body.enabled === undefined ? (existing?.enabled ?? true) : body.enabled === true
	});
	reloadIntegration(id);
	ensureIntegrationsStarted();
	return jsonOk({ ok: true, config });
};
