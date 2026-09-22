import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Reliability core journeys (FASE B/C): the mount fixture (valid when the
 * harness boots) is broken by this spec — a mostly-broken symlink root must
 * open a systemic warning finding and resolve after repair — and a mock
 * process whose RSS jumps to 4.2 GB must open the memory finding and resolve
 * on recovery. Both run against the DUMBSCOPE_RELIABILITY_FAST clock (short
 * persistence windows, fast probe rounds); production defaults stay at the
 * documented values.
 */
const MOCK_URL = 'http://127.0.0.1:3105';
const FIXTURE_FILE = path.resolve('tests/e2e/.reliability-fixture.json');

interface Fixture {
	mountRoot: string;
}

function readFixture(): Fixture {
	return JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8')) as Fixture;
}

function rewriteLinks(root: string, targetFor: (show: number, link: number) => string): void {
	for (let show = 0; show < 2; show++) {
		const seasonPath = path.join(root, `Show ${show}`, 'Season 1');
		for (let link = 0; link < 6; link++) {
			const full = path.join(seasonPath, `ep.${show}.${link}.mkv`);
			fs.unlinkSync(full);
			fs.symlinkSync(targetFor(show, link), full);
		}
	}
}

async function setRss(name: string, bytes: number | null): Promise<void> {
	const res = await fetch(`${MOCK_URL}/__control/rss`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name, bytes })
	});
	if (!res.ok) throw new Error(`rss control failed: ${res.status}`);
}

/** The open-incidents section of the incidents page (default Active tab). */
function activeSection(page: Page) {
	return page.getByTestId('open-incidents');
}

test('mount health: broken symlink warning opens on System and resolves after repair', async ({
	page
}) => {
	test.setTimeout(150_000);
	const fixture = readFixture();

	await page.goto('/system');
	// Baseline: the valid fixture reports zero broken links.
	await expect(page.getByText('TV symlink root', { exact: true })).toBeVisible({
		timeout: 30_000
	});
	await expect(page.getByText(/links \d+ sampled/)).toBeVisible({ timeout: 30_000 });

	// Break 11 of 12 links (stale debrid targets — the production failure).
	const real = path.join(fixture.mountRoot, 'real.txt');
	rewriteLinks(fixture.mountRoot, (show, link) =>
		show * 6 + link < 11 ? `/nonexistent/debrid/${show}/${link}` : real
	);

	// The System card shows the broken sample…
	await expect(page.getByText(/11 broken/)).toBeVisible({ timeout: 30_000 });
	// …and the systemic finding opens as a warning (11 of 12 ≥ 80%).
	await page.goto('/incidents');
	const active = activeSection(page);
	await expect(active.getByText(/most sampled symlinks are broken/)).toBeVisible({
		timeout: 30_000
	});

	// Repair: every link points at the real target again.
	rewriteLinks(fixture.mountRoot, () => real);

	// The finding resolves by itself — no reload, no action (brief §26).
	await expect(active.getByText(/most sampled symlinks are broken/)).toHaveCount(0, {
		timeout: 60_000
	});
	await page.goto('/system');
	await expect(page.getByText(/links \d+ sampled · \d+ valid · 0 broken/)).toBeVisible({
		timeout: 30_000
	});
});

test('memory anomaly: 4.2 GB warning opens with delta copy and resolves on recovery', async ({
	page
}) => {
	test.setTimeout(180_000);
	// Let the baseline build (fast clock: a handful of samples), then jump.
	await page.goto('/system');
	await expect(page.getByText('Memory anomalies', { exact: true })).toBeVisible({
		timeout: 30_000
	});
	// InfiniDysk baseline in the mock is ~130–650 MB.
	await expect(page.getByText('InfiniDysk', { exact: true }).first()).toBeVisible({
		timeout: 30_000
	});

	await setRss('InfiniDysk', Math.round(4.2 * 1024 ** 3));
	let restored = false;
	try {
		// Warning finding opens: "<name> memory use is unusually high".
		await page.goto('/incidents');
		const active = activeSection(page);
		await expect(active.getByText(/InfiniDysk memory use is unusually high/)).toBeVisible({
			timeout: 90_000
		});

		// System card shows the elevated current against a low typical.
		await page.goto('/system');
		await expect(page.getByText('InfiniDysk', { exact: true }).first()).toBeVisible();
		await expect(page.getByText(/4\.2 GB/).first()).toBeVisible();

		// Recovery: back to baseline, finding resolves without reload.
		await setRss('InfiniDysk', null);
		restored = true;
		await page.goto('/incidents');
		await expect(active.getByText(/InfiniDysk memory use is unusually high/)).toHaveCount(0, {
			timeout: 90_000
		});
	} finally {
		if (!restored) await setRss('InfiniDysk', null).catch(() => {});
	}
});
