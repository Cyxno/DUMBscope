import { jsonError, jsonOk, isSameOrigin, readJson } from '$lib/server/security/validation';
import { incidentRepository } from '$lib/server/incidents/repository';
import { getHub } from '$lib/server/telemetry/hub';
import { z } from 'zod';
import type { RequestHandler } from './$types';

const actionSchema = z.object({
	action: z.enum(['acknowledge', 'unacknowledge', 'archive'])
});

/** One incident (for the detail drawer). */
export const GET: RequestHandler = async ({ params }) => {
	const incident = incidentRepository.get(params.id ?? '');
	if (!incident) return jsonError('Incident not found', 404);
	return jsonOk({ incident });
};

/**
 * Operator lifecycle actions (§2). Honest semantics:
 * - `acknowledge` mutes the incident for the operator but keeps it
 *   technically open — the detector keeps evaluating it and will resolve it
 *   when (and only when) it positively verifies recovery.
 * - `archive` clears a RESOLVED incident from the working views. It never
 *   touches active problems and never pretends anything recovered.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) return jsonError('Authentication required', 401);
	if (!isSameOrigin(request)) return jsonError('Invalid origin', 403);
	const body = await readJson(request);
	const parsed = actionSchema.safeParse(body);
	if (!parsed.success) return jsonError('action must be acknowledge, unacknowledge or archive');

	const at = Date.now();
	let incident = null;
	if (parsed.data.action === 'acknowledge') {
		incident = incidentRepository.acknowledge(
			params.id ?? '',
			at,
			'Acknowledged by operator — stays technically active until DUMBscope verifies recovery'
		);
	} else if (parsed.data.action === 'unacknowledge') {
		incident = incidentRepository.unacknowledge(params.id ?? '', at, 'Re-opened by operator');
	} else {
		incident = incidentRepository.archive(params.id ?? '', at, 'Archived by operator');
	}
	if (!incident) return jsonError('Incident not found or action not allowed for its status', 404);

	// Live-update every open tab (same channel detector changes use).
	getHub().notifyIncidentChange(incident);
	return jsonOk({ incident });
};
