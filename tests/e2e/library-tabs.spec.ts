import { expect, test, type Page } from '@playwright/test';

/**
 * Library tab navigation regression (v0.5.1): the tab buttons must actually
 * switch the rendered panel — not just the URL. v0.5.0 relied on shallow
 * replaceState() to update page.url, which SvelteKit never does, so clicks
 * changed the address bar while the panel stayed on Overview. These specs
 * click the real tab buttons and assert visible panel content, URL state,
 * back/forward, refresh, the configured default tab and a clean console.
 */

const TABS = (page: Page) =>
	page.getByRole('navigation', { name: 'Library sections' }).getByRole('button');

/** Hydration marker: html[data-density] is applied once handlers are live. */
async function waitHydrated(page: Page): Promise<void> {
	await page.waitForFunction(() => document.documentElement.dataset.density !== undefined);
	await page.waitForTimeout(100);
}

/** Let freshly mounted panel content (posters, backlog fetch) settle so the
 * tab bar position is stable before the next click. */
async function settle(page: Page): Promise<void> {
	await page.waitForTimeout(200);
}

let consoleIssues: string[] = [];

test.beforeEach(async ({ page }) => {
	consoleIssues = [];
	page.on('pageerror', (err) => consoleIssues.push(`pageerror: ${err.message}`));
	page.on('console', (msg) => {
		if (msg.type() === 'error') consoleIssues.push(`console.error: ${msg.text()}`);
	});
});

test.afterEach(async () => {
	// §32: the journey must run without uncaught exceptions (each_key_duplicate
	// included) — failures here fail the test even when the UI looks right.
	expect(consoleIssues, 'unexpected console errors').toEqual([]);
});

async function expectActiveTab(page: Page, name: string): Promise<void> {
	await expect(TABS(page).filter({ hasText: new RegExp(`^${name}$`) })).toHaveAttribute(
		'aria-current',
		'page'
	);
}

test('clicking every tab switches the visible panel (§27)', async ({ page }) => {
	await page.goto('/library');
	await waitHydrated(page);
	await expect(page.getByRole('heading', { name: 'Media library' })).toBeVisible();
	await expectActiveTab(page, 'Overview');

	// Overview content is on screen before the first click.
	await expect(page.getByText('Browse library →').first()).toBeVisible();

	await TABS(page).getByText('TV', { exact: true }).click();
	await expect(page).toHaveURL(/\/library\?view=tv$/);
	await expectActiveTab(page, 'TV');
	// §27: concrete TV panel content, not just URL state.
	await expect(page.getByText(/13 series/)).toBeVisible();
	await expect(page.getByText('Missing episode backlog — 14')).toBeVisible();
	await expect(page.getByText('Browse library →')).toHaveCount(0);
	await settle(page);

	await TABS(page).getByText('Movies', { exact: true }).click();
	await expect(page).toHaveURL(/\/library\?view=movies$/);
	await expectActiveTab(page, 'Movies');
	await expect(page.locator('[aria-label="Quality distribution"]')).toBeVisible();
	await expect(page.getByText('Distant Shores').first()).toBeVisible();
	await settle(page);

	await TABS(page).getByText('Subtitles', { exact: true }).click();
	await expect(page).toHaveURL(/\/library\?view=subtitles$/);
	await expectActiveTab(page, 'Subtitles');
	await expect(page.getByText('Language profiles')).toBeVisible();
	await expect(page.getByText('English + Dutch')).toBeVisible();
	await settle(page);

	await TABS(page).getByText('Queue', { exact: true }).click();
	await expect(page).toHaveURL(/\/library\?view=queue$/);
	await expectActiveTab(page, 'Queue');
	await expect(page.getByText('Queue — 1 items')).toBeVisible();
	await expect(page.getByText('Import failed — sonarr')).toBeVisible();
	await settle(page);

	// Full circle: back to Overview via the tab (user journey §43).
	await TABS(page).getByText('Overview', { exact: true }).click();
	await expect(page).toHaveURL(/\/library\?view=overview$/);
	await expectActiveTab(page, 'Overview');
	await expect(page.getByText('Browse library →').first()).toBeVisible();
});

test('duplicate queue issues render without each_key_duplicate (§11)', async ({ page }) => {
	// Production data contains two identical "Download needs attention" issues
	// from one integration; the each key must stay unique anyway.
	await page.route('**/api/library?window=*', async (route) => {
		const response = await route.fetch();
		const payload = await response.json();
		payload.queue.issues = [
			...payload.queue.issues,
			{ ...payload.queue.issues[payload.queue.issues.length - 1] }
		];
		await route.fulfill({ response, json: payload });
	});
	await page.goto('/library?view=queue');
	// Both identical issues render; without a unique key this view throws
	// each_key_duplicate, which the afterEach console assertion would catch.
	await expect(page.getByText('Import failed — sonarr')).toHaveCount(2);
});

