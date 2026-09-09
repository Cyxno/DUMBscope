/**
 * Integration tests: run the real DumbClient + DumbStream against the mock
 * DUMB gateway (documented API contract) — no real DUMB installation needed.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { DumbClient, DumbAuthError } from '../src/lib/server/dumb/client';
import { DumbStream } from '../src/lib/server/dumb/streams';

const PORT = 3125;

let mock: ChildProcess | null = null;

async function startMock(): Promise<void> {
	mock = spawn(process.execPath, ['tests/mock-dumb/server.mjs'], {
		env: { ...process.env, MOCK_PORT: String(PORT), MOCK_INTERVAL: '200' },
		stdio: 'ignore'
	});
	// Wait for the health endpoint to answer.
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (response.ok) return;
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error('mock DUMB did not start');
}

afterAll(async () => {
	mock?.kill();
	mock = null;
});

function client(): DumbClient {
	return new DumbClient({
		baseUrl: `http://127.0.0.1:${PORT}`,
		getCredentials: () => ({ username: 'admin', password: 'mockpassword' })
	});
}

describe('DumbClient against the mock gateway', () => {
	it('logs in, fetches processes and capabilities', { timeout: 30_000 }, async () => {
		await startMock();
		const c = client();
		expect(c.hasTokens).toBe(false);

		const processes = await (async () => {
			await c.ensureAuthenticated();
			return c.processes();
		})();

		expect(Array.isArray(processes.processes)).toBe(true);
		expect(processes.processes!.length).toBeGreaterThanOrEqual(10);

		const caps = await c.capabilities();
		expect(caps['startup_lifecycle']).toBe(true);
	});

	it('rejects wrong credentials with DumbAuthError', { timeout: 30_000 }, async () => {
		await startMock();
		const c = new DumbClient({
			baseUrl: `http://127.0.0.1:${PORT}`,
			getCredentials: () => null
		});
		await expect(c.loginWith('admin', 'wrong')).rejects.toBeInstanceOf(DumbAuthError);
	});

	it('transparently refreshes an expired access token', { timeout: 30_000 }, async () => {
		await startMock();
		const c = client();
		await c.ensureAuthenticated();
		// Corrupt the access token so the next call 401s and the client must
		// refresh (or re-login) before succeeding.
		c.setTokens({ accessToken: 'invalid.token.value', refreshToken: null });
		const processes = await c.processes();
		expect(processes.processes!.length).toBeGreaterThan(0);
	});

	it('reads a log chunk with a cursor payload', { timeout: 30_000 }, async () => {
		await startMock();
		const c = client();
		await c.ensureAuthenticated();
		const chunk = await c.logsChunk('Sonarr');
		expect(chunk.chunk).toBeTruthy();
		expect(typeof chunk.cursor).toBe('number');
	});
});

describe('DumbStream against the mock gateway', () => {
	it(
		'connects with auth, receives status payloads and reports live',
		{ timeout: 30_000 },
		async () => {
			await startMock();
			const c = client();
			await c.ensureAuthenticated();

			const states: string[] = [];
			const received: { payload: { type: string; processes?: unknown[] } | null } = {
				payload: null
			};
			const stream = new DumbStream({
				name: 'status',
				url: () => c.wsUrl('/ws/status', { health: 'true' }),
				onMessage: (data) => {
					try {
						received.payload = JSON.parse(data);
					} catch {
						// ignore
					}
				},
				onStateChange: (state) => states.push(state),
				staleAfterMs: 60_000
			});
			stream.start();

			const deadline = Date.now() + 10_000;
			while (
				Date.now() < deadline &&
				(received.payload === null || received.payload.processes === undefined)
			) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			stream.stop();

			expect(received.payload).not.toBeNull();
			expect(received.payload!.type).toBe('status');
			expect(Array.isArray(received.payload!.processes)).toBe(true);
			expect(states).toContain('live');
		}
	);

	it('survives a malformed payload without dying', { timeout: 30_000 }, async () => {
		await startMock();
		const c = client();
		await c.ensureAuthenticated();
		let live = false;
		let errors = 0;
		const stream = new DumbStream({
			name: 'logs',
			url: () => c.wsUrl('/ws/logs'),
			onMessage: (data) => {
				if (data === 'not-json') errors += 1;
			},
			onStateChange: (state) => {
				if (state === 'live') live = true;
			},
			staleAfterMs: 60_000
		});
		stream.start();
		// The logs stream sends plain text (never JSON) — the hub tolerates it.
		await new Promise((resolve) => setTimeout(resolve, 1500));
		stream.stop();
		expect(live).toBe(true);
		void errors;
	});
});
