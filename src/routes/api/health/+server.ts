import { jsonOk } from '$lib/server/security/validation';
import { dbHealthy } from '$lib/server/database/db';
import { getHub } from '$lib/server/telemetry/hub';
import { appInfo } from '$lib/shared/app-info';
import type { RequestHandler } from './$types';

/**
 * DUMBscope's own health endpoint (public; used by the container healthcheck).
 * DUMB being offline does NOT make DUMBscope unhealthy.
 */
export const GET: RequestHandler = async () => {
	const hub = getHub();
	const dumb = !hub.isConfigured
		? 'unconfigured'
		: hub.getConnection().state === 'live'
			? 'connected'
			: hub.getConnection().state === 'credentials-invalid'
				? 'credentials-invalid'
				: 'disconnected';
	return jsonOk({
		status: dbHealthy() ? 'ok' : 'degraded',
		dumb,
		version: appInfo().version
	});
};
