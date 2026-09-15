/**
 * In-app browser destination pickup: the open client polls this endpoint and
 * raises desktop notifications for new deliveries. Requires only an
 * authenticated session; the client gates on the Notification permission the
 * user granted explicitly (§9).
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listBrowserDeliveries } from '$lib/server/notifications/store';

export const GET: RequestHandler = ({ url }) => {
	const since = Number(url.searchParams.get('since') ?? '0');
	const sinceId = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0;
	return json({ deliveries: listBrowserDeliveries(sinceId) });
};
