import { jsonOk } from '$lib/server/security/validation';
import { appInfo } from '$lib/shared/app-info';
import type { RequestHandler } from './$types';

/**
 * Liveness probe (public): "is the process alive and is its event loop
 * answering?" Reaching this handler IS the check — no database, no hub, no
 * downstream state is consulted, so a wedged dependency can never fail a
 * liveness probe. This is the endpoint the Docker HEALTHCHECK uses: Docker
 * restarts the container when it stops answering.
 */
export const GET: RequestHandler = async () => {
	return jsonOk({ status: 'live', version: appInfo().version });
};
