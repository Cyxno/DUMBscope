/**
 * Subtitle browser (§45-§53): coverage header, enabled languages, profiles,
 * per-language gaps and bounded movies/series rows from the Bazarr cache.
 */
import { jsonOk } from '$lib/server/security/validation';
import { subtitlesBrowser } from '$lib/server/library/browse';
import { ensureIntegrationsUp } from '$lib/server/integrations/register';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	ensureIntegrationsUp();
	return jsonOk(subtitlesBrowser(url));
};
