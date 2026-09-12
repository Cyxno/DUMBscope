/**
 * Lazy per-series episodes (§17/§26/§80): quality, file info, queue state and
 * subtitle state per episode, grouped by season. One bulk Sonarr request plus
 * one Bazarr request behind TTL caches — never per-episode calls (§75/§77).
 */
import { jsonError, jsonOk } from '$lib/server/security/validation';
import { tvEpisodes } from '$lib/server/library/browse';
import { ensureIntegrationsUp } from '$lib/server/integrations/register';
import type { RequestHandler } from './$types';

const KEY_PATTERN = /^sonarr-series-\d+$/;

export const GET: RequestHandler = async ({ params }) => {
	ensureIntegrationsUp();
	if (!KEY_PATTERN.test(params.key ?? '')) {
		return jsonError('Invalid series id', 400);
	}
	try {
		const payload = await tvEpisodes(params.key!);
		if (!payload) {
			return jsonError('This item is no longer in the library.', 404);
		}
		return jsonOk(payload);
	} catch {
		// Upstream unreachable during a lazy load: report honestly, keep the
		// rest of the app working (§82). No stacktrace leaks (§129).
		return jsonError('Episode data is temporarily unavailable.', 503);
	}
};
