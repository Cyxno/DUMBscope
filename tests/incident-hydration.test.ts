/**
 * Regression tests for the production-audit incident hydration bug
 * (brief §21): persisted active incidents must survive restarts and resolve
 * naturally instead of staying active forever.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { IncidentEngine } from '../src/lib/server/incidents/engine';
import { incidentRepository, newIncidentId } from '../src/lib/server/incidents/repository';
import { Fingerprints } from '../src/lib/server/incidents/fingerprint';
import { getDb } from '../src/lib/server/database/db';
import type { Incident, ServiceStatus } from '$lib/types';

function serviceStatus(overrides: Partial<ServiceStatus> & { key: string }): ServiceStatus {
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

function persistedIncident(overrides: Partial<Incident> & { fingerprint: string }): Incident {
	return {
		id: newIncidentId(),
		fingerprint: overrides.fingerprint,
		severity: 'warning',
		status: 'active',
		title: overrides.title ?? 'DUMB credentials rejected',
		summary: 'Update the DUMB credentials in Settings to restore monitoring',
		rootCauseService: null,
		rootCauseFingerprint: null,
		affectedServices: [],
		firstSeen: Date.now() - 3_600_000,
		lastSeen: Date.now() - 1_800_000,
		resolvedAt: null,
		occurrences: 1,
		evidence: [],
		timeline: [],
		...overrides
	};
}

function clearIncidentTables(): void {
	getDb().exec('DELETE FROM incident_events; DELETE FROM incidents;');
}

beforeEach(() => {
	clearIncidentTables();
});

describe('incident hydration across restarts', () => {
	it('Scenario A: active credentials incident resolves after hydrate + live connection', () => {
		// Before the restart: DUMB rejected credentials, incident opened+persisted.
		const engine1 = new IncidentEngine();
		engine1.openIncident({
			fingerprint: Fingerprints.dumbCredentials(),
			severity: 'warning',
			title: 'DUMB credentials rejected',
			summary: 'Update the DUMB credentials in Settings to restore monitoring',
			service: null,
			evidenceMessage: 'auth rejected',
			source: 'connection'
		});
		expect(engine1.getActive()).toHaveLength(1);

		// "Restart": fresh engine, nothing in memory. Credentials now work and
		// the connection is live for well past the resolve window.
		const engine2 = new IncidentEngine();
		engine2.hydrate();
		expect(engine2.getActive()).toHaveLength(1); // hydrated, still active

		const live = {
			state: 'live' as const,
			streams: {
				rest: 'live' as const,
				status: 'live' as const,
				metrics: 'live' as const,
				logs: 'live' as const
			},
			lastUpdateAt: Date.now(),
			lastError: null,
			reconnectAttempts: 0,
			dumbVersion: '1.8.2',
			authMode: 'local'
		};
		engine2.onConnection(live);

		const active = engine2.getActive();
		expect(active).toHaveLength(0);
		// Persisted as resolved, history intact.
		const row = incidentRepository.findLatestByFingerprint(Fingerprints.dumbCredentials());
		expect(row?.status).toBe('resolved');
		expect(row?.timeline.some((t) => t.message.includes('credentials accepted'))).toBe(true);
	});

	it('Scenario B: still-failing service keeps one active incident, no duplicate', () => {
		const fp = Fingerprints.serviceUnhealthy('sonarr');
		const engine1 = new IncidentEngine();
		const unhealthy = serviceStatus({ key: 'sonarr', health: 'unhealthy' });
		for (let i = 0; i < 3; i++) engine1.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		expect(engine1.getActive()).toHaveLength(1);

		// Restart: hydrate loads the active incident. Service is still unhealthy,
		// so evaluation re-arms without creating a second incident.
		const engine2 = new IncidentEngine();
		engine2.hydrate();
		for (let i = 0; i < 5; i++) engine2.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		expect(engine2.getActive()).toHaveLength(1);

		const rows = getDb()
			.prepare("SELECT COUNT(*) c FROM incidents WHERE status = 'active'")
			.get() as { c: number };
		expect(rows.c).toBe(1);
		void fp;
	});

	it('Scenario C: resolved incidents stay resolved after restart', () => {
		const engine1 = new IncidentEngine();
		const unhealthy = serviceStatus({ key: 'sonarr', health: 'unhealthy' });
		const healthy = serviceStatus({ key: 'sonarr', health: 'healthy' });
		for (let i = 0; i < 3; i++) engine1.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		for (let i = 0; i < 3; i++)
			engine1.onStatus(new Map([[unhealthy.key, unhealthy]]), new Map([[healthy.key, healthy]]));
		expect(engine1.getActive()).toHaveLength(0);

		const engine2 = new IncidentEngine();
		engine2.hydrate();
		expect(engine2.getActive()).toHaveLength(0);
	});

	it('hydrate is idempotent and never duplicates rows in state', () => {
		const fp = Fingerprints.dumbCredentials();
		const incident = persistedIncident({ fingerprint: fp });
		incidentRepository.create(incident);
		const engine = new IncidentEngine();
		engine.hydrate();
		engine.hydrate();
		expect(engine.getActive()).toHaveLength(1);
	});

	it('integration failures only open warnings after sustained failures, not when unconfigured', () => {
		const engine = new IncidentEngine();
		// Not configured: zero failures — must never open an incident.
		engine.onIntegrations([
			{ id: 'plex', failures: 0 },
			{ id: 'seerr', failures: 0 }
		]);
		expect(engine.getActive()).toHaveLength(0);

		// Configured but one transient failure: below threshold, no incident.
		engine.onIntegrations([{ id: 'plex', failures: 1 }]);
		expect(engine.getActive()).toHaveLength(0);

		// Sustained failures: warning incident opens.
		engine.onIntegrations([{ id: 'plex', failures: 5 }]);
		const active = engine.getActive();
		expect(active).toHaveLength(1);
		expect(active[0]!.title).toContain('plex');
		expect(active[0]!.severity).toBe('warning');
	});
});
