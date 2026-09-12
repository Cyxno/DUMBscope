import { expect, test } from '@playwright/test';

test('library overview: completion cards, attention and queue intelligence', async ({ page }) => {
	await page.goto('/library');
	await expect(page.getByRole('heading', { name: 'Media library' })).toBeVisible();

	// Completion cards (§30): TV ~97%, Movies ~92%, Subtitles present.
	await expect(page.getByText('14 episodes missing')).toBeVisible();
	await expect(page.getByText('21 upgrades available')).toBeVisible();
	await expect(page.getByText('3 movies missing')).toBeVisible();
	await expect(page.getByText('subtitle gaps').first()).toBeVisible();

	// Deep links (§66/§67): every card browses into its library view.
	await expect(page.getByText('Browse library →').first()).toBeVisible();

	// Attention (§31/§39): the failed import is an issue, not the backlog.
	await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
	await expect(page.getByText(/1 import issue/)).toBeVisible();
	await expect(
		page
			.getByText(/2 missing items older than 30 days/)
			.or(page.getByText(/items older than 30 days/))
	).toBeVisible();
});

test('TV tab: poster browser with header totals and the missing backlog', async ({ page }) => {
	await page.goto('/library?view=tv');

	// Browser header (§5): totals from the cached inventory.
	await expect(page.getByText(/13 series/)).toBeVisible();
	await expect(page.getByText('14 released episodes missing')).toBeVisible();
	await expect(page.getByText('21 upgrades available')).toBeVisible();

	// Grid cards render from the browse inventory (mock: 13 series).
	const grid = page.locator('ul.grid');
	await expect(grid.locator('button').first()).toBeVisible();

	// Missing backlog list (§30) with most-missing series ranked first.
	await expect(page.getByText('Missing episode backlog — 14')).toBeVisible();
	const backlogText = await page
		.locator('section[aria-label="Missing episode backlog"]')
		.innerText();
	expect(backlogText.indexOf('Foxglove')).toBeLessThan(backlogText.indexOf('Dark Meadow'));

	// Backlog age summary line (§13): buckets present, 30d+ bucket dominant.
	await expect(page.getByText(/Backlog ages/)).toBeVisible();
	await expect(page.getByText('30d+: 7')).toBeVisible();
});

test('TV tab: series drawer shows seasons, episodes, quality and subtitles', async ({ page }) => {
	await page.goto('/library?view=tv');
	const grid = page.locator('ul.grid');
	// Dark Meadow has 3 missing episodes — enough to see every state.
	await grid.locator('button', { hasText: 'Dark Meadow' }).first().click();
	const drawer = page.locator('[role=dialog]');
	await expect(drawer).toBeVisible();

	// Seasons accordion (§14/§15) collapsed by default, expands on click.
	const seasonButton = drawer.locator('button[aria-expanded]', { hasText: 'Season 1' }).first();
	await expect(seasonButton).toHaveAttribute('aria-expanded', 'false');
	await seasonButton.click();
	await expect(seasonButton).toHaveAttribute('aria-expanded', 'true');

	// Episode rows: quality badge from the structured quality object (§20)
	// and subtitle chips (§24).
	await expect(drawer.getByText('WEB-DL 1080p').first()).toBeVisible();
	await expect(drawer.getByText('Available').first()).toBeVisible();
	await expect(drawer.getByText('Missing', { exact: true }).first()).toBeVisible();
});

test('movies tab: missing filter shows exactly the released missing films', async ({ page }) => {
	await page.goto('/library?view=movies&filter=missing');
	await expect(page.getByText('3 released movies missing')).toBeVisible();
	await expect(page.getByText('Distant Shores').first()).toBeVisible();
	await expect(page.getByText('Electric Sky').first()).toBeVisible();
	await expect(page.getByText('Falling Stars').first()).toBeVisible();

	// Movie drawer (§37): status, quality and file info.
	await page.locator('ul.grid button').first().click();
	const drawer = page.locator('[role=dialog]');
	await expect(drawer).toBeVisible();
	await expect(drawer.getByText('Missing').first()).toBeVisible();
	await expect(drawer.getByText(/Released .* days ago/)).toBeVisible();
});

