/**
 * Per-episode subtitle states for one series (§48/§49), correlated by
 * sonarrEpisodeId — never title matching (§25/§62).
 */
import { jsonError, jsonOk } from '$lib/server/security/validation';
import { subtitlesSeries } from '$lib/server/library/browse';
import { ensureIntegrationsUp } from '$lib/server/integrations/register';
import type { RequestHandler } from './$types';

const KEY_PATTERN = /^sonarr-series-\d+$/;

export const GET: RequestHandler = async ({ params }) => {
	ensureIntegrationsUp();
	if (!KEY_PATTERN.test(params.key ?? '')) {
		return jsonError('Invalid series id', 400);
	}
	try {
		const payload = await subtitlesSeries(params.key!);
		if (!payload) {
			return jsonError('This item is no longer in the library.', 404);
		}
		return jsonOk(payload);
	} catch {
		return jsonError('Subtitle detail is temporarily unavailable.', 503);
	}
};
