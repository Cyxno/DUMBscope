/**
 * Regression tests for ReconciliationRunner error isolation (production
 * incident 2026-09-17: one unreachable Arr raised an unhandled ArrError that
 * escaped `run()` → Node process exit → container restart loop → repeated
 * full library snapshots → 100% CPU + hot cache SSD).
 *
 * Contract under test:
 *   - an Arr timeout / connection refusal is caught per integration
 *   - the reconciliation cycle degrades (or suspends the diff), never crashes
 *   - repeated failures back off exponentially (bounded), reset on success
 *   - a failed integration never opens a new incident per poll (fingerprint
 *     dedupe via the existing incident engine)
 *   - the process survives ≥20 consecutive failed cycles
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { ReconciliationRunner, type ArrTarget, type ReconciliationRunnerOptions } from '../src/lib/server/reconciliation/cycle';
import type { ReconcileSettings } from '../src/lib/server/reconciliation/cycle';

const BASE_SETTINGS: ReconcileSettings = {
	enabled: true,
	mounts: [],
	aliases: [],
	plexDbPath: null,
	plexUrl: null,
	plexToken: null,
	plexAutoRefresh: false,
	selftestBrokenPath: null,
	selftestGhostPath: null
};

type Harness = {
	runner: ReconciliationRunner;
	targets: () => ArrTarget[];
	findings: ReturnType<typeof makeRecorder>;
	now: () => number;
	advance: (ms: number) => void;
};

function makeRecorder() {
	const reported: Array<{ fingerprint: string; title: string; summary: string }> = [];
	const resolved: string[] = [];
	return {
		reported,
		resolved,
		reportFinding: (f: { fingerprint: string; title: string; summary: string }) =>
			reported.push(f),
		resolveFinding: (fp: string) => resolved.push(fp)
	};
}

/** Assumed-success target source; tests override url/handler per scenario. */
function makeHarness(opts: { targets: ArrTarget[] }): Harness {
	const recorder = makeRecorder();
	let clock = 1_000_000_000;
	const runner = new ReconciliationRunner({
		getSettings: () => ({ ...BASE_SETTINGS }),
		...recorder,
		resolveArrTargets: () => opts.targets,
		now: () => clock
	} as ReconciliationRunnerOptions);
	return {
		runner,
		targets: () => opts.targets,
		findings: recorder,
		now: () => clock,
		advance: (ms: number) => {
			clock += ms;
		}
	};
}

let servers: Server[] = [];

beforeAll(() => {});
afterAll(() => {
	for (const s of servers) s.close();
	servers = [];
});