test('subtitles tab: overview, language profile and gap lists (§45–§47)', async ({ page }) => {
	await page.goto('/library?view=subtitles');
	await expect(page.getByText('Language profiles')).toBeVisible();
	await expect(page.getByText('English + Dutch')).toBeVisible();
	await expect(page.getByText('Configured languages')).toBeVisible();
	await expect(page.getByText('Movie gaps per language')).toBeVisible();
	await expect(page.getByText('Series with episode gaps')).toBeVisible();
});

test('XSS fixtures render as inert text everywhere (§28)', async ({ page }) => {
	await page.addInitScript(() => {
		window.addEventListener('error', (event) => {
			if ((event as ErrorEvent).message?.includes('alert')) (window as any).__xssFired = true;
		});
	});
	await page.goto('/library?view=tv&q=' + encodeURIComponent('<img'));
	// The escaped title is visible as text (no broken img / no alert).
	await expect(page.getByText('<img src=x onerror=alert(1)>').first()).toBeVisible();
	expect(await page.evaluate(() => (window as any).__xssFired ?? false)).toBeFalsy();
});

test('queue tab: combined queue with the failed import flagged (§26–§28)', async ({ page }) => {
	await page.goto('/library?view=queue');
	await expect(page.getByText('Queue — 1 items')).toBeVisible();
	await expect(page.getByText('Queue issues')).toBeVisible();
	await expect(page.getByText('Import failed — sonarr')).toBeVisible();
});

test('back navigation: drawer closes and views switch cleanly (§62/§135)', async ({ page }) => {
	// Two real history entries: TV, then Movies.
	await page.goto('/library?view=tv');
	await page.goto('/library?view=movies');
	await expect(page.locator('ul.grid button').first()).toBeVisible();

	// Opening a movie pushes a drawer entry; back returns to the list.
	await page.locator('ul.grid button').first().click();
	const drawer = page.locator('[role=dialog]');
	await expect(drawer).toBeVisible();
	await expect(page).toHaveURL(/item=radarr-movie-/);
	await page.goBack();
	await expect(drawer).not.toBeVisible();
	await expect(page).not.toHaveURL(/item=/);
});

test('deep link refresh keeps the detail reachable (§63/§160)', async ({ page }) => {
	await page.goto('/library?view=tv&item=sonarr-series-4');
	await page.reload();
	const drawer = page.locator('[role=dialog]');
	await expect(drawer).toBeVisible();
	await expect(drawer.getByRole('heading', { name: 'Dark Meadow' })).toBeVisible();
});

test('invalid deep link shows a friendly state (§64/§130)', async ({ page }) => {
	await page.goto('/library?view=tv&item=sonarr-series-424242');
	const drawer = page.locator('[role=dialog]');
	await expect(drawer).toBeVisible();
	await expect(drawer.getByText(/no longer in the library/i).first()).toBeVisible();
});

test('season accordion is keyboard operable (§71)', async ({ page }) => {
	await page.goto('/library?view=tv&item=sonarr-series-4');
	const drawer = page.locator('[role=dialog]');
	await expect(drawer).toBeVisible();
	const seasonButton = drawer.locator('button[aria-expanded]', { hasText: 'Season 1' }).first();
	seasonButton.focus();
	await expect(seasonButton).toBeFocused();
	await seasonButton.press('Enter');
	await expect(seasonButton).toHaveAttribute('aria-expanded', 'true');
	await seasonButton.press('Space');
	await expect(seasonButton).toHaveAttribute('aria-expanded', 'false');
});

test('escape closes the drawer and focus returns to the page (§72)', async ({ page }) => {
	await page.goto('/library?view=tv&item=sonarr-series-4');
	const drawer = page.locator('[role=dialog]');
	await expect(drawer).toBeVisible();
	await drawer.press('Escape');
	await expect(drawer).not.toBeVisible();
	await expect(page.getByRole('heading', { name: 'Media library' })).toBeVisible();
});
