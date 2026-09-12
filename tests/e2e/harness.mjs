#!/usr/bin/env node
/**
 * E2E harness: boots an isolated DUMBscope stack, runs the Playwright suite,
 * tears everything down.
 *
 *   1. mock DUMB gateway (tests/mock-dumb/server.mjs, healthy scenario)
 *   2. production build of the app (node build/index.js) against the mock,
 *      with a throwaway config dir and pinned setup code
 *   3. automated setup (begin → test-dumb → complete) + authenticated login,
 *      stored as Playwright storageState for the specs
 *   4. waits until the live DUMB connection has populated the registry
 *   5. `playwright test`
 *
 * QA demo overrides are enabled here explicitly (PUBLIC_QA_DEMOS=1); the
 * release build ships with them disabled — see src/lib/pipeline/demo.ts.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MOCK_PORT = 3105;
const APP_PORT = 4173;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const SETUP_CODE = 'EEEE-EEEE';
const ADMIN = { username: 'e2eadmin', password: 'e2e-password-123' };

const children = [];
let configDir;
let exitCode = 0;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 60) {
	for (let i = 0; i < tries; i++) {
		try {
			const res = await fetch(url);
			if (res.ok) return res;
		} catch {
			// not up yet
		}
		await wait(500);
	}
	throw new Error(`not reachable: ${url}`);
}

function start(name, command, args, env) {
	const child = spawn(command, args, {
		cwd: root,
		env: { ...process.env, ...env },
		stdio: 'inherit'
	});
	children.push({ name, child });
	return child;
}

function cookieHeader(res) {
	return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

/** Register the mock media integrations so library pollers start. */
async function registerMediaIntegrations(cookie) {
	const headers = { 'content-type': 'application/json', cookie };
	const targets = [
		{ type: 'sonarr', url: 'http://127.0.0.1:4211' },
		{ type: 'radarr', url: 'http://127.0.0.1:4212' },
		{ type: 'bazarr', url: 'http://127.0.0.1:4213' }
	];
	for (const target of targets) {
		const created = await fetch(`${APP_URL}/api/integrations`, {
			method: 'POST',
			headers,
			body: JSON.stringify(target)
		});
		if (!created.ok)
			throw new Error(`integrations POST failed: ${created.status} ${await created.text()}`);
		const { config } = await created.json();
		const keyed = await fetch(`${APP_URL}/api/integrations/${config.id}/key`, {
			method: 'PUT',
			headers,
			body: JSON.stringify({ apiKey: 'media-test-key' })
		});
		if (!keyed.ok) throw new Error(`integrations key failed: ${keyed.status}`);
	}
}

