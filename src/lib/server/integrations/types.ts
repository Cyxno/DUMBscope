/**
 * Deep-integration type contracts.
 *
 * An integration connects DUMBscope to one managed service (Sonarr, Plex, …)
 * *in addition to* the generic DUMB monitoring. Two layers stay separate:
 * the underlying service health comes from DUMB, integration health describes
 * the enrichment connection only — a broken Plex key must never turn the
 * stack "critical" (brief §32).
 */

export const INTEGRATION_TYPES = [
	'sonarr',
	'radarr',
	'prowlarr',
	'seerr',
	'bazarr',
	'plex',
	'tautulli',
	'decypharr',
	'infinidysk'
] as const;

export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export type IntegrationState =
	| 'not_configured'
	| 'connecting'
	| 'connected'
	| 'unsupported_version'
	| 'auth_error'
	| 'unreachable'
	| 'error'
	| 'disabled';

export interface IntegrationConfig {
	/** Stable instance id, e.g. `sonarr-main`. ID-based, never `services.sonarr`. */
	id: string;
	type: IntegrationType;
	url: string;
	/** Presence flag only — the key itself never leaves the server. */
	hasApiKey: boolean;
	enabled: boolean;
	lastTestAt: number | null;
	lastTestOk: boolean | null;
	lastTestError: string | null;
}

export interface IntegrationStatus {
	id: string;
	type: IntegrationType;
	state: IntegrationState;
	version: string | null;
	/** Last poll latency in ms, when known. */
	latencyMs: number | null;
	lastSuccessAt: number | null;
	lastError: string | null;
	consecutiveFailures: number;
	/** Epoch ms of the next scheduled poll, for the diagnostics view. */
	nextPollAt: number | null;
	/** Per-poller observability (brief §3). */
	pollers: {
		name: string;
		intervalMs: number;
		lastRunAt: number | null;
		lastOkAt: number | null;
		lastError: string | null;
		nextRunAt: number | null;
	}[];
}

/** Envelope returned to the browser: config + live status, no secrets. */
export interface IntegrationSummary {
	config: IntegrationConfig;
	status: IntegrationStatus;
}

export interface ActivityEvent {
	id: string;
	at: number;
	/** Integration id or `dumb`. */
	source: string;
	/** Hub service key when the event belongs to a managed service. */
	serviceKey: string | null;
	category:
		| 'request'
		| 'search'
		| 'grab'
		| 'download'
		| 'import'
		| 'library'
		| 'playback'
		| 'health'
		| 'system';
	title: string;
	detail: string | null;
	severity: 'info' | 'warning' | 'critical' | null;
	/** true = straight from the source system; false = correlated/inferred. */
	observed: boolean;
	correlationId: string | null;
}

export function isIntegrationType(value: unknown): value is IntegrationType {
	return typeof value === 'string' && (INTEGRATION_TYPES as readonly string[]).includes(value);
}
