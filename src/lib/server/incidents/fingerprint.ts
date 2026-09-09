/**
 * Incident fingerprints: stable identity for a *class* of failure so repeated
 * messages deduplicate into one incident with an occurrence count instead of
 * flooding the incident list.
 */
import { createHash } from 'node:crypto';

export function fingerprint(...parts: (string | null | undefined)[]): string {
	const usable = parts.filter((p): p is string => Boolean(p));
	return createHash('sha256').update(usable.join('\u0000')).digest('hex').slice(0, 24);
}

export const Fingerprints = {
	serviceUnhealthy: (serviceKey: string) => `svc-unhealthy:${fingerprint(serviceKey)}`,
	serviceDegraded: (serviceKey: string) => `svc-degraded:${fingerprint(serviceKey)}`,
	serviceStopped: (serviceKey: string) => `svc-stopped:${fingerprint(serviceKey)}`,
	restartFailures: (serviceKey: string) => `svc-restart-failures:${fingerprint(serviceKey)}`,
	logErrors: (serviceKey: string) => `svc-log-errors:${fingerprint(serviceKey)}`,
	databaseHealth: (serviceName: string) => `db-health:${fingerprint(serviceName)}`,
	diskUsage: (path: string) => `disk-usage:${fingerprint(path)}`,
	dumbOffline: () => `dumb-offline:${fingerprint('gateway-unreachable')}`,
	dumbCredentials: () => `dumb-credentials:${fingerprint('credentials-invalid')}`,
	telemetryStale: () => `telemetry-stale:${fingerprint('metrics-not-updating')}`
};
