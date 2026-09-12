/**
 * Movie detail (§37-§44): file/quality state, queue correlation, subtitle
 * state from Bazarr and bounded recent history. Read-only, lazy on click.
 */
import { jsonError, jsonOk } from '$lib/server/security/validation';
import { movieDetail } from '$lib/server/library/browse';
import { ensureIntegrationsUp } from '$lib/server/integrations/register';
import type { RequestHandler } from './$types';

const KEY_PATTERN = /^radarr-movie-\d+$/;

export const GET: RequestHandler = async ({ params }) => {
	ensureIntegrationsUp();
	if (!KEY_PATTERN.test(params.key ?? '')) {
		return jsonError('Invalid movie id', 400);
	}
	try {
		const detail = await movieDetail(params.key!);
		if (!detail) {
			return jsonError('This item is no longer in the library.', 404);
		}
		return jsonOk(detail);
	} catch {
		return jsonError('Movie detail is temporarily unavailable.', 503);
	}
};
