import { jsonOk } from '$lib/server/security/validation';
import { getHub } from '$lib/server/telemetry/hub';
import type { RequestHandler } from './$types';

/**
 * Cross-service media flow (DEEL 2): recent correlated flows, bounded
 * metrics, remediation recommendations (recommendation-only) and the recent
 * action audit trail. Read-only.
 */
export const GET: RequestHandler = async () => {
	return jsonOk(getHub().getMediaFlow());
};