/** Minimal Sonarr/Radarr API mock. handler=null → accept and never respond. */
async function startArrMock(handler: ((req: IncomingMessage, res: ServerResponse) => void) | null): Promise<{
	url: string;
	requests: () => number;
	setHandler: (h: typeof handler) => void;
	}> {
	let count = 0;
	let current = handler;
	const server = createServer((req, res) => {
		count++;
		if (!current) return; // hang: exercises the client timeout path
		current(req, res);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		requests: () => count,
		setHandler: (h) => {
			current = h;
		}
	};
}

function arrJson(res: ServerResponse, body: unknown): void {
	res.writeHead(200, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

describe('ReconciliationRunner error isolation', () => {
	it('connection refused: run() resolves, process stays alive, one deduped degraded incident', async () => {
		// Port 1 on loopback: nothing listens there → immediate ECONNREFUSED.
		const h = makeHarness({
			targets: [{ id: 'sonarr-main', type: 'sonarr', url: 'http://127.0.0.1:1', apiKey: 'k' }]
		});
		await expect(h.runner.run()).resolves.toBeUndefined(); // no unhandled rejection
		expect(h.findings.reported).toHaveLength(1);
		expect(h.findings.reported[0].fingerprint).toBe('recon:arr-unavailable:sonarr-main');
		// Second failing cycle must refresh the SAME incident, not open a new one.
		h.advance(10 * 60_000);
		await h.runner.run();
		const fps = h.findings.reported.map((f) => f.fingerprint);
		expect(new Set(fps).size).toBe(1);
	});

	it('Arr timeout (slow response > client timeout): caught, cycle degrades, process alive', async () => {
		vi.setConfig({ testTimeout: 30_000 });
		const mock = await startArrMock(null); // accept connections, never respond
		const h = makeHarness({
			targets: [{ id: 'sonarr-slow', type: 'sonarr', url: mock.url, apiKey: 'k' }]
		});
		await expect(h.runner.run()).resolves.toBeUndefined();
		expect(h.findings.reported[0].fingerprint).toBe('recon:arr-unavailable:sonarr-slow');
		expect(h.findings.reported[0].summary).toContain('suspended');
	}, 30_000);

	it('per-integration isolation: Sonarr down (stale data) does not stop Radarr processing', async () => {
		const radarr = await startArrMock((req, res) => arrJson(res, [{ id: 1, title: 'Movie', hasFile: false }]));
		const sonarr = await startArrMock(null); // first call hangs → failure; then down
		const h = makeHarness({
			targets: [
				{ id: 'sonarr-main', type: 'sonarr', url: sonarr.url, apiKey: 'k' },
				{ id: 'radarr-main', type: 'radarr', url: radarr.url, apiKey: 'k' }
			]
		});
		// Widen test timeout for the single hanging first fetch below.
		vi.setConfig({ testTimeout: 30_000 });
		await h.runner.run(); // sonarr times out (degraded), radarr succeeded
		expect(h.findings.reported.map((f) => f.fingerprint)).toContain(
			'recon:arr-unavailable:sonarr-main'
		);
		// Later cycles: sonarr serves stale (never had data here → diff stays
		// suspended), radarr keeps being polled every allowed attempt.
		const before = radarr.requests();
		h.advance(10 * 60_000);
		await h.runner.run();
		expect(radarr.requests()).toBeGreaterThan(before);
	}, 30_000);

	it('one integration failing with stale cache keeps the full diff running', async () => {
		let sonarrUp = true;
		const sonarr = await startArrMock((req, res) => {
			if (!sonarrUp) {
				res.writeHead(500);
				res.end('down');
				return;
			}
			arrJson(res, []);
		});
		const radarr = await startArrMock((req, res) => arrJson(res, []));
		const h = makeHarness({
			targets: [
				{ id: 'sonarr-main', type: 'sonarr', url: sonarr.url, apiKey: 'k' },
				{ id: 'radarr-main', type: 'radarr', url: radarr.url, apiKey: 'k' }
			]
		});
		let statsCalls = 0;
		(h.runner as unknown as { options: ReconciliationRunnerOptions }).options.onStats = () => {
			statsCalls++;
		};
		await h.runner.run(); // both healthy → diff ran
		expect(statsCalls).toBe(1);

		// Sonarr goes down but has cached (stale) data: the diff must still run
		// on last-good data instead of being lost, and Radarr stays fresh.
		sonarrUp = false;
		h.advance(60_000);
		await h.runner.run();
		expect(statsCalls).toBe(2);
		expect(h.findings.reported.map((f) => f.fingerprint)).not.toContain(
			'recon:arr-unavailable:sonarr-main'
		); // stale data → no degraded incident, diff simply continued
	});

	it('backoff: retries are spaced out exponentially, bounded, and reset after recovery', async () => {
		let down = true;
		const mock = await startArrMock((req, res) => {
			if (down) {
				res.writeHead(500);
				res.end('boom');
				return;
			}
			arrJson(res, []);
		});
		const h = makeHarness({
			targets: [{ id: 'sonarr-main', type: 'sonarr', url: mock.url, apiKey: 'k' }]
		});
		// Five consecutive failures → request count grows exactly with attempts.
		const attempts: number[] = [];
		for (let i = 0; i < 5; i++) {
			if (i > 0) h.advance(10 * 60_000); // always past the backoff gate
			await h.runner.run();
			attempts.push(mock.requests());
		}
		// 500-responses fail fast, so every gated cycle attempted exactly once.
		expect(attempts).toEqual([1, 2, 3, 4, 5]);

		// Within the backoff window (last failure backed off 600s; 599s elapsed)
		// no request is made at all.
		down = false;
		const before = mock.requests();
		h.advance(599_000);
		await h.runner.run();
		expect(mock.requests()).toBe(before);

		// After the gate opens: success, backoff reset, degraded incident resolved.
		h.advance(10 * 60_000);
		await h.runner.run();
		expect(mock.requests()).toBe(before + 1);
		expect(h.findings.resolved).toContain('recon:arr-unavailable:sonarr-main');

		// Reset proven: an immediate follow-up run may poll again (no backoff).
		const after = mock.requests();
		await h.runner.run();
		expect(mock.requests()).toBe(after + 1);
	});

	it('restart storm: 20 consecutive failed cycles — process alive, bounded requests, bounded logs', async () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const mock = await startArrMock((req, res) => {
			res.writeHead(500);
			res.end('still down');
		});
		const h = makeHarness({
			targets: [{ id: 'sonarr-main', type: 'sonarr', url: mock.url, apiKey: 'k' }]
		});
		let unhandled: unknown[] = [];
		const onUnhandled = (err: unknown) => unhandled.push(err);
		process.on('unhandledRejection', onUnhandled);
		try {
			for (let i = 0; i < 20; i++) {
				await h.runner.run();
				h.advance(60_000); // 1 min scheduler cadence: backoff skips most polls
			}
			expect(process.exitCode ?? 0).not.toBe(1);
			expect(unhandled).toHaveLength(0);
			// Bounded: backoff gate (60s→120s→…→600s) allows far fewer HTTP
			// attempts than 20 cycles.
			expect(mock.requests()).toBeLessThan(20);
			// Bounded logging: one warning per actual attempt, no stack spam.
			expect(warnSpy.mock.calls.length).toBeLessThanOrEqual(mock.requests() + 2);
			expect(errorSpy.mock.calls).toHaveLength(0);
		} finally {
			process.off('unhandledRejection', onUnhandled);
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it('recovery: Sonarr returns → next allowed retry succeeds, no manual restart', async () => {
		let up = false;
		const mock = await startArrMock((req, res) => {
			if (!up) {
				res.writeHead(500);
				res.end('down');
				return;
			}
			arrJson(res, []);
		});
		const h = makeHarness({
			targets: [{ id: 'sonarr-main', type: 'sonarr', url: mock.url, apiKey: 'k' }]
		});
		await h.runner.run(); // fail #1
		up = true;
		h.advance(60_000); // past first backoff
		await h.runner.run(); // succeeds
		expect(h.findings.resolved).toContain('recon:arr-unavailable:sonarr-main');
		// State healthy: a subsequent cycle polls normally (no residual backoff).
		const before = mock.requests();
		await h.runner.run();
		expect(mock.requests()).toBe(before + 1);
	});

	it('startup hardening: full run with every Arr unavailable never throws and reports degraded', async () => {
		const h = makeHarness({
			targets: [
				{ id: 'sonarr-main', type: 'sonarr', url: 'http://127.0.0.1:1', apiKey: 'k' },
				{ id: 'radarr-main', type: 'radarr', url: 'http://127.0.0.1:2', apiKey: 'k' }
			]
		});
		await expect(h.runner.run()).resolves.toBeUndefined();
		expect(h.findings.reported.map((f) => f.fingerprint)).toEqual([
			'recon:arr-unavailable:sonarr-main',
			'recon:arr-unavailable:radarr-main'
		]);
	});
});
