import { jsonOk } from '$lib/server/security/validation';
import { getHub } from '$lib/server/telemetry/hub';
import { dbHealthy } from '$lib/server/database/db';
import { sessionCount, hasAdminUser } from '$lib/server/security/sessions';
import { appInfo } from '$lib/shared/app-info';
import { incidentRepository } from '$lib/server/incidents/repository';
import { currentVersion } from '$lib/server/database/migrations';
import { getDb } from '$lib/server/database/db';
import type { RequestHandler } from './$types';

/**
 * Redacted diagnostics bundle for bug reports. Contains no credentials, URLs
 * are reduced to host:port, and log content is never included.
 */
export const GET: RequestHandler = async () => {
	const hub = getHub();
	const connection = hub.getConnection();
	const info = appInfo();

	const diagnostics = {
		generatedAt: new Date().toISOString(),
		dumbscope: {
			version: info.version,
			buildSha: info.buildSha ? `${info.buildSha.slice(0, 12)}` : null,
			node: info.nodeVersion,
			dbOk: dbHealthy(),
			dbSchemaVersion: currentVersion(getDb()),
			activeSessions: sessionCount(),
			setupCompleted: hasAdminUser() && getHub().isConfigured
		},
		connection: {
			state: connection.state,
			authMode: connection.authMode,
			dumbVersion: connection.dumbVersion,
			streams: connection.streams,
			lastUpdateAt: connection.lastUpdateAt
				? new Date(connection.lastUpdateAt).toISOString()
				: null,
			secondsSinceLastUpdate:
				connection.lastUpdateAt !== null
					? Math.round((Date.now() - connection.lastUpdateAt) / 1000)
					: null,
			reconnectAttempts: connection.reconnectAttempts,
			lastError: connection.lastError
		},
		stack: {
			discoveredServices: hub.getDiscovered().length,
			trackedServices: hub.getServices().length,
			capabilityCount: Object.keys(hub.getCapabilities().raw).length,
			activeIncidents: hub.getActiveIncidents().length,
			incidentHistory: incidentRepository.recent(1).length > 0 ? 'present' : 'empty'
		},
		capabilities: Object.keys(hub.getCapabilities().raw).filter((k) => hub.getCapabilities().has(k))
	};

	return jsonOk(diagnostics);
};
