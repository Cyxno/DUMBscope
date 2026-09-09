import { jsonError, jsonOk } from '$lib/server/security/validation';
import { incidentRepository } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

/** Incident history with paging; `status=active|resolved|all`. */
export const GET: RequestHandler = async ({ url }) => {
	const status = url.searchParams.get('status') ?? 'all';
	const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));

	if (status === 'active') {
		return jsonOk({ incidents: incidentRepository.active() });
	}
	if (!['all', 'resolved'].includes(status)) {
		return jsonError('status must be one of active, resolved, all');
	}
	const incidents =
		status === 'resolved'
			? incidentRepository.recent(limit * 2).filter((i) => i.status === 'resolved')
			: incidentRepository.recent(limit);
	return jsonOk({ incidents: incidents.slice(0, limit) });
};
