/**
 * Movie library browser list (§33-§36): one bulk Radarr request feeds the
 * cached inventory; this endpoint filters/sorts/paginates server-side (§76).
 */
import { jsonOk } from '$lib/server/security/validation';
import { moviesList } from '$lib/server/library/browse';
import { ensureIntegrationsUp } from '$lib/server/integrations/register';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	ensureIntegrationsUp();
	return jsonOk(moviesList(url));
};
