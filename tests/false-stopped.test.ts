/**
 * Regression tests for the false "is stopped" incidents (v0.2.0 production
 * issue). Raw DUMB /ws/status frames report every process running, yet the
 * hub evaluated DUMB Frontend / DUMB API / Plex as stopped: frames processed
 * before the REST bootstrap applied the service registry create service
 * entries under slug keys; once discovery applies, those keys are never seen
 * again, so the incidents can never resolve.
 *
 * Fix under test: the hub gates status evaluation on discovery readiness,
 * and the engine reconciles stopped incidents under the legacy slug key when
 * the service is seen running under its discovered key.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { IncidentEngine } from '../src/lib/server/incidents/engine';
import { getDb } from '../src/lib/server/database/db';
import { serviceKeyFromName } from '../src/lib/server/dumb/normalize';
import type { ServiceStatus } from '$lib/types';

// Redacted structural fixtures from the real /ws/status payload.
const frame = (name: string, status = 'running'): ServiceStatus => ({
	key: serviceKeyFromName(name),
	name,
	processName: name,
	enabled: true,
	runState: (status === 'running' ? 'running' : status) as ServiceStatus['runState'],
	health: status === 'running' ? 'healthy' : 'unknown',
	healthReason: null,
	healthDetails: null,
	restart: null,
	cpuPercent: null,
	memoryBytes: null,
	pid: null,
	observedAt: Date.now()
});

const REAL_STACK_RUNNING = [
	'DUMB Frontend',
	'DUMB API',
	'Seerr',
	'Sonarr',
	'Radarr',
	'Prowlarr',
	'Decypharr',
	'InfiniDysk',
	'Plex Media Server',
	'Tautulli',
	'Bazarr'
];

function toMap(list: ServiceStatus[]): Map<string, ServiceStatus> {
	return new Map(list.map((s) => [s.key, s]));
}

function clearIncidentTables(): void {
	getDb().exec('DELETE FROM incident_events; DELETE FROM incidents;');
}

describe('false stopped incidents (startup gate + reconciliation)', () => {
	beforeEach(() => {
		clearIncidentTables();
	});

	it('A: a partial pre-discovery frame never opens stopped incidents', () => {
		const engine = new IncidentEngine();
		engine.discoveryReady = false;

		// Startup transient: DUMB reports only the core processes, running.
		const partial = toMap([frame('DUMB Frontend'), frame('DUMB API'), frame('Plex Media Server')]);
		engine.onStatus(new Map(), partial);
		engine.onStatus(partial, partial);

		// Later frames with the full discovered stack arrive — including the
		// three core services under their discovered keys, running.
		const full = toMap(REAL_STACK_RUNNING.map((n) => frame(n)));
		for (let i = 0; i < 10; i++) engine.onStatus(partial, full);

		expect(engine.getActive()).toHaveLength(0);
	});

	it('B: a genuinely stopped service still opens its stopped incident', () => {
		let clock = Date.now();
		const engine = new IncidentEngine({}, () => clock);
		engine.discoveryReady = true;

		const stopped = toMap([frame('Sonarr', 'stopped')]);
		// Sustained stop beyond the grace period.
		for (let i = 0; i < 10; i++) {
			engine.onStatus(new Map(), stopped);
			clock += 10_000;
		}

		const active = engine.getActive().filter((i) => i.title === 'Sonarr is stopped');
		expect(active).toHaveLength(1);
		expect(active[0]!.severity).toBe('warning');
	});

	it('C: legacy slug-key stopped incidents resolve on reconciliation', () => {
		let clock = Date.now();
		const engine = new IncidentEngine({}, () => clock);
		engine.discoveryReady = true;

		// The false incident: opened under the pre-discovery slug key.
		const slugKey = serviceKeyFromName('DUMB Frontend');
		const ghost = toMap([frame('DUMB Frontend', 'stopped')]);
		ghost.set(slugKey, { ...frame('DUMB Frontend', 'stopped'), key: slugKey });
		// Sustained "stopped" evaluations under the slug key.
		for (let i = 0; i < 10; i++) {
			engine.onStatus(new Map(), ghost);
			clock += 10_000;
		}
		expect(engine.getActive().some((i) => i.title === 'DUMB Frontend is stopped')).toBe(true);

		// Reconciliation: the same service is seen running under its
		// discovered key — the legacy incident resolves.
		const running = toMap([frame('DUMB Frontend')]);
		for (let i = 0; i < 10; i++) engine.onStatus(ghost, running);
		expect(engine.getActive().some((i) => i.title === 'DUMB Frontend is stopped')).toBe(false);

		// History preserved: the incident row still exists (resolved).
		const resolved = getDb()
			.prepare('SELECT status FROM incidents WHERE title = ?')
			.all('DUMB Frontend is stopped') as { status: string }[];
		expect(resolved.length).toBeGreaterThan(0);
		expect(resolved.every((r) => r.status === 'resolved')).toBe(true);
	});
});
