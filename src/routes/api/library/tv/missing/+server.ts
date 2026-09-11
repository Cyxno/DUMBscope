import { jsonOk } from '$lib/server/security/validation';
import { getMissingItems } from '$lib/server/library/service';
import { parseListParams, sortAndFilterMissing, pageOf } from '$lib/server/library/lists';
import { ensureIntegrationsUp } from '$lib/server/integrations/register';
import type { RequestHandler } from './$types';

/** GET /api/library/tv/missing — paginated missing episodes. */
export const GET: RequestHandler = async ({ url }) => {
	ensureIntegrationsUp();
	const params = parseListParams(url);
	const all = sortAndFilterMissing(
		getMissingItems().filter((item) => item.kind === 'episode'),
		params.sort,
		params.filter
	);
	return jsonOk(pageOf(all, params));
};
