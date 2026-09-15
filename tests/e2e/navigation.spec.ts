import { expect, test, type Page } from '@playwright/test';

/**
 * Sidebar navigation regression (v0.5.2): v0.5.1 rendered the Monitor section
 * from the full preference order while Operate rendered its own subset, so
 * Incidents/Logs/Activity/System appeared twice and two links carried
 * aria-current. These specs pin: every route renders exactly once, in its
 * canonical section, with a single active item — across sidebar modes, custom
 * visibility/order, corrupt stored preferences, mobile drawer and reload.
 */

const DESKTOP_ASIDE = 'aside[aria-label="Primary"]';
const ALL_ROUTES = [
	['Overview', '/'],
	['Pipeline', '/pipeline'],
	['Services', '/services'],
	['Library', '/library'],
	['Incidents', '/incidents'],
	['Logs', '/logs'],
	['Activity', '/activity'],
	['System', '/system']
] as const;

/** Section container (heading + list) inside the desktop sidebar. */
function section(page: Page, name: string) {
	return page.locator(`${DESKTOP_ASIDE} nav > div`).filter({
		has: page.getByText(name, { exact: true })
	});
}

test.beforeEach(async ({ page }) => {
	const issues: string[] = [];
	page.on('pageerror', (err) => issues.push(String(err)));
	page.on('console', (msg) => {
		if (msg.type() === 'error') issues.push(msg.text());
	});
	// §36: expose collected issues for the afterEach assertion.
	(page as unknown as { __navIssues: string[] }).__navIssues = issues;
});

test.afterEach(async ({ page }) => {
	const issues = (page as unknown as { __navIssues: string[] }).__navIssues ?? [];
	expect(issues, 'unexpected console errors').toEqual([]);
});

async function expectExactlyOneEach(page: Page): Promise<void> {
	for (const [label] of ALL_ROUTES) {
		await expect(
			page.locator(DESKTOP_ASIDE).getByRole('link', { name: label, exact: true })
		).toHaveCount(1);
	}
}

test('default sidebar: every route exactly once, in its canonical section (§1/§21/§22)', async ({
	page
}) => {
	await page.goto('/activity');
	await expectExactlyOneEach(page);

	const monitor = section(page, 'Monitor');
	const operate = section(page, 'Operate');
	for (const [label] of ALL_ROUTES.slice(0, 4)) {
		await expect(monitor.getByRole('link', { name: label, exact: true })).toHaveCount(1);
		await expect(operate.getByRole('link', { name: label, exact: true })).toHaveCount(0);
	}
	for (const [label] of ALL_ROUTES.slice(4)) {
		await expect(operate.getByRole('link', { name: label, exact: true })).toHaveCount(1);
		await expect(monitor.getByRole('link', { name: label, exact: true })).toHaveCount(0);
	}
});

test('Activity route: exactly one selected item, inside Operate (§16/§17)', async ({ page }) => {
	await page.goto('/activity');
	const active = page.locator(`${DESKTOP_ASIDE} a[aria-current="page"]`);
	await expect(active).toHaveCount(1);
	await expect(active).toHaveAccessibleName('Activity');
	await expect(section(page, 'Operate').locator('a[aria-current="page"]')).toHaveCount(1);
});

test('single nav set straight after load — no hydration duplication (§29)', async ({ page }) => {
	await page.goto('/system', { waitUntil: 'load' });
	await expectExactlyOneEach(page);
	const active = page.locator(`${DESKTOP_ASIDE} a[aria-current="page"]`);
	await expect(active).toHaveCount(1);
	await expect(active).toHaveAccessibleName('System');
});

test('hiding a route removes it everywhere; deep link still works (§13/§25)', async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem(
			'dumbscope.prefs.v1',
			JSON.stringify({ version: 1, navHidden: ['/logs'] })
		);
	});
	await page.goto('/activity');
	await expect(
		page.locator(DESKTOP_ASIDE).getByRole('link', { name: 'Logs', exact: true })
	).toHaveCount(0);
	await expectExactlyOneEach(page).catch(() => {
		// Logs is hidden by design here; assert the remaining seven individually.
	});
	for (const [label] of ALL_ROUTES.filter(([label]) => label !== 'Logs')) {
		await expect(
			page.locator(DESKTOP_ASIDE).getByRole('link', { name: label, exact: true })
		).toHaveCount(1);
	}

	// §13: the hidden route stays reachable via direct URL.
	await page.goto('/logs');
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await expect(
		page.locator(DESKTOP_ASIDE).getByRole('link', { name: 'Logs', exact: true })
	).toHaveCount(0);
});

