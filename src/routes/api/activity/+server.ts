import { jsonOk } from '$lib/server/security/validation';
import { recentActivity } from '$lib/server/telemetry/activity';
import type { RequestHandler } from './$types';

/** Activity feed (observed facts only), newest first. */
export const GET: RequestHandler = async ({ url }) => {
	const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 60)));
	const before = url.searchParams.get('before');
	const beforeId = before !== null ? Number(before) : undefined;
	const entries = recentActivity(limit, Number.isFinite(beforeId) ? beforeId : undefined);
	return jsonOk({ entries });
};
