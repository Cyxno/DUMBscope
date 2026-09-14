/**
 * FASE A — connectivity reliability.
 *
 * Production incident (2026-09-13, DUMBscope 0.3.0): a critical "DUMB gateway
 * unreachable" incident opened at 09:14 while the DUMB gateway was healthy and
 * answering /api/health, and stayed active for 8+ hours, re-confirmed every
 * housekeeping tick. Root cause: the hub's connection state had multiple
 * independent writers. A failed REST bootstrap unconditionally forced
 * state='offline' and clobbered the (live) stream flags, while a later
 * successful bootstrap only patched the rest flag and never recomputed the
 * overall state. With the streams quietly live, no further stream transition
 * ever fired, so the false offline state (and its incident) stuck forever.
 *
 * These tests reproduce that sequence deterministically (fake WebSocket +
 * stubbed fetch) and pin the fixed behaviour: one derived state machine,
 * honest partial states, bounded startup grace, automatic recovery.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hub } from '../src/lib/server/telemetry/hub';
import { ConnectivityTracker, classifyProbeError } from '../src/lib/server/dumb/connection';
import { setDumbCredentials, setDumbUrl } from '../src/lib/server/config/settings';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const WS_OPEN = 1;
const WS_CLOSED = 3;

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	static reset(): void {
		FakeWebSocket.instances = [];
	}

	readyState = 0;
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onerror: (() => void) | null = null;
	onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
	sent: string[] = [];

	constructor(public url: string) {
		FakeWebSocket.instances.push(this);
	}

	get streamName(): string {
		return new URL(this.url).pathname.split('/').pop() ?? '';
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(code = 1000): void {
		this.readyState = WS_CLOSED;
		this.onclose?.({ code });
	}

	// -- test helpers --------------------------------------------------------
	open(): void {
		this.readyState = WS_OPEN;
		this.onopen?.();
	}

	message(data: unknown): void {
		this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
	}

	drop(code = 1006): void {
		this.readyState = WS_CLOSED;
		this.onerror?.();
		this.onclose?.({ code });
	}
}

type FetchMode = 'down' | 'up' | 'auth-fail' | 'http-500' | 'timeout';
let fetchMode: FetchMode = 'up';

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

const PROCESSES = {
	processes: [
		{ config_key: 'dumb-frontend', name: 'DUMB Frontend', process_name: 'DUMB-Frontend' },
		{ config_key: 'sonarr', name: 'Sonarr', process_name: 'Sonarr' },
		{ config_key: 'infinidysk', name: 'InfiniDysk', process_name: 'InfiniDysk' }
	]
};

async function fakeFetch(url: string | URL): Promise<Response> {
	const path = new URL(url.toString()).pathname;
	await Promise.resolve();
	switch (fetchMode) {
		case 'down':
			throw new TypeError('fetch failed');
		case 'timeout': {
			const err = new Error('aborted');
			err.name = 'AbortError';
			throw err;
		}
		case 'auth-fail':
			if (path === '/api/auth/login') return jsonResponse(401, { detail: 'bad credentials' });
			return jsonResponse(200, { enabled: true, mode: 'local' });
		case 'http-500':
			if (path === '/api/health' || path === '/api/auth/status')
				return jsonResponse(503, { detail: 'starting up' });
			return jsonResponse(
				200,
				path === '/api/auth/login' ? { access_token: 't', refresh_token: 'r' } : PROCESSES
			);
		case 'up':
			if (path === '/api/health') return jsonResponse(200, { status: 'healthy' });
			if (path === '/api/auth/status') return jsonResponse(200, { enabled: true, mode: 'local' });
			if (path === '/api/auth/login' || path === '/api/auth/refresh')
				return jsonResponse(200, { access_token: 't', refresh_token: 'r' });
			if (path === '/api/process/processes') return jsonResponse(200, PROCESSES);
			if (path === '/api/process/capabilities') return jsonResponse(200, {});
			return jsonResponse(404, { detail: 'not found' });
	}
}

function stream(name: string): FakeWebSocket | undefined {
	return FakeWebSocket.instances.filter((ws) => ws.streamName === name).at(-1);
}

/** Drain the microtask/macrotask queue so async bootstrap chains complete. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

function housekeep(hub: Hub): void {
	hub.housekeep();
}

const hubs: Hub[] = [];

// ---------------------------------------------------------------------------
// Hub-level repro
// ---------------------------------------------------------------------------

describe('connectivity: sticky false-offline after a reboot (production repro)', () => {
	beforeEach(() => {
		FakeWebSocket.reset();
		vi.stubGlobal('WebSocket', FakeWebSocket);
		vi.stubGlobal('fetch', vi.fn(fakeFetch as typeof fetch));
		setDumbUrl('http://mock-dumb.test');
		setDumbCredentials({ username: 'admin', password: 'secret' });
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(async () => {
		for (const hub of hubs) hub.stop();
		hubs.length = 0;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('A: a failing REST bootstrap while streams are live must not force offline — and a later success must restore the connection', async () => {
		fetchMode = 'down';
		const hub = new Hub();
		hubs.push(hub);
		hub.start();
		await settle();

		// DUMB's gateway starts accepting WebSocket upgrades before its REST
		// layer answers (both observed after a reboot). The status and metrics
		// streams connect and data flows.
		const status = stream('status');
		expect(status).toBeDefined();
		status!.open();
		stream('metrics')!.open();

		expect(hub.getConnection().state).toBe('live');

		// A background REST bootstrap is still failing (in-flight retry /
		// discovery refresh racing the recovery). It must not clobber the
		// live state...
		housekeep(hub);
		await settle();
		expect(hub.getConnection().state).not.toBe('offline');
		expect(hub.getConnection().streams.status).toBe('live');

		// ...and once REST succeeds too, the hub must report live again —
		// without any stream transition or manual reload.
		fetchMode = 'up';
		housekeep(hub);
		await settle();
		expect(hub.getConnection().state).toBe('live');
		expect(hub.getConnection().streams.rest).toBe('live');
	});

	it('B: REST reachable but WebSocket unavailable must report a degraded partial state, not stick on reconnecting', async () => {
		fetchMode = 'up';
		const hub = new Hub();
		hubs.push(hub);
		hub.start();
		await settle();

		expect(hub.getConnection().streams.rest).toBe('live');
		// The WS endpoints never connect (gateway serving REST only).
		const status = stream('status');
		expect(status).toBeDefined();
		status!.drop();
		await settle();

		expect(hub.getConnection().state).toBe('degraded');
		expect(hub.getConnection().probes.rest.status).toBe('ok');
		expect(hub.getConnection().probes.http.status).toBe('ok');
		expect(hub.getConnection().probes.auth.status).toBe('ok');
	});
});

// ---------------------------------------------------------------------------
// Connectivity matrix (brief §13/§144): the pure state machine under a
// controlled clock — boot grace, recovery grace, partial states, hysteresis.
// ---------------------------------------------------------------------------

describe('connectivity tracker: state machine matrix', () => {
	let now: number;
	let tracker: ConnectivityTracker;

	function tick(ms: number): void {
		now += ms;
	}

	beforeEach(() => {
		now = 1_000_000;
		tracker = new ConnectivityTracker({
			now: () => now,
			startupGraceMs: 120_000,
			recoveryGraceMs: 90_000,
			staleAfterMs: 90_000
		});
		tracker.setConfigured(true);
	});

	it('is unconfigured without a DUMB URL', () => {
		const t = new ConnectivityTracker({ now: () => now });
		expect(t.snapshot().state).toBe('unconfigured');
	});

	it('C: DUMB offline at startup stays amber (starting) during the grace window, then goes offline', () => {
		tracker.probe('http', { ok: false, code: 'refused', detail: 'connection refused' });
		tracker.probe('rest', { ok: false, code: 'refused', detail: 'connection refused' });
		expect(tracker.snapshot().state).toBe('starting');

		tick(30_000); // DUMB still booting after a host reboot
		expect(tracker.snapshot().state).toBe('starting');

		tick(91_000); // past the 120s startup grace
		expect(tracker.snapshot().state).toBe('offline');
	});

	it('C: DUMB coming online mid-grace exits immediately — no fixed delay', () => {
		tracker.probe('rest', { ok: false, code: 'refused', detail: 'connection refused' });
		tick(60_000);
		expect(tracker.snapshot().state).toBe('starting');

		// The gateway starts answering and the streams connect.
		tracker.probe('rest', { ok: true });
		tracker.streamState('status', 'live');
		tracker.streamState('metrics', 'live');
		expect(tracker.snapshot().state).toBe('live');
		expect(tracker.snapshot().lastSuccessAt).toBe(now);
	});

	it('D: losing one core stream is degraded (partial); losing both starts the bounded recovery window', () => {
		tracker.probe('rest', { ok: true });
		tracker.streamState('status', 'live');
		tracker.streamState('metrics', 'live');
		expect(tracker.snapshot().state).toBe('live');

		tick(10_000);
		tracker.streamState('metrics', 'reconnecting');
		expect(tracker.snapshot().state).toBe('degraded');
		expect(tracker.snapshot().lastSuccessAt).toBe(now - 10_000);

		// The last core stream drops too: full loss, recovery clock starts.
		tracker.streamState('status', 'reconnecting');
		expect(tracker.snapshot().state).toBe('reconnecting');

		tick(89_000); // still inside 90s recovery grace
		expect(tracker.snapshot().state).toBe('reconnecting');
		tick(2_000); // past it
		expect(tracker.snapshot().state).toBe('offline');
	});

	it('D: WebSocket reconnect restores live and clears the recovery state', () => {
		tracker.probe('rest', { ok: true });
		tracker.streamState('status', 'live');
		tracker.streamState('metrics', 'live');
		tick(5_000);
		tracker.streamState('status', 'reconnecting');
		tracker.streamState('metrics', 'reconnecting');
		tracker.setLastError('connection closed (1006)');
		expect(tracker.snapshot().state).toBe('reconnecting');

		tick(2_000);
		tracker.streamState('status', 'live');
		tracker.streamState('metrics', 'live');
		const snap = tracker.snapshot();
		expect(snap.state).toBe('live');
		expect(snap.lastError).toBe('connection closed (1006)');
	});

	it('reports degraded when only one core stream delivers (honest partial)', () => {
		tracker.probe('rest', { ok: true });
		tracker.streamState('status', 'live');
		expect(tracker.snapshot().state).toBe('degraded');
	});

	it('goes stale when connected but telemetry freezes', () => {
		tracker.probe('rest', { ok: true });
		tracker.streamState('status', 'live');
		tracker.streamState('metrics', 'live');
		tracker.dataReceived(now);
		expect(tracker.snapshot().state).toBe('live');

		tick(91_000);
		expect(tracker.snapshot().state).toBe('stale');

		// Data resumes → live again (stale is never sticky).
		tracker.dataReceived(now);
		expect(tracker.snapshot().state).toBe('live');
	});

	it('treats an authentication wall as credentials-invalid, and a later REST success as recovered', () => {
		tracker.probe('http', { ok: true });
		tracker.noteCredentialsInvalid('DUMB rejected the stored credentials');
		expect(tracker.snapshot().state).toBe('credentials-invalid');

		tracker.probe('rest', { ok: true });
		tracker.streamState('status', 'live');
		tracker.streamState('metrics', 'live');
		expect(tracker.snapshot().state).toBe('live');
	});

	it('does not flap: transient probe failures never take down a live connection', () => {
		tracker.probe('rest', { ok: true });
		tracker.streamState('status', 'live');
		tracker.streamState('metrics', 'live');

		for (let i = 0; i < 5; i++) {
			tracker.probe('rest', { ok: false, code: 'http-error', detail: 'HTTP 503' });
			tracker.streamState('logs', 'reconnecting');
			expect(tracker.snapshot().state).toBe('live');
			tracker.probe('rest', { ok: true });
			tick(1_000);
		}
	});

	it('never reports offline without evidence after a hub restart with prior contact', () => {
		tracker.probe('rest', { ok: true });
		tracker.streamState('status', 'live');
		tracker.streamState('metrics', 'live');
		tick(60_000);

		// Stale-bounce reload: sockets drop, contact history is preserved.
		tracker.hubRestart();
		expect(tracker.snapshot().state).toBe('reconnecting');

		tick(91_000); // recovery grace expired with failing probes → honest offline
		tracker.probe('rest', { ok: false, code: 'refused', detail: 'connection refused' });
		expect(tracker.snapshot().state).toBe('offline');
	});
});

describe('probe error classification', () => {
	it('classifies refused, DNS, timeout, network and HTTP failures', () => {
		const refused = new Error('fetch failed');
		(refused as Error & { cause: Error }).cause = Object.assign(new Error('refused'), {
			code: 'ECONNREFUSED'
		});
		expect(classifyProbeError(refused)).toEqual({
			code: 'refused',
			detail: 'connection refused'
		});

		const dns = new Error('fetch failed');
		(dns as Error & { cause: Error }).cause = Object.assign(new Error('dns'), {
			code: 'ENOTFOUND'
		});
		expect(classifyProbeError(dns).code).toBe('dns');

		const timeout = new Error('aborted');
		timeout.name = 'AbortError';
		expect(classifyProbeError(timeout)).toEqual({ code: 'timeout', detail: 'request timed out' });

		expect(classifyProbeError(Object.assign(new Error('nope'), { status: 503 })).detail).toBe(
			'HTTP 503'
		);
		expect(classifyProbeError(Object.assign(new Error('nope'), { status: 401 })).code).toBe(
			'auth-rejected'
		);
	});
});

// ---------------------------------------------------------------------------
// Hub + incident engine end-to-end (brief §8/§12/§196): amber during boot,
// critical only after sustained multi-probe failure, automatic recovery.
// ---------------------------------------------------------------------------

describe('connectivity: startup grace and automatic incident recovery', () => {
	beforeEach(() => {
		FakeWebSocket.reset();
		vi.stubGlobal('WebSocket', FakeWebSocket);
		vi.stubGlobal('fetch', vi.fn(fakeFetch as typeof fetch));
		setDumbUrl('http://mock-dumb.test');
		setDumbCredentials({ username: 'admin', password: 'secret' });
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		for (const hub of hubs) hub.stop();
		hubs.length = 0;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('E: a boot-time outage stays amber first, pages only after sustained failure, and auto-resolves on recovery', async () => {
		let clock = 1_000_000;
		fetchMode = 'down';
		const hub = new Hub({ testClock: () => clock });
		hubs.push(hub);
		hub.start();
		await settle();

		// DUMB is booting: amber, never a red incident (brief §12).
		hub.housekeep();
		expect(hub.getConnection().state).toBe('starting');
		expect(hub.getActiveIncidents()).toHaveLength(0);

		// Past the startup grace with probes still failing: honest offline…
		clock += 130_000;
		hub.housekeep();
		await settle();
		expect(hub.getConnection().state).toBe('offline');
		expect(hub.getActiveIncidents()).toHaveLength(0); // engine debounce window

		// …and only after the engine's own sustained-failure grace: critical.
		clock += 20_000;
		hub.housekeep();
		const active = hub.getActiveIncidents();
		expect(active).toHaveLength(1);
		expect(active[0]!.title).toBe('DUMB gateway unreachable');

		// DUMB comes online: streams reconnect and data flows…
		fetchMode = 'up';
		stream('status')!.open();
		stream('metrics')!.open();
		expect(hub.getConnection().state).toBe('live');

		// …and the incident resolves itself — no browser reload, no manual
		// refresh (brief §8/§214). The engine requires the live state to be
		// sustained past its resolve window first.
		clock += 31_000;
		hub.housekeep();
		clock += 31_000;
		hub.housekeep();
		expect(hub.getActiveIncidents()).toHaveLength(0);
		const resolved = hub.getActiveIncidents().every((i) => i.status !== 'active');
		expect(resolved).toBe(true);
	});

	it('F: a successful REST bootstrap during stream backoff bounces the streams for fast recovery', async () => {
		fetchMode = 'down';
		const hub = new Hub();
		hubs.push(hub);
		hub.start();
		await settle();
		const initialWsCount = FakeWebSocket.instances.length;

		// The status stream fails once; its reconnect timer fires ~0.5-1s
		// later and the retry fails too — the stream is now waiting in
		// exponential backoff ('reconnecting').
		stream('status')!.drop();
		await new Promise((r) => setTimeout(r, 1_200));
		expect(stream('status')).not.toBe(FakeWebSocket.instances[initialWsCount - 3]);
		expect(
			hub.getConnection().streams.status === 'reconnecting' || stream('status')!.readyState === 0
		).toBe(true);

		// The gateway comes back: REST bootstrap succeeds.
		fetchMode = 'up';
		hub.housekeep();
		await settle();

		// Recovery acceleration: fresh sockets were created immediately
		// instead of waiting out the remaining backoff.
		expect(FakeWebSocket.instances.length).toBeGreaterThan(initialWsCount);
		expect(hub.getConnection().state).not.toBe('offline');
	}, 15_000);
});
