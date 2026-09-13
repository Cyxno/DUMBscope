/**
 * Health/status semantics shared by the whole UI: one vocabulary for colors,
 * labels and orderings so status is never encoded ad hoc in components.
 */
import type { HealthStatus, RunState } from '$lib/types';

export type Severity = 'healthy' | 'degraded' | 'critical' | 'unknown' | 'info';

export function healthColor(health: HealthStatus): Severity {
	switch (health) {
		case 'healthy':
			return 'healthy';
		case 'degraded':
			return 'degraded';
		case 'starting':
			return 'degraded';
		case 'unhealthy':
			return 'critical';
		default:
			return 'unknown';
	}
}

export function healthLabel(health: HealthStatus): string {
	switch (health) {
		case 'healthy':
			return 'Healthy';
		case 'degraded':
			return 'Degraded';
		case 'starting':
			return 'Starting';
		case 'unhealthy':
			return 'Unhealthy';
		default:
			return 'Unknown';
	}
}

export function runStateLabel(runState: RunState): string {
	switch (runState) {
		case 'running':
			return 'Running';
		case 'starting':
			return 'Starting';
		case 'stopped':
			return 'Stopped';
		default:
			return 'Unknown';
	}
}

/** Sort key so unhealthy services float to the top of lists. */
export function severityRank(health: HealthStatus): number {
	switch (health) {
		case 'unhealthy':
			return 0;
		case 'degraded':
			return 1;
		case 'starting':
			return 2;
		case 'unknown':
			return 3;
		case 'healthy':
			return 4;
		default:
			return 5;
	}
}

export const CONNECTION_LABELS: Record<string, string> = {
	starting: 'STARTING',
	live: 'CONNECTED',
	connecting: 'CONNECTING',
	degraded: 'PARTIAL',
	reconnecting: 'RECONNECTING',
	stale: 'STALE',
	offline: 'UNREACHABLE',
	unconfigured: 'NOT CONFIGURED',
	'credentials-invalid': 'AUTH NEEDED'
};

/**
 * Honest tone per connection state (brief §12): only a derived `offline`
 * verdict or an auth wall is red; every grace/partial state is amber or
 * neutral — never a false red during a reboot.
 */
export function connectionTone(state: string): Severity {
	switch (state) {
		case 'live':
			return 'healthy';
		case 'starting':
		case 'connecting':
		case 'reconnecting':
		case 'degraded':
		case 'stale':
			return 'degraded';
		case 'offline':
		case 'credentials-invalid':
			return 'critical';
		default:
			return 'unknown';
	}
}
