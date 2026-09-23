import { jsonOk } from '$lib/server/security/validation';
import { getHub } from '$lib/server/telemetry/hub';
import type { RequestHandler } from './$types';

/**
 * Deep DUMB observability (brief §2/§3/§4/§5/§6/§7/§10): DUMB cgroup memory
 * breakdown + interpretation, per-service memory classification with
 * baselines and baseline shifts, InfiniDysk repair/article aggregates,
 * Sonarr/Radarr stack facts, download routing statistics, thermal state and
 * version/update awareness. All read-only; nothing here alerts — Hermes
 * remains the notification layer.
 */
export const GET: RequestHandler = async () => {
	return jsonOk(getHub().getObservability());
};
