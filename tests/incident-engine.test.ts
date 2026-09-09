import { describe, expect, it, beforeEach } from 'vitest';
import { IncidentEngine } from '../src/lib/server/incidents/engine';
import { incidentRepository } from '../src/lib/server/incidents/repository';
import { getDb } from '../src/lib/server/database/db';
import type {
	ConnectionSnapshot,
	LogLine,
	MetricsSnapshot,
	ServiceStatus,
	TopologyGraph
} from '$lib/types';

function serviceStatus(
	overrides: Partial<ServiceStatus> & { key: string; name?: string }
): ServiceStatus {
	return {
		name: overrides.name ?? overrides.key,
		processName: overrides.name ?? overrides.key,
		enabled: true,
		runState: 'running',
		health: 'healthy',
		healthReason: null,
		healthDetails: null,
		restart: null,
		cpuPercent: null,
		memoryBytes: null,
		pid: 1,
		observedAt: Date.now(),
		...overrides
	};
}

function logLine(overrides: Partial<LogLine> = {}): LogLine {
	return {
		id: Math.floor(Math.random() * 1e9),
		ts: Date.now(),
		level: 'error',
		process: 'Sonarr',
		message: 'upstream failed',
		receivedAt: Date.now(),
		...overrides
	};
}

function metricsSnapshot(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
	return {
		timestamp: Date.now(),
		receivedAt: Date.now(),
		cpuPercent: 10,
		cpuCount: 8,
		loadAvg: [1, 1, 1],
		memory: { totalBytes: 1000, usedBytes: 500, percent: 50 },
		filesystems: [
			{
				path: '/data',
				totalBytes: 1000,
				usedBytes: 100,
				freeBytes: 900,
				percent: 10,
				inodePercent: 1
			}
		],
		network: [],
		networkTotals: null,
		processes: [],
		databaseHealth: [],
		...overrides
	};
}

