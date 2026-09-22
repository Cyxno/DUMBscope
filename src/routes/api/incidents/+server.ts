import { jsonError, jsonOk } from '$lib/server/security/validation';
import { incidentRepository } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

/**
 * Incident list with lifecycle filters:
 * `open` (default) = active + acknowledged — "what needs attention now";
 * `resolved` / `archived` are the history views; `all` is everything.
 * Counts for the header badges always ride along.
 */
export const GET: RequestHandler = async ({ url }) => {
	const status = url.searchParams.get('status') ?? 'open';
	const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));

	if (!['open', 'active', 'resolved', 'archived', 'all'].includes(status)) {
		return jsonError('status must be one of open, active, resolved, archived, all');
	}
	if (status === 'active') {
		// Strict-active query kept for API compatibility.
		return jsonOk({
			incidents: incidentRepository.active(),
			counts: incidentRepository.counts()
		});
	}
	const incidents = incidentRepository.byStatusGroup(
		status as 'open' | 'resolved' | 'archived' | 'all',
		limit
	);
	return jsonOk({ incidents, counts: incidentRepository.counts() });
};
