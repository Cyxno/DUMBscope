import { describe, expect, it } from 'vitest';
import {
	normalizeDiscovered,
	normalizeHealthStatus,
	normalizeMetrics,
	normalizeRunState,
	normalizeServiceStatus,
	toEpochMs
} from '../src/lib/server/dumb/normalize';
import { parseCapabilities } from '../src/lib/server/dumb/capabilities';
import { parseLogLine, splitLines } from '../src/lib/server/logs/parse';

describe('normalize', () => {
	it('maps health statuses to the known domain', () => {
		expect(normalizeHealthStatus('healthy')).toBe('healthy');
		expect(normalizeHealthStatus('UNHEALTHY')).toBe('unhealthy');
		expect(normalizeHealthStatus('something-new')).toBe('unknown');
		expect(normalizeHealthStatus(undefined, true)).toBe('healthy');
		expect(normalizeHealthStatus(undefined, false)).toBe('unhealthy');
	});

	it('maps run states without collapsing semantics', () => {
		expect(normalizeRunState('running')).toBe('running');
		expect(normalizeRunState('restarting')).toBe('starting');
		expect(normalizeRunState('stopped')).toBe('stopped');
		expect(normalizeRunState(null)).toBe('unknown');
	});

	it('parses epoch seconds and ISO timestamps', () => {
		expect(toEpochMs(1752575400)).toBe(1752575400000);
		expect(toEpochMs(1752575400000)).toBe(1752575400000);
		expect(toEpochMs('2025-07-15T10:30:00Z')).toBe(Date.parse('2025-07-15T10:30:00Z'));
		expect(toEpochMs('garbage')).toBeNull();
	});

	it('normalizes discovered processes tolerantly', () => {
		const service = normalizeDiscovered({
			name: 'rclone w/ RealDebrid',
			process_name: 'rclone w/ RealDebrid',
			enabled: false,
			version: '1.65.1',
			config_key: 'rclone',
			update_status: {
				status: 'update_available',
				current_version: '1.65.1',
				available_version: '1.66.0'
			}
		});
		expect(service).not.toBeNull();
		expect(service!.key).toBe('rclone');
		expect(service!.enabled).toBe(false);
		expect(service!.updateStatus?.availableVersion).toBe('1.66.0');
		expect(normalizeDiscovered({})).toBeNull();
	});

	it('normalizes service status with restart state', () => {
		const status = normalizeServiceStatus({
			process_name: 'InfiniDysk',
			status: 'running',
			healthy: true,
			health_status: 'starting',
			health_reason: 'InfiniDysk reports migrating',
			health_details: {
				probe: 'http',
				endpoint: '/health',
				http_status: 503,
				reported_status: 'migrating'
			},
			restart: {
				restart_attempts: 2,
				restart_failures: 1,
				pending: true,
				last_failure_reason: 'exit 1'
			}
		});
		expect(status).not.toBeNull();
		expect(status!.health).toBe('starting');
		expect(status!.healthDetails?.httpStatus).toBe(503);
		expect(status!.restart?.attempts).toBe(2);
		expect(status!.restart?.pending).toBe(true);
		expect(status!.restart?.lastFailureReason).toBe('exit 1');
	});

	it('normalizes metrics snapshots with filesystem + network fallbacks', () => {
		const snapshot = normalizeMetrics({
			timestamp: 1752575400,
			system: {
				cpu_percent: 45.2,
				cpu_count: 8,
				load_avg: [1.5, 1.2, 0.9],
				mem: { total: 17179869184, used: 8589934592, percent: 50 },
				disk: { path: '/', total: 500, used: 250, free: 250, percent: 50 },
				inode: { path: '/', percent: 4.2 },
				net_io: { sent_bytes: 10, recv_bytes: 20 }
			},
			dumb_managed: [{ pid: 1, name: 'Sonarr', cpu_percent: 5, rss: 100 }],
			database_health: {
				'PostgreSQL 16': { healthy: false, reason: 'conn refused', timestamp: 1752575400 }
			}
		});
		expect(snapshot.cpuPercent).toBe(45.2);
		expect(snapshot.memory?.percent).toBe(50);
		// Legacy disk aliases into filesystems when the array is absent.
		expect(snapshot.filesystems).toHaveLength(1);
		expect(snapshot.filesystems[0]!.path).toBe('/');
		expect(snapshot.networkTotals?.recvBytes).toBe(20);
		expect(snapshot.processes[0]!.name).toBe('Sonarr');
		expect(snapshot.databaseHealth[0]!.healthy).toBe(false);
	});
});

describe('capabilities', () => {
	it('gates features and list membership', () => {
		const caps = parseCapabilities({
			startup_lifecycle: true,
			postgres_migration_service_keys: ['sonarr', 'infinidysk']
		});
		expect(caps.has('startup_lifecycle')).toBe(true);
		expect(caps.has('missing_flag')).toBe(false);
		expect(caps.listIncludes('postgres_migration_service_keys', 'infinidysk')).toBe(true);
		expect(caps.listIncludes('postgres_migration_service_keys', 'plex')).toBe(false);
		expect(parseCapabilities(null).has('anything')).toBe(false);
	});
});

describe('log parsing', () => {
	it('parses the documented DUMB line format', () => {
		const line = parseLogLine('Apr 12, 2025 10:04:01 - INFO - Riven Backend started');
		expect(line.level).toBe('info');
		expect(line.ts).toBe(new Date(2025, 3, 12, 10, 4, 1).getTime());
		expect(line.message).toBe('Riven Backend started');
	});

	it('lifts known process names out of the message', () => {
		const line = parseLogLine('Apr 12, 2025 10:04:01 - ERROR - Sonarr: upstream request failed', {
			processNames: new Set(['Sonarr'])
		});
		expect(line.process).toBe('Sonarr');
		expect(line.level).toBe('error');
		expect(line.message).toBe('upstream request failed');
	});

	it('falls back to raw for unparseable lines', () => {
		const line = parseLogLine('some random output without structure');
		expect(line.level).toBe('raw');
		expect(line.ts).toBeNull();
	});

	it('splits chunks into non-empty lines', () => {
		expect(splitLines('a\nb\r\nc\n')).toEqual(['a', 'b', 'c']);
	});
});