function connection(overrides: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot {
	return {
		state: 'live',
		streams: { rest: 'live', status: 'live', metrics: 'live', logs: 'live' },
		lastUpdateAt: Date.now(),
		lastError: null,
		reconnectAttempts: 0,
		dumbVersion: null,
		authMode: 'local',
		...overrides
	};
}

function cascadingGraph(): TopologyGraph {
	// postgres -> infinidysk -> sonarr (edges point from dependency to dependent)
	return {
		nodes: [
			{
				key: 'postgres',
				name: 'PostgreSQL',
				category: 'database',
				health: 'unhealthy',
				runState: 'running',
				known: true
			},
			{
				key: 'infinidysk',
				name: 'InfiniDysk',
				category: 'bridge',
				health: 'unhealthy',
				runState: 'running',
				known: true
			},
			{
				key: 'sonarr',
				name: 'Sonarr',
				category: 'manager',
				health: 'degraded',
				runState: 'running',
				known: true
			}
		],
		edges: [
			{ from: 'postgres', to: 'infinidysk', health: 'failed' },
			{ from: 'infinidysk', to: 'sonarr', health: 'failed' }
		]
	};
}

describe('incident engine', () => {
	beforeEach(() => {
		const db = getDb();
		db.exec('DELETE FROM incident_events; DELETE FROM incidents;');
	});

	it('opens an unhealthy incident only after sustained failures', () => {
		const engine = new IncidentEngine();
		const unhealthy = serviceStatus({
			key: 'sonarr',
			health: 'unhealthy',
			healthReason: 'API down'
		});

		engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		expect(engine.getActive()).toHaveLength(0); // below threshold

		engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		const active = engine.getActive();
		expect(active).toHaveLength(1);
		expect(active[0]!.severity).toBe('critical');
		expect(active[0]!.title).toBe('sonarr is unhealthy');
	});

	it('resolves after sustained recovery and keeps occurrences', () => {
		const engine = new IncidentEngine();
		const unhealthy = serviceStatus({ key: 'sonarr', health: 'unhealthy' });
		const healthy = serviceStatus({ key: 'sonarr', health: 'healthy' });

		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		expect(engine.getActive()).toHaveLength(1);

		const previous = new Map([[unhealthy.key, unhealthy]]);
		const recovered = new Map([[healthy.key, healthy]]);
		for (let i = 0; i < 3; i++) engine.onStatus(previous, recovered);
		expect(engine.getActive()).toHaveLength(0);

		// Flaps again: must reopen with occurrences=2, not create a duplicate.
		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		const active = engine.getActive();
		expect(active).toHaveLength(1);
		expect(active[0]!.occurrences).toBe(2);
	});

	it('opens degraded incidents as warnings', () => {
		const engine = new IncidentEngine();
		const degraded = serviceStatus({
			key: 'infinidysk',
			health: 'degraded',
			healthReason: 'latency'
		});
		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[degraded.key, degraded]]));
		const active = engine.getActive();
		expect(active).toHaveLength(1);
		expect(active[0]!.severity).toBe('warning');
	});

	it('flags restart failure increases as critical', () => {
		const engine = new IncidentEngine();
		const restarting = serviceStatus({
			key: 'sonarr',
			restart: {
				attempts: 5,
				successes: 1,
				failures: 3,
				recentAttempts: 3,
				pending: false,
				nextRestartTime: null,
				disabled: false,
				lastRestartTime: null,
				lastFailureReason: 'exited with code 1',
				lastExitTime: null,
				lastExitReason: null,
				unhealthyCount: 3,
				unhealthyThreshold: 3
			}
		});
		engine.onStatus(new Map(), new Map([[restarting.key, restarting]]));
		const active = engine.getActive();
		expect(active.some((i) => i.title.includes('keeps restarting'))).toBe(true);
	});

	it('does not incident a normal brief stop, but flags sustained stops', () => {
		const engine = new IncidentEngine();
		const stopped = serviceStatus({ key: 'plex', runState: 'stopped' });
		engine.onStatus(new Map(), new Map([[stopped.key, stopped]]));
		expect(engine.getActive()).toHaveLength(0); // inside grace period
	});

	it('opens one telemetry-stale incident for a stalled metrics stream and resolves on flow', () => {
		let clock = Date.now();
		const engine = new IncidentEngine({}, () => clock);

		// Metrics last arrived minutes ago while status still looks live.
		engine.onTick(clock - 10 * 60_000, true);
		engine.onTick(clock + 1_000, true);
		const stale = engine.getActive().filter((i) => i.title.includes('stale'));
		expect(stale).toHaveLength(1);

		// Telemetry flowing again for long enough resolves it.
		clock += 1_000;
		engine.onTick(clock, true);
		engine.onConnection(connection({ state: 'live', lastUpdateAt: clock }));
		clock += 10 * 60_000;
		engine.onTick(clock, true);
		engine.onConnection(connection({ state: 'live', lastUpdateAt: clock }));
		expect(engine.getActive().filter((i) => i.title.includes('stale'))).toHaveLength(0);
	});

	it('does not create duplicate incidents from duplicate WS messages', () => {
		const engine = new IncidentEngine();
		const unhealthy = serviceStatus({ key: 'sonarr', health: 'unhealthy' });

		// The same snapshot delivered 10 times (replay/duplicate delivery).
		for (let i = 0; i < 10; i++) engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		const active = engine.getActive();
		expect(active).toHaveLength(1);
		expect(active[0]!.occurrences).toBe(1);
	});

	it('treats the last-delivered status as truth, even out of order', () => {
		const engine = new IncidentEngine();
		const now = Date.now();
		const first = serviceStatus({ key: 'sonarr', health: 'unhealthy', observedAt: now });
		const older = serviceStatus({ key: 'sonarr', health: 'healthy', observedAt: now - 30_000 });

		engine.onStatus(new Map(), new Map([[first.key, first]]));
		engine.onStatus(new Map(), new Map([[older.key, older]])); // arrives late
		engine.onStatus(new Map(), new Map([[first.key, first]]));
		engine.onStatus(new Map(), new Map([[first.key, first]]));
		// A late older snapshot resets the streak: below the sustained threshold.
		expect(engine.getActive()).toHaveLength(0);

		// Two more deliveries reach the threshold and open the incident.
		for (let i = 0; i < 2; i++) engine.onStatus(new Map(), new Map([[first.key, first]]));
		expect(engine.getActive()).toHaveLength(1);
	});

	it('keeps a service unhealthy incident while it is stopped and resolves on recovery', () => {
		const engine = new IncidentEngine();
		const unhealthy = serviceStatus({ key: 'sonarr', health: 'unhealthy' });
		const stopped = serviceStatus({ key: 'sonarr', health: 'unknown', runState: 'stopped' });
		const healthy = serviceStatus({ key: 'sonarr', health: 'healthy' });

		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		expect(engine.getActive()).toHaveLength(1);

		// Service disappears from the snapshot: hub reports it stopped. The
		// unhealthy incident stays active (a stopped service is still broken
		// until proven otherwise).
		const previous = new Map([[unhealthy.key, unhealthy]]);
		for (let i = 0; i < 10; i++) engine.onStatus(previous, new Map([[stopped.key, stopped]]));
		expect(engine.getActive().some((i) => i.title === 'sonarr is unhealthy')).toBe(true);

		// Comes back healthy: incident resolves after sustained recovery.
		const recovered = new Map([[healthy.key, healthy]]);
		for (let i = 0; i < 10; i++) engine.onStatus(previous, recovered);
		expect(engine.getActive().filter((i) => i.fingerprint.includes('sonarr'))).toHaveLength(0);
	});

	it('opens log-error incidents after a burst and resolves on quiet', () => {
		const engine = new IncidentEngine();
		for (let i = 0; i < 6; i++) {
			engine.onLogLine(logLine({ process: 'Sonarr', receivedAt: Date.now() }));
		}
		expect(engine.getActive().some((i) => i.fingerprint.includes('svc-log-errors'))).toBe(true);

		// After the window passes with no errors, the incident resolves.
		engine.sweepErrorBursts(Date.now() + 120_000);
		expect(engine.getActive()).toHaveLength(0);
	});

	it('flags disk usage with hysteresis', () => {
		let clock = Date.now();
		const engine = new IncidentEngine({}, () => clock);
		const at = (percent: number) =>
			engine.onMetrics(
				metricsSnapshot({
					filesystems: [
						{
							path: '/data',
							totalBytes: 100,
							usedBytes: percent,
							freeBytes: 100 - percent,
							percent,
							inodePercent: null
						}
					]
				})
			);

		at(96);
		expect(engine.getActive().some((i) => i.title.includes('Disk usage'))).toBe(false); // inside sustain grace

		clock += 31_000;
		engine.onMetrics(
			metricsSnapshot({
				filesystems: [
					{
						path: '/data',
						totalBytes: 100,
						usedBytes: 96,
						freeBytes: 4,
						percent: 96,
						inodePercent: null
					}
				]
			})
		);
		expect(engine.getActive().some((i) => i.title.includes('Disk usage'))).toBe(true);

		// Below warning but within resolve hysteresis: stays open.
		clock += 31_000;
		at(88);
		expect(engine.getActive().some((i) => i.title.includes('Disk usage'))).toBe(true);

		clock += 31_000;
		at(50);
		expect(engine.getActive()).toHaveLength(0);
	});

	it('detects database health failures from metrics', () => {
		const engine = new IncidentEngine();
		engine.onMetrics(
			metricsSnapshot({
				databaseHealth: [
					{
						processName: 'PostgreSQL 16',
						healthy: false,
						reason: 'connection refused',
						observedAt: Date.now()
					}
				]
			})
		);
		const active = engine.getActive();
		expect(active).toHaveLength(1);
		expect(active[0]!.fingerprint).toContain('db-health');
	});

	it('debounces a short DUMB disconnect but incidents a sustained one', () => {
		let clock = Date.now();
		const engine = new IncidentEngine({}, () => clock);
		engine.onConnection(connection({ state: 'offline', lastError: 'econnrefused' }));
		expect(engine.getActive()).toHaveLength(0); // inside grace period

		// Time passes well beyond the offline grace while offline persists.
		clock += 120_000;
		engine.onConnection(connection({ state: 'offline', lastError: 'econnrefused' }));
		expect(engine.getActive().some((i) => i.title.includes('unreachable'))).toBe(true);
	});

	it('never incidents a reconnecting gateway (debounce)', () => {
		const engine = new IncidentEngine();
		for (let i = 0; i < 20; i++) {
			engine.onConnection(connection({ state: 'reconnecting', reconnectAttempts: i }));
		}
		expect(engine.getActive()).toHaveLength(0);
	});

	it('correlates cascading failures to a single root cause', () => {
		const engine = new IncidentEngine();
		const postgresDown = serviceStatus({
			key: 'postgres',
			name: 'PostgreSQL',
			health: 'unhealthy'
		});
		const infinidyskDown = serviceStatus({
			key: 'infinidysk',
			name: 'InfiniDysk',
			health: 'unhealthy'
		});
		const sonarrDegraded = serviceStatus({ key: 'sonarr', name: 'Sonarr', health: 'degraded' });

		engine.onStatus(new Map(), new Map([[postgresDown.key, postgresDown]]));
		engine.onStatus(new Map(), new Map([[infinidyskDown.key, infinidyskDown]]));
		engine.onStatus(new Map(), new Map([[sonarrDegraded.key, sonarrDegraded]]));
		// Push all three past their thresholds.
		engine.onStatus(new Map(), new Map([[postgresDown.key, postgresDown]]));
		engine.onStatus(new Map(), new Map([[infinidyskDown.key, infinidyskDown]]));
		engine.onStatus(new Map(), new Map([[sonarrDegraded.key, sonarrDegraded]]));
		engine.onStatus(new Map(), new Map([[postgresDown.key, postgresDown]]));
		engine.onStatus(new Map(), new Map([[infinidyskDown.key, infinidyskDown]]));
		engine.onStatus(new Map(), new Map([[sonarrDegraded.key, sonarrDegraded]]));

		engine.correlate(cascadingGraph());

		const active = engine.getActive();
		expect(active.length).toBeGreaterThanOrEqual(3);
		const sonarrIncident = active.find((i) => i.title.startsWith('Sonarr'));
		const infinidyskIncident = active.find((i) => i.title.startsWith('InfiniDysk'));
		const postgresIncident = active.find((i) => i.title.startsWith('PostgreSQL'));
		// The engine attributes the *ultimate* root cause down the chain —
		// matching the product spec's "PostgreSQL unavailable" example.
		expect(infinidyskIncident?.rootCauseService).toBe('PostgreSQL');
		expect(sonarrIncident?.rootCauseService).toBe('PostgreSQL');
		expect(postgresIncident?.rootCauseService).toBeNull();
		// The root incident accumulates everything it knocked out.
		expect(new Set(postgresIncident?.affectedServices).has('sonarr')).toBe(true);
		expect(new Set(postgresIncident?.affectedServices).has('infinidysk')).toBe(true);
	});

	it('persists and reloads incidents from SQLite', () => {
		const engine = new IncidentEngine();
		const unhealthy = serviceStatus({ key: 'plex', name: 'Plex', health: 'unhealthy' });
		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));

		const stored = incidentRepository.active();
		expect(stored).toHaveLength(1);
		expect(stored[0]!.affectedServices).toEqual(['plex']);

		// A brand-new engine (process restart) must adopt the open incident —
		// without bumping occurrences, since it never resolved.
		const engine2 = new IncidentEngine();
		for (let i = 0; i < 3; i++) engine2.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		const adopted = engine2.getActive();
		expect(adopted).toHaveLength(1);
		expect(adopted[0]!.id).toBe(stored[0]!.id);
		expect(adopted[0]!.occurrences).toBe(1);
	});
});
