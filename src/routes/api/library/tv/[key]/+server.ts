/**
 * Series detail (§11/§12/§13): metadata + season list from the cached
 * inventory. Episodes load lazily via /episodes (§80).
 */
import { jsonError, jsonOk } from '$lib/server/security/validation';
import { tvDetail } from '$lib/server/library/browse';
import { ensureIntegrationsUp } from '$lib/server/integrations/register';
import type { RequestHandler } from './$types';

const KEY_PATTERN = /^sonarr-series-\d+$/;

export const GET: RequestHandler = async ({ params }) => {
	ensureIntegrationsUp();
	if (!KEY_PATTERN.test(params.key ?? '')) {
		return jsonError('Invalid series id', 400);
	}
	const detail = tvDetail(params.key!);
	if (!detail) {
		return jsonError('This item is no longer in the library.', 404);
	}
	return jsonOk(detail);
};
