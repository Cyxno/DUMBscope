/**
 * API security surface (docs/SECURITY.md): regression net over de
 * global-hook guarantees. Runs against the real production server booted by
 * the harness. Named `z-*` so it runs after the functional specs — the login
 * rate-limit test consumes the shared per-IP bucket.
 *
 *  - every non-public /api route requires a session (401 otherwise)
 *  - health endpoints are the only public surface, with minimal payloads
 *  - mutating requests from a foreign origin are rejected (403, CSRF)
 *  - malformed bodies get clean 400s — never stack traces or internal paths
 *  - the login rate limit locks the source after repeated failures
 *  - the session cookie is HttpOnly + SameSite=Lax
 */
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/** Every read surface an anonymous visitor must NOT see. */
const SENSITIVE_GETS = [
	'/api/actions',
	'/api/activity',
	'/api/diagnostics',
	'/api/incidents',
	'/api/integrations',
	'/api/library',
	'/api/logs/history',
	'/api/media-flow',
	'/api/metrics/history',
	'/api/notifications/destinations',
	'/api/notifications/rules',
	'/api/observability',
	'/api/overview',
	'/api/reliability',
	'/api/runtime',
	'/api/settings',
	'/api/snapshot'
];

/** Bodies must never carry stack frames, module internals or host paths. */
function expectCleanErrorBody(body: string): void {
	expect(body).not.toMatch(/node:internal|at .*\(|file:\/\//);
	expect(body).not.toContain('/root/');
	expect(body).not.toContain('/app/');
}

test.describe('API security surface', () => {
	let anonymous: APIRequestContext;

	test.beforeAll(async ({ playwright, baseURL }) => {
		anonymous = await playwright.request.newContext({
			baseURL,
			// Explicitly cookie-free: prove the 401s come from the absence of a
			// session, not from an inherited jar.
			storageState: { cookies: [], origins: [] }
		});
	});

	test.afterAll(async () => {
		await anonymous.dispose();
	});

	test('health endpoints are public with minimal payloads', async ({ request }) => {
		const live = await request.get('/api/health/live');
		expect(live.status()).toBe(200);
		const liveBody = await live.json();
		expect(liveBody.status).toBe('live');
		expect(typeof liveBody.version).toBe('string');
		expect(Object.keys(liveBody).sort()).toEqual(['buildDate', 'buildSha', 'status', 'version']);

		const ready = await request.get('/api/health/ready');
		expect(ready.status()).toBe(200);
		const readyBody = await ready.json();
		expect(readyBody.status).toBe('ready');
		// Coarse booleans only — no inventory, no incidents, no configuration.
		expect(Object.keys(readyBody)).not.toEqual(
			expect.arrayContaining(['services', 'incidents', 'settings'])
		);
	});

	test(`every sensitive GET is 401 without a session (${SENSITIVE_GETS.length} routes)`, async () => {
		for (const path of SENSITIVE_GETS) {
			const res = await anonymous.get(path);
			expect(res.status(), path).toBe(401);
			expectCleanErrorBody(await res.text());
		}
	});

	test('sensitive writes are 401 without a session', async () => {
		for (const attempt of [
			{
				path: '/api/actions',
				body: { actionId: 'sonarr.searchEpisode', integrationId: 'x', target: {} }
			},
			{ path: '/api/settings', body: { theme: 'dark' } },
			{ path: '/api/incidents/clear-resolved', body: {} },
			{ path: '/api/integrations', body: { type: 'sonarr', url: 'http://127.0.0.1:1' } }
		]) {
			const res = await anonymous.post(attempt.path, { data: attempt.body });
			expect(res.status(), attempt.path).toBe(401);
			expectCleanErrorBody(await res.text());
		}
	});

	test('authenticated access to the same surface succeeds (the 401s are auth-driven)', async ({
		request
	}) => {
		for (const path of ['/api/actions', '/api/overview', '/api/settings', '/api/diagnostics']) {
			const res = await request.get(path);
			expect(res.status(), path).toBe(200);
		}
	});

	test('mutating requests from a foreign origin are rejected (CSRF defense)', async ({
		request
	}) => {
		const foreign = await request.patch('/api/settings', {
			data: { theme: 'light' },
			headers: { origin: 'https://evil.example' }
		});
		expect(foreign.status()).toBe(403);
		expectCleanErrorBody(await foreign.text());
		// The same request from the app's own origin passes the origin check
		// (400 for the invalid payload — the guard is origin-based, not
		// content-based).
		const own = await request.patch('/api/settings', {
			data: { theme: 'definitely-not-a-theme' },
			headers: { origin: 'http://127.0.0.1:4173' }
		});
		expect(own.status()).toBe(400);
	});

	test('malformed JSON gets a clean 400 — no stack traces, no internal paths', async ({
		request
	}) => {
		const res = await request.post('/api/actions', {
			data: 'not-json-at-all{',
			headers: { 'content-type': 'application/json' }
		});
		expect(res.status()).toBe(400);
		const body = await res.text();
		expectCleanErrorBody(body);
		expect(() => JSON.parse(body)).not.toThrow();
	});

	test('unknown action ids poll a bounded, secret-free endpoint', async ({ request }) => {
		const res = await request.get('/api/actions/00000000-0000-4000-8000-000000000000');
		expect(res.status()).toBe(404);
		const body = await res.json();
		expect(Object.keys(body)).toEqual(['error']);
	});

	test('the login rate limit locks the source after repeated failures', async () => {
		// The harness already used one slot of the per-IP bucket; hammer until
		// the limiter closes (429) — every answer before that must be 401.
		let saw429 = false;
		for (let attempt = 0; attempt < 12 && !saw429; attempt++) {
			const res = await anonymous.post('/api/auth/login', {
				data: { username: 'admin', password: 'definitely-wrong-password' }
			});
			const status = res.status();
			if (status === 429) {
				saw429 = true;
			} else {
				expect(status, `attempt ${attempt}`).toBe(401);
			}
		}
		expect(saw429).toBe(true);
		// The lockout is key-scoped, not credential-scoped: even the correct
		// password is rejected while the bucket is saturated.
		const bypass = await anonymous.post('/api/auth/login', {
			data: { username: 'shots', password: 'shots-password-123' }
		});
		expect(bypass.status()).toBe(429);
	});

	test('the persisted session cookie is HttpOnly and SameSite=Lax', async () => {
		const state = JSON.parse(readFileSync('tests/e2e/.auth/state.json', 'utf8') as string) as {
			cookies: { name: string; httpOnly: boolean; sameSite: string }[];
		};
		const session = state.cookies.find((c) => c.name === 'dumbscope_session');
		expect(session).toBeDefined();
		expect(session?.httpOnly).toBe(true);
		expect(session?.sameSite.toLowerCase()).toBe('lax');
	});
});
