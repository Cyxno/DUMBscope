/**
 * TV library browser list (§5/§27/§28/§29): bounded, server-side filtered,
 * sorted and searched over the cached Sonarr inventory. Never triggers an
 * upstream request — browsers read DUMBscope state (§79).
 */
import { jsonOk } from '$lib/server/security/validation';
import { tvList } from '$lib/server/library/browse';
import { ensureIntegrationsUp } from '$lib/server/integrations/register';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	ensureIntegrationsUp();
	return jsonOk(tvList(url));
};