test('custom order applies within the section and never duplicates (§14/§26)', async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem(
			'dumbscope.prefs.v1',
			JSON.stringify({
				version: 1,
				navOrder: [
					'/',
					'/pipeline',
					'/services',
					'/library',
					'/activity',
					'/logs',
					'/incidents',
					'/system'
				]
			})
		);
	});
	await page.goto('/activity');
	await expectExactlyOneEach(page);
	const operateHrefs = await section(page, 'Operate')
		.locator('a')
		.evaluateAll((links) => links.map((l) => (l as HTMLAnchorElement).getAttribute('href')));
	expect(operateHrefs).toEqual(['/activity', '/logs', '/incidents', '/system']);
});

test('corrupt stored preferences with duplicates normalize safely (§28/§46/§48)', async ({
	page
}) => {
	await page.addInitScript(() => {
		localStorage.setItem(
			'dumbscope.prefs.v1',
			JSON.stringify({
				version: 1,
				navOrder: [
					'/activity',
					'/activity',
					'/bogus',
					'/logs',
					'/system',
					'/system',
					'/incidents',
					'/incidents'
				]
			})
		);
	});
	await page.goto('/activity');
	await expectExactlyOneEach(page);
	// The mentioned Operate items keep their relative order; the rest appends.
	const operateHrefs = await section(page, 'Operate')
		.locator('a')
		.evaluateAll((links) => links.map((l) => (l as HTMLAnchorElement).getAttribute('href')));
	expect(operateHrefs).toEqual(['/activity', '/logs', '/system', '/incidents']);
});

test('sidebar modes: compact and icons-only render one entry per route (§24)', async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem(
			'dumbscope.prefs.v1',
			JSON.stringify({ version: 1, sidebarMode: 'compact' })
		);
	});
	await page.goto('/activity');
	await expectExactlyOneEach(page);
	await expect(page.locator(`${DESKTOP_ASIDE} a[aria-current="page"]`)).toHaveCount(1);

	await page.addInitScript(() => {
		const raw = localStorage.getItem('dumbscope.prefs.v1');
		const prefs = raw ? JSON.parse(raw) : { version: 1 };
		prefs.sidebarMode = 'icons';
		localStorage.setItem('dumbscope.prefs.v1', JSON.stringify(prefs));
	});
	const page2 = await page.context().newPage();
	page2.on('pageerror', (err) => {
		throw err;
	});
	await page2.goto('/activity');
	await expectExactlyOneEach(page2);
	await expect(page2.locator(`${DESKTOP_ASIDE} a[aria-current="page"]`)).toHaveCount(1);
	await page2.close();
});

test('mobile drawer renders one entry per route (§23)', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto('/activity');
	await page.getByRole('button', { name: 'Open navigation' }).click();
	const drawer = page.locator('div[role="presentation"] aside');
	await expect(drawer).toBeVisible();
	for (const [label] of ALL_ROUTES) {
		await expect(drawer.getByRole('link', { name: label, exact: true })).toHaveCount(1);
	}
});

test('preferences persist across reload without duplication (§35/§47)', async ({ page }) => {
	await page.addInitScript(() => {
		localStorage.setItem(
			'dumbscope.prefs.v1',
			JSON.stringify({ version: 1, navHidden: ['/logs'] })
		);
	});
	await page.goto('/activity');
	await expect(
		page.locator(DESKTOP_ASIDE).getByRole('link', { name: 'Logs', exact: true })
	).toHaveCount(0);
	await page.reload();
	await expect(
		page.locator(DESKTOP_ASIDE).getByRole('link', { name: 'Logs', exact: true })
	).toHaveCount(0);
	for (const [label] of ALL_ROUTES.filter(([label]) => label !== 'Logs')) {
		await expect(
			page.locator(DESKTOP_ASIDE).getByRole('link', { name: label, exact: true })
		).toHaveCount(1);
	}
});
