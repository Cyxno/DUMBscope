#!/usr/bin/env node
/**
 * Screenshot lab: boots the e2e mock stack (mock DUMB + mock media services +
 * production build) with throwaway state, walks the automated setup, and
 * captures documentation screenshots with fictional data only.
 *
 *   node scripts/screenshot-lab.mjs [outdir]
 *
 * The stack is fully torn down afterwards. No real services, no real data.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadChromium() {
	// pnpm keeps transitive deps inside the .pnpm store — resolve explicitly.
	const entry = path.join(
		root,
		'node_modules/.pnpm/playwright-core@1.63.0/node_modules/playwright-core/index.mjs'
	);
	return (await import(entry)).chromium;
}

const MOCK_PORT = 3105;
const APP_PORT = 4233;
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}`;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const SETUP_CODE = 'EEEE-EEEE';
const ADMIN = { username: 'shots', password: 'shots-password-123' };
const OUT = path.resolve(process.argv[2] ?? 'docs/screenshots');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function start(name, args, env) {
	const child = spawn(process.execPath, args, {
		cwd: root,
		env: { ...process.env, ...env },
		stdio: 'ignore'
	});
	children.push(child);
	return child;
}

async function waitFor(url, tries = 60) {
	for (let i = 0; i < tries; i++) {
		try {
			const res = await fetch(url);
			if (res.ok) return;
		} catch {
			/* not up yet */
		}
		await wait(500);
	}
	throw new Error(`not reachable: ${url}`);
}

function cookieHeader(res) {
	return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

async function setupAndLogin() {
	const begin = await fetch(`${APP_URL}/api/setup/begin`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ code: SETUP_CODE })
	});
	const headers = { 'content-type': 'application/json', cookie: cookieHeader(begin) };
	await fetch(`${APP_URL}/api/setup/test-dumb`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ url: MOCK_URL, username: 'admin', password: 'mockpassword' })
	});
	await fetch(`${APP_URL}/api/setup/complete`, {
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
	const login = await fetch(`${APP_URL}/api/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(ADMIN)
	});
	if (!login.ok) throw new Error('login failed');
	return cookieHeader(login);
}

async function main() {
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-shots-'));
	const mountFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-shots-mount-'));
	for (let show = 0; show < 2; show++) {
		const dir = path.join(mountFixture, `Show ${show}`, 'Season 1');
		fs.mkdirSync(dir, { recursive: true });
		for (let link = 0; link < 6; link++) {
			fs.symlinkSync(path.join(mountFixture, 'real.txt'), path.join(dir, `ep.${show}.${link}.mkv`));
		}
	}
	fs.writeFileSync(path.join(mountFixture, 'real.txt'), 'x');

	start('mock-dumb', ['tests/mock-dumb/server.mjs'], {
		MOCK_PORT: String(MOCK_PORT),
		MOCK_SCENARIO: 'healthy'
	});
	await waitFor(`${MOCK_URL}/api/health`);
	for (const [role, port] of Object.entries({ sonarr: 4211, radarr: 4212, bazarr: 4213 })) {
		start('mock-media-' + role, ['tests/mock-media/server.mjs'], {
			MOCK_ROLE: role,
			MOCK_PORT: String(port),
			MOCK_MEDIA_KEY: 'media-test-key'
		});
		await waitFor(`http://127.0.0.1:${port}/health`);
	}
	start('app', ['build/index.js'], {
		PORT: String(APP_PORT),
		HOST: '127.0.0.1',
		DUMBSCOPE_CONFIG_DIR: configDir,
		DUMBSCOPE_SETUP_CODE: SETUP_CODE,
		DUMB_URL: MOCK_URL,
		DUMBSCOPE_RELIABILITY_FAST: '1',
		DUMBSCOPE_MOUNTS: JSON.stringify([
			{
				id: 'tv-links',
				label: 'TV symlink root',
				path: mountFixture,
				kind: 'symlink-root',
				consumers: ['Plex Media Server', 'Sonarr', 'Bazarr']
			},
			{
				id: 'movie-links',
				label: 'Movies symlink root',
				path: mountFixture,
				kind: 'symlink-root',
				consumers: ['Plex Media Server', 'Radarr']
			}
		])
	});
	await waitFor(`${APP_URL}/api/health`);

	const cookie = await setupAndLogin();
	const headers = { 'content-type': 'application/json', cookie };
	for (const target of [
		{ type: 'sonarr', url: 'http://127.0.0.1:4211' },
		{ type: 'radarr', url: 'http://127.0.0.1:4212' },
		{ type: 'bazarr', url: 'http://127.0.0.1:4213' }
	]) {
		const created = await fetch(`${APP_URL}/api/integrations`, {
			method: 'POST',
			headers,
			body: JSON.stringify(target)
		});
		const { config } = await created.json();
		await fetch(`${APP_URL}/api/integrations/${config.id}/key`, {
			method: 'PUT',
			headers,
			body: JSON.stringify({ apiKey: 'media-test-key' })
		});
	}
	// Wait until the library payload is populated (availability all 'available').
	for (let i = 0; i < 60; i++) {
		const lib = await fetch(`${APP_URL}/api/library`, { headers }).then((r) => r.json());
		if (
			lib.availability?.tv === 'available' &&
			lib.availability?.movies === 'available' &&
			lib.availability?.subtitles === 'available'
		)
			break;
		await wait(1000);
	}

	const browser = await (await loadChromium()).launch({ headless: true });
	const context = await browser.newContext({
		viewport: { width: 1920, height: 1080 },
		baseURL: APP_URL
	});
	await context.addCookies([
		{ name: 'dumbscope_session', value: cookie.split('=')[1], url: APP_URL }
	]);
	const page = await context.newPage();

	const shots = {
		'overview-1920': '/',
		'pipeline-1920': '/pipeline',
		'services-1920': '/services',
		'incidents-1920': '/incidents',
		'activity-1920': '/activity',
		'logs-1920': '/logs',
		'system-1920': '/system',
		'library-tv-1920': '/library?view=tv',
		'library-movies-1920': '/library?view=movies',
		'library-subtitles-1920': '/library?view=subtitles',
		'settings-notifications-1920': '/settings'
	};
	for (const [name, urlPath] of Object.entries(shots)) {
		await page.goto(`${APP_URL}${urlPath}`, { waitUntil: 'load' });
		await page.waitForTimeout(2500);
		if (urlPath === '/settings') {
			await page
				.getByRole('navigation', { name: 'Settings sections' })
				.getByText('Notifications', { exact: true })
				.click();
			await page.waitForTimeout(800);
		}
		await page.screenshot({ path: path.join(OUT, `${name}.png`) });
		console.log('shot', name);
	}

	// Mobile shot.
	const mobile = await context.newPage();
	await mobile.setViewportSize({ width: 390, height: 844 });
	await mobile.goto(`${APP_URL}/library?view=tv`, { waitUntil: 'load' });
	await mobile.waitForTimeout(2000);
	await mobile.screenshot({ path: path.join(OUT, 'library-mobile-390.png') });
	console.log('shot library-mobile-390');

	await browser.close();
	await new Promise((resolve) => {
		for (const child of children) child.kill('SIGTERM');
		setTimeout(resolve, 500);
	});
	fs.rmSync(configDir, { recursive: true, force: true });
	fs.rmSync(mountFixture, { recursive: true, force: true });
	console.log('screenshot lab done ->', OUT);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	for (const child of children) child.kill('SIGTERM');
	process.exit(1);
});
