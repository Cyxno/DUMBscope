/**
 * Health semantics (v0.8.1): liveness answers "is the process answering"
 * without touching any dependency; readiness checks DUMBscope's OWN
 * dependencies (database, hub, scheduler heartbeat) and explicitly never
 * fails because DUMB itself is offline.
 */
import { describe, expect, it, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { GET as live } from '../src/routes/api/health/live/+server';
import { GET as ready } from '../src/routes/api/health/ready/+server';
import { getHub, resetHub } from '../src/lib/server/telemetry/hub';

describe('GET /api/health/live', () => {
	it('answers 200 without starting the hub or touching the database', async () => {
		const response = await live({} as never);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { status: string; version: string };
		expect(body.status).toBe('live');
		expect(body.version).toBeTruthy();
	});
});

describe('GET /api/health/live build provenance', () => {
	const PREV = {
		BUILD_SHA: process.env.BUILD_SHA,
		BUILD_DATE: process.env.BUILD_DATE,
		BUILD_TIME: process.env.BUILD_TIME
	};

	afterEach(() => {
		for (const [key, value] of Object.entries(PREV)) {
			if (value === undefined) delete process.env[key as keyof typeof PREV];
			else process.env[key as keyof typeof PREV] = value;
		}
		vi.resetModules();
	});

	async function liveBody() {
		vi.resetModules();
		const { GET } = await import('../src/routes/api/health/live/+server');
		const response = await GET({} as never);
		expect(response.status).toBe(200);
		return (await response.json()) as {
			status: string;
			version: string;
			buildSha: string | null;
			buildDate: string | null;
		};
	}

	it('reports build metadata when injected (production image path)', async () => {
		process.env.BUILD_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
		process.env.BUILD_DATE = '2026-09-25T00:00:00Z';
		const body = await liveBody();
		expect(body.status).toBe('live');
		expect(body.version).toBeTruthy();
		expect(body.buildSha).toBe('abcdef1234567890abcdef1234567890abcdef12');
		expect(body.buildDate).toBe('2026-09-25T00:00:00Z');
	});

	it('degrades to null (not a placeholder) when metadata is absent (local/dev path)', async () => {
		delete process.env.BUILD_SHA;
		delete process.env.BUILD_DATE;
		delete process.env.BUILD_TIME;
		const body = await liveBody();
		expect(body.status).toBe('live');
		expect(body.version).toBeTruthy();
		expect(body.buildSha).toBeNull();
		expect(body.buildDate).toBeNull();
	});

	it('accepts the legacy BUILD_TIME name and normalizes placeholder SHAs to null', async () => {
		process.env.BUILD_SHA = 'unknown';
		delete process.env.BUILD_DATE;
		process.env.BUILD_TIME = '2026-01-01T00:00:00Z';
		const body = await liveBody();
		expect(body.buildSha).toBeNull();
		expect(body.buildDate).toBe('2026-01-01T00:00:00Z');
	});
});

describe('GET /api/health/ready', () => {
	beforeEach(() => {
		resetHub();
	});
	afterAll(() => {
		resetHub();
	});

	it('becomes ready once the schedulers have ticked and stays ready with DUMB offline', async () => {
		const hub = getHub(); // boots and arms the schedulers synchronously
		hub.start();

		// Before the first housekeeping tick: not ready yet (503 with details).
		const starting = await ready({} as never);
		if (hub.housekeepingHeartbeatMs === null) {
			expect(starting.status).toBe(503);
			const body = (await starting.json()) as { status: string; checks: { db: boolean } };
			expect(body.status).toBe('not-ready');
			expect(body.checks.db).toBe(true); // the database itself is fine
		}

		// Simulate the scheduler heartbeat (the 1s startup tick in production).
		hub.housekeep();
		const response = await ready({} as never);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			status: string;
			checks: { db: boolean; hub: boolean; scheduler: boolean };
			dumb: string;
		};
		expect(body.status).toBe('ready');
		expect(body.checks).toEqual({ db: true, hub: true, scheduler: true });
		// The test environment has no DUMB gateway: readiness is unaffected.
		expect(body.dumb).not.toBe('connected');
	});

	it('reports not-ready (503) when the housekeeping heartbeat goes stale', async () => {
		const hub = getHub();
		hub.start();
		hub.housekeep();
		// Freeze the heartbeat far past the 45s freshness window without
		// touching the database: only the scheduler check may fail.
		const stale = await ready({} as never);
		expect([200, 503]).toContain(stale.status);
		if (hub.housekeepingHeartbeatMs !== null && hub.housekeepingHeartbeatMs <= 45_000) {
			// Heartbeat still fresh in this run — force it stale through the
			// internal field and re-check.
			(hub as unknown as { lastHousekeepAt: number | null }).lastHousekeepAt = Date.now() - 120_000;
		}
		const response = await ready({} as never);
		expect(response.status).toBe(503);
		const body = (await response.json()) as {
			status: string;
			checks: { db: boolean; hub: boolean; scheduler: boolean };
		};
		expect(body.status).toBe('not-ready');
		expect(body.checks.db).toBe(true);
		expect(body.checks.hub).toBe(true);
		expect(body.checks.scheduler).toBe(false);
	});
});