test('immediate click right after load still lands on TV (§8)', async ({ page }) => {
	await page.goto('/library', { waitUntil: 'load' });
	await TABS(page).getByText('TV', { exact: true }).click();
	await expect(page).toHaveURL(/\/library\?view=tv$/);
	await expect(page.getByText('Missing episode backlog — 14')).toBeVisible();
});

test('deep links open the requested tab directly (§13/§29)', async ({ page }) => {
	await page.goto('/library?view=subtitles');
	await expect(page.getByText('Language profiles')).toBeVisible();
	await expectActiveTab(page, 'Subtitles');
});

test('invalid view falls back to Overview without crashing (§17)', async ({ page }) => {
	await page.goto('/library?view=banana');
	await expect(page.getByRole('heading', { name: 'Media library' })).toBeVisible();
	await expectActiveTab(page, 'Overview');
	await expect(page.getByText('Browse library →').first()).toBeVisible();
});

test('refresh keeps the active tab (§14)', async ({ page }) => {
	await page.goto('/library?view=movies');
	await page.reload();
	await expect(page.getByText('Distant Shores').first()).toBeVisible();
	await expectActiveTab(page, 'Movies');
});

test('browser back/forward walk the clicked tab history (§15/§30)', async ({ page }) => {
	await page.goto('/library');
	await waitHydrated(page);
	await TABS(page).getByText('TV', { exact: true }).click();
	await TABS(page).getByText('Movies', { exact: true }).click();
	await expect(page.getByText('Distant Shores').first()).toBeVisible();

	await page.goBack();
	await expect(page).toHaveURL(/\/library\?view=tv$/);
	await expect(page.getByText(/13 series/)).toBeVisible();
	await expectActiveTab(page, 'TV');

	await page.goForward();
	await expect(page).toHaveURL(/\/library\?view=movies$/);
	await expect(page.getByText('Distant Shores').first()).toBeVisible();
	await expectActiveTab(page, 'Movies');
});

test('configured default tab applies on entry and never overrides explicit views (§5/§16/§28)', async ({
	page
}) => {
	await page.addInitScript(() => {
		localStorage.setItem(
			'dumbscope.prefs.v1',
			JSON.stringify({ version: 1, libraryTab: 'movies' })
		);
	});

	// /library without an explicit view honours the default tab.
	await page.goto('/library');
	await expect(page.getByText('Distant Shores').first()).toBeVisible();
	await expectActiveTab(page, 'Movies');

	// A tab click must stick — the default preference never fights the URL.
	await TABS(page).getByText('TV', { exact: true }).click();
	await expect(page).toHaveURL(/\/library\?view=tv$/);
	await expect(page.getByText(/13 series/)).toBeVisible();
	await expectActiveTab(page, 'TV');

	// Refresh on the explicit URL keeps TV.
	await page.reload();
	await expect(page.getByText(/13 series/)).toBeVisible();
	await expectActiveTab(page, 'TV');
});

test('tab switching keeps drawers working across views (§33)', async ({ page }) => {
	await page.goto('/library?view=tv');
	await waitHydrated(page);
	await page.locator('ul.grid').locator('button', { hasText: 'Dark Meadow' }).first().click();
	const drawer = page.locator('[role=dialog]');
	await expect(drawer).toBeVisible();

	// The drawer is modal; close it the way users do before switching tabs.
	await drawer.press('Escape');
	await expect(drawer).not.toBeVisible();

	// Next tab lands on a working Movies browser.
	await TABS(page).getByText('Movies', { exact: true }).click();
	await expect(drawer).not.toBeVisible();
	await expect(page.getByText('Distant Shores').first()).toBeVisible();

	await page.locator('ul.grid').locator('button', { hasText: 'Distant Shores' }).first().click();
	await expect(drawer).toBeVisible();

	await drawer.press('Escape');
	await expect(drawer).not.toBeVisible();
	await TABS(page).getByText('Subtitles', { exact: true }).click();
	await expect(page.getByText('Language profiles')).toBeVisible();
});

test.describe('mobile 390x844 (§31)', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('tab flow switches panels on mobile', async ({ page }) => {
		await page.goto('/library');
		await waitHydrated(page);
		await expectActiveTab(page, 'Overview');

		await TABS(page).getByText('TV', { exact: true }).click();
		await expect(page).toHaveURL(/\/library\?view=tv$/);
		await expect(page.getByText('Missing episode backlog — 14')).toBeVisible();

		await TABS(page).getByText('Movies', { exact: true }).click();
		await expect(page.getByText('Distant Shores').first()).toBeVisible();

		await TABS(page).getByText('Subtitles', { exact: true }).click();
		await expect(page.getByText('Language profiles')).toBeVisible();
	});
});
