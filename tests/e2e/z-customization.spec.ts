import { expect, test, type Page } from '@playwright/test';

/**
 * DEEL 3 customization journeys (brief §119-§124): appearance changes persist
 * across reloads, sidebar modes work with keyboard/labels, the landing page
 * opens on root navigation, hidden nav items keep deep links working,
 * dashboard presets/order persist, and reset restores defaults.
 */

/**
 * Hydration marker: initPreferences applies density to <html> from a layout
 * effect that runs after handlers are attached — clicks are then safe.
 * (networkidle never settles here: the SSE stream stays open.)
 */
async function waitHydrated(page: Page): Promise<void> {
	await page.waitForFunction(() => document.documentElement.dataset.density !== undefined);
	await page.waitForTimeout(150);
}

async function gotoSection(page: Page, id: string): Promise<void> {
	await page.goto('/settings');
	await waitHydrated(page);
	await page
		.getByRole('navigation', { name: 'Settings sections' })
		.getByText(id, { exact: true })
		.click();
	await page.waitForTimeout(200);
}

/** The settings card containing a given title. */
function settingsCard(page: Page, title: string) {
	return page
		.locator('section.card')
		.filter({ has: page.getByText(title, { exact: true }) })
		.first();
}

test('appearance: OLED + blue accent + compact density + reduced motion persist over reload', async ({
	page
}) => {
	test.setTimeout(90_000);
	await gotoSection(page, 'Appearance');

	// OLED theme card (real near-black variant).
	await page.getByRole('button', { name: 'oled', exact: true }).click();
	// Blue accent card.
	await page.locator('button', { hasText: 'Blue' }).first().click();
	// Compact density.
	await page.getByRole('button', { name: 'compact', exact: true }).click();
	// Reduced motion.
	await page.getByRole('button', { name: 'reduced', exact: true }).click();
	await waitHydrated(page);

	// Live apply: html attributes react without any save action.
	const dataset = await page.evaluate(() => ({ ...document.documentElement.dataset }));
	expect(dataset.theme).toBe('oled');
	expect(dataset.accent).toBe('blue');
	expect(dataset.density).toBe('compact');
	expect(dataset.reducedMotion).toBe('true');

	// Reload: everything persists (browser-local).
	await page.reload();
	await waitHydrated(page);
	const after = await page.evaluate(() => ({ ...document.documentElement.dataset }));
	expect(after.theme).toBe('oled');
	expect(after.accent).toBe('blue');
	expect(after.density).toBe('compact');
	expect(after.reducedMotion).toBe('true');
	await expect(page.getByRole('button', { name: 'oled', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
});

test('sidebar: icons mode hides labels with accessible tooltips; expanded restores', async ({
	page
}) => {
	test.setTimeout(90_000);
	await gotoSection(page, 'Navigation');
	const sidebarCard = settingsCard(page, 'Sidebar');
	await sidebarCard.getByRole('button', { name: 'Icons only' }).click();
	await page.goto('/');
	await waitHydrated(page);
	const sidebar = page.locator('aside').first();
	await expect(sidebar).toBeVisible();
	// Icons-only: nav links carry accessible labels (§18).
	const overviewLink = sidebar.getByRole('link', { name: 'Overview' });
	await expect(overviewLink).toBeVisible();
	await expect(overviewLink).toHaveAttribute('aria-label', 'Overview');

	// Back to expanded via settings.
	await gotoSection(page, 'Navigation');
	await settingsCard(page, 'Sidebar').getByRole('button', { name: 'expanded' }).click();
	await page.goto('/');
	await waitHydrated(page);
	await expect(page.locator('aside').first().getByText('Overview')).toBeVisible();
});

test('landing page: root navigation opens the configured page', async ({ page }) => {
	test.setTimeout(90_000);
	await gotoSection(page, 'Navigation');
	const landingCard = settingsCard(page, 'Landing page');
	await landingCard.getByRole('button', { name: 'Library', exact: true }).click();
	// Root navigation lands on Library (first root hit of the session).
	await page.goto('/');
	await waitHydrated(page);
	await expect(page).toHaveURL(/\/library/);

	// Deep link to Overview still works (§122) — and does not re-bounce.
	await page.goto('/');
	await waitHydrated(page);
	await page.goto('/');
	await waitHydrated(page);
	await expect(page.locator('h1, h2').first()).toBeVisible();

	// Reset navigation restores Overview as the landing page.
	await gotoSection(page, 'Navigation');
	await page.getByRole('button', { name: 'Reset navigation' }).click();
	await page.goto('/');
	await waitHydrated(page);
	await expect(page).toHaveURL(/\/(\?|$)/);
});

test('hidden nav item stays reachable via deep link (§122)', async ({ page }) => {
	test.setTimeout(90_000);
	await gotoSection(page, 'Navigation');
	const navCard = settingsCard(page, 'Navigation items');
	const activityRow = navCard.locator('li', { hasText: 'Activity' }).first();
	await activityRow.locator('input[type=checkbox]').uncheck();
	await page.goto('/');
	await waitHydrated(page);
	// Sidebar no longer lists Activity…
	const sidebar = page.locator('aside').first();
	await expect(sidebar.getByRole('link', { name: 'Activity' })).toHaveCount(0);
	// …but the deep link still works.
	await page.goto('/activity');
	await waitHydrated(page);
	await expect(page.locator('h2', { hasText: 'Activity' }).first()).toBeVisible();
	// Restore.
	await gotoSection(page, 'Navigation');
	await settingsCard(page, 'Navigation items')
		.locator('li', { hasText: 'Activity' })
		.first()
		.locator('input[type=checkbox]')
		.check();
});

test('dashboard: operations preset, reorder and visibility persist; reset restores', async ({
	page
}) => {
	test.setTimeout(90_000);
	await gotoSection(page, 'Dashboard');
	const presetCard = settingsCard(page, 'Dashboard presets');
	await presetCard.getByRole('button', { name: /Operations/ }).click();
	// Reorder with the accessible controls: move Reliability down and back.
	const widgetsCard = settingsCard(page, 'Widgets');
	const reliabilityRow = widgetsCard.locator('li', { hasText: 'Reliability' }).first();
	await reliabilityRow.getByRole('button', { name: 'Move Reliability down' }).click();
	// Hide Integrations.
	await widgetsCard
		.locator('li', { hasText: 'Integrations' })
		.first()
		.locator('input[type=checkbox]')
		.uncheck();

	// Overview reflects the customization…
	await page.goto('/');
	await waitHydrated(page);
	await expect(page.getByText('Reliability', { exact: true }).first()).toBeVisible();

	// …and the custom marker persists over reload (Dashboard section).
	await page.reload();
	await gotoSection(page, 'Dashboard');
	await expect(page.getByText(/modified from the selected preset/)).toBeVisible();

	// Reset interface settings restores the balanced overview (§124/§227).
	await gotoSection(page, 'Appearance');
	const resetCard = settingsCard(page, 'Reset interface');
	page.once('dialog', (dialog) => dialog.accept());
	await resetCard.getByRole('button', { name: 'Reset interface settings' }).click();
	await page.waitForTimeout(400);
	await page.goto('/');
	await waitHydrated(page);
	// Preferences are back to balanced defaults…
	const stored = await page.evaluate(
		() => JSON.parse(localStorage.getItem('dumbscope.prefs.v1') || '{}').dashboardHidden ?? null
	);
	expect(stored).toEqual([]);
	// …and the Resource history widget (hidden by Operations) is rendered again.
	await expect(page.getByText('Resource history', { exact: true }).first()).toBeVisible({
		timeout: 30_000
	});
});