async function setupAndLogin() {
	// begin: exchange the pinned setup code for a setup session cookie
	const begin = await fetch(`${APP_URL}/api/setup/begin`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ code: SETUP_CODE })
	});
	if (!begin.ok) throw new Error(`setup/begin failed: ${begin.status}`);
	const headers = { 'content-type': 'application/json', cookie: cookieHeader(begin) };

	const test = await fetch(`${APP_URL}/api/setup/test-dumb`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ url: MOCK_URL, username: 'admin', password: 'mockpassword' })
	});
	if (!test.ok) throw new Error(`setup/test-dumb failed: ${test.status} ${await test.text()}`);

	const complete = await fetch(`${APP_URL}/api/setup/complete`, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			url: MOCK_URL,
			username: 'admin',
			password: 'mockpassword',
			adminUsername: ADMIN.username,
			adminPassword: ADMIN.password
		})
	});
	if (!complete.ok)
		throw new Error(`setup/complete failed: ${complete.status} ${await complete.text()}`);

	const login = await fetch(`${APP_URL}/api/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ username: ADMIN.username, password: ADMIN.password })
	});
	if (!login.ok) throw new Error(`login failed: ${login.status}`);
	return login;
}

async function waitUntilReady(sessionCookie) {
	for (let i = 0; i < 60; i++) {
		const snap = await fetch(`${APP_URL}/api/snapshot`, {
			headers: { cookie: sessionCookie }
		});
		let libraryOk = false;
		const lib = await fetch(`${APP_URL}/api/library`, {
			headers: { cookie: sessionCookie }
		}).catch(() => null);
		if (lib?.ok) {
			const lv = await lib.json();
			libraryOk =
				lv.availability?.tv === 'available' &&
				lv.availability?.movies === 'available' &&
				lv.availability?.subtitles === 'available' &&
				(lv.summary?.tv?.upgrades ?? 0) > 0;
		}
		if (snap.ok) {
			const data = await snap.json();
			if (
				data.services.length >= 10 &&
				data.topology.nodes.length >= 10 &&
				data.connection.state === 'live' &&
				libraryOk
			) {
				return;
			}
		}
		await wait(1000);
	}
	// Diagnostics before giving up: integration states + library availability.
	const diagStatus = await fetch(`${APP_URL}/api/integrations`, {
		headers: { cookie: sessionCookie }
	}).then((r) => r.json());
	for (const i of diagStatus.integrations ?? []) {
		console.error(
			`[e2e][diag] ${i.config.type} state=${i.status?.state} err=${i.status?.lastError ?? '-'}`
		);
	}
	const diagLib = await fetch(`${APP_URL}/api/library`, {
		headers: { cookie: sessionCookie }
	}).then((r) => r.json());
	console.error(`[e2e][diag] availability=${JSON.stringify(diagLib.availability)}`);
	throw new Error('environment did not become ready in time');
}

function writeAuthState(login) {
	const cookies = (login.headers.getSetCookie?.() ?? []).map((c) => {
		const [pair] = c.split(';');
		const eq = pair.indexOf('=');
		return {
			name: pair.slice(0, eq),
			value: pair.slice(eq + 1),
			domain: '127.0.0.1',
			path: '/',
			expires: -1,
			httpOnly: true,
			secure: false,
			sameSite: 'Lax'
		};
	});
	const authDir = path.join(root, 'tests/e2e/.auth');
	fs.mkdirSync(authDir, { recursive: true });
	fs.writeFileSync(
		path.join(authDir, 'state.json'),
		JSON.stringify({ cookies, origins: [] }, null, 2)
	);
}

function shutdown() {
	for (const { child } of children) {
		try {
			child.kill('SIGTERM');
		} catch {
			// already gone
		}
	}
	if (configDir) {
		try {
			fs.rmSync(configDir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}
}

try {
	configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-e2e-'));

	start('mock-dumb', process.execPath, ['tests/mock-dumb/server.mjs'], {
		MOCK_PORT: String(MOCK_PORT),
		MOCK_SCENARIO: 'healthy'
	});
	await waitFor(`${MOCK_URL}/api/health`);

	// Mock media stack (Sonarr/Radarr/Bazarr roles) for library intelligence.
	const mediaPorts = { sonarr: 4211, radarr: 4212, bazarr: 4213 };
	for (const [role, port] of Object.entries(mediaPorts)) {
		start(`mock-media-${role}`, process.execPath, ['tests/mock-media/server.mjs'], {
			MOCK_ROLE: role,
			MOCK_PORT: String(port),
			MOCK_MEDIA_KEY: 'media-test-key'
		});
		const statusPath = '/health';
		await waitFor(`http://127.0.0.1:${port}${statusPath}`);
	}

	start('app', process.execPath, ['build/index.js'], {
		PORT: String(APP_PORT),
		HOST: '127.0.0.1',
		DUMBSCOPE_CONFIG_DIR: configDir,
		DUMBSCOPE_SETUP_CODE: SETUP_CODE,
		DUMB_URL: MOCK_URL,
		PUBLIC_QA_DEMOS: '1'
	});
	await waitFor(`${APP_URL}/api/health`);

	const login = await setupAndLogin();
	await registerMediaIntegrations(cookieHeader(login));
	await waitUntilReady(cookieHeader(login));
	writeAuthState(login);
	console.log('[e2e] environment ready — running Playwright');

	const test = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test'], {
		cwd: root,
		stdio: 'inherit',
		env: process.env
	});
	children.push({ name: 'playwright', child: test });
	exitCode = await new Promise((resolve) => test.on('exit', resolve));
} catch (err) {
	console.error('[e2e] harness failed:', err.message);
	exitCode = 1;
} finally {
	shutdown();
}
process.exit(exitCode);
