import { jsonError, jsonOk } from '$lib/server/security/validation';
import { getActionsManager } from '$lib/server/actions/manager';
import type { RequestHandler } from './$types';

/** One Safe Action's current state — the UI polls this a bounded number of
 *  times after executing; the server's own follow-up is bounded too (§11/§13). */
export const GET: RequestHandler = async ({ params }) => {
	const action = getActionsManager().get(params.id);
	if (!action) return jsonError('Unknown action', 404);
	return jsonOk(action);
};
