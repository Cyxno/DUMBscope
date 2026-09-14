import { jsonOk } from '$lib/server/security/validation';
import { getHub } from '$lib/server/telemetry/hub';
import type { RequestHandler } from './$types';

/**
 * Reliability core (FASE A/B/C): mount health reports, per-process memory
 * views and probe-overhead stats. Read-only — none of these trigger actions.
 */
export const GET: RequestHandler = async () => {
	return jsonOk(getHub().getReliability());
};
