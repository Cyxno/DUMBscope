/** Bounded notification history (§12), newest first. */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listHistory } from '$lib/server/notifications/store';

export const GET: RequestHandler = ({ url }) => {
	const limit = Number(url.searchParams.get('limit') ?? '100');
	return json({ history: listHistory(Number.isFinite(limit) ? limit : 100) });
};
