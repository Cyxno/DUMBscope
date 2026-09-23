import { jsonOk } from '$lib/server/security/validation';
import { dbHealthy } from '$lib/server/database/db';
import { getHub } from '$lib/server/telemetry/hub';
import { appInfo } from '$lib/shared/app-info';
import type { RequestHandler } from './$types';

/**
 * The housekeeping interval is 10s; a completed tick older than this means
 * the scheduler is not making progress.
 */
const HOUSEKEEPING_MAX_AGE_MS = 45_000;

/**
 * Readiness probe (public): "can this instance serve requests?" Checks
 * DUMBscope's OWN dependencies only:
 * - `db`: the SQLite database answers a trivial query,
 * - `hub`: the telemetry hub has been initialized (schedulers armed),
 * - `scheduler`: the housekeeping heartbeat is fresh (last tick within 45s).
 *
 * DUMB being offline does NOT make DUMBscope unready — while the gateway is
 * down, DUMBscope must still serve its UI, incident history and degraded
 * state honestly. The DUMB connection state is reported informationally.
 *
 * Returns 200 when ready, 503 with the failing checks when not.
 */
export const GET: RequestHandler = async () => {
	const hub = getHub();
	const heartbeat = hub.housekeepingHeartbeatMs;
	const checks = {
		db: dbHealthy(),
		hub: hub.isStarted,
		scheduler: heartbeat !== null && heartbeat <= HOUSEKEEPING_MAX_AGE_MS
	};
	const ready = checks.db && checks.hub && checks.scheduler;
	const dumb = !hub.isConfigured
		? 'unconfigured'
		: hub.getConnection().state === 'live'
			? 'connected'
			: hub.getConnection().state === 'credentials-invalid'
				? 'credentials-invalid'
				: 'disconnected';
	return jsonOk(
		{
			status: ready ? 'ready' : 'not-ready',
			checks,
			housekeepingHeartbeatMs: heartbeat,
			// Informational: never gates readiness.
			dumb,
			version: appInfo().version
		},
		ready ? 200 : 503
	);
};
