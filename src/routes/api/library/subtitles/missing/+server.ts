import { jsonOk } from '$lib/server/security/validation';
import { getSubtitleWanted } from '$lib/server/library/service';
import { parseListParams, pageOf } from '$lib/server/library/lists';
import { ensureIntegrationsUp } from '$lib/server/integrations/register';
import type { RequestHandler } from './$types';

/** GET /api/library/subtitles/missing — paginated subtitle gaps (§21). */
export const GET: RequestHandler = async ({ url }) => {
	ensureIntegrationsUp();
	const params = parseListParams(url, 'name');
	const lang = url.searchParams.get('lang');
	const search = (url.searchParams.get('q') ?? '').trim().toLowerCase();

	let list = getSubtitleWanted();
	if (lang && lang !== 'all') {
		list = list.filter((item) => (item.detail ?? '').toLowerCase().includes(lang.toLowerCase()));
	}
	if (search) list = list.filter((item) => item.title.toLowerCase().includes(search));

	return jsonOk(pageOf(list, params));
};
