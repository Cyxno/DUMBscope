import { expect, test } from '@playwright/test';

/**
 * Safe Actions e2e (docs/ACTIONS.md §30): targeted search/refresh from the
 * Library, deep "Open service" links, and the service-drawer restart with
 * confirmation — all against the mock stack (never real services).
 */
test.describe('safe actions', () => {
	test('library → missing episode: search again accepted, deep link and history entry', async ({
		page
	}) => {
		await page.goto('/library?view=tv&item=sonarr-series-4');
		const drawer = page.locator('[role=dialog]');
		await expect(drawer.getByRole('heading', { name: 'Dark Meadow' })).toBeVisible();

		// "Open in Sonarr" is built from the upstream titleSlug (§26) and opens
		// the service's own web UI in a new tab (§2).
		const openLink = drawer.getByRole('link', { name: 'Open in Sonarr' });
		await expect(openLink).toHaveAttribute('href', 'http://127.0.0.1:4211/series/dark-meadow');
		await expect(openLink).toHaveAttribute('target', '_blank');

		// Refresh series rides the allowlisted command API.
		const refresh = drawer.getByRole('button', { name: 'Refresh series' });
		await refresh.click();
		await expect(refresh).toContainText('✓', { timeout: 30_000 });

		// The mock's missing episodes sit in the Season 1 statistics — the row
		// shows 3 missing and gets the targeted season search affordance (§5).
		const seasonSearch = drawer.getByRole('button', { name: 'Search Season 1 in Sonarr' });
		await expect(seasonSearch).toBeVisible();
		await seasonSearch.click();
		await expect(seasonSearch).toContainText('✓', { timeout: 30_000 });

		// Expand Season 1, open a missing episode's detail and search it (§4).
		await drawer.locator('button[aria-expanded]', { hasText: 'Season 1' }).first().click();
		await drawer.getByRole('button', { name: /^Episode 43,/ }).click();
		const episodeSearch = drawer.getByRole('button', {
			name: 'Search episode E43 in Sonarr'
		});
		await expect(episodeSearch).toBeVisible();
		await episodeSearch.click();
		// "requested" is shown honestly; the mock completes within seconds, so
		// the bounded follow upgrades the state to completed (✓) — never
		// "media found" (§11).
		await expect(episodeSearch).toContainText('✓', { timeout: 30_000 });

		// Every executed action is audited (§16).
		await page.goto('/activity');
		await expect(page.getByText('Recent actions')).toBeVisible();
		await expect(page.getByText('Search again').first()).toBeVisible();
	});

	test('library → missing movie: search again accepted with Radarr deep link', async ({ page }) => {
		await page.goto('/library?view=movies&filter=missing');
		await page.locator('ul.grid button', { hasText: 'Distant Shores' }).first().click();
		const drawer = page.locator('[role=dialog]');
		await expect(drawer.getByRole('heading', { name: 'Distant Shores' }).first()).toBeVisible();

		const search = drawer.getByRole('button', { name: 'Search again' });
		await expect(search).toBeVisible();
		const refresh = drawer.getByRole('button', { name: 'Refresh', exact: true });
		await expect(refresh).toBeVisible();

		const openLink = drawer.getByRole('link', { name: 'Open in Radarr' });
		// TMDB-id-built deep link (§26); mock movie id 4 → tmdbId 100004.
		await expect(openLink).toHaveAttribute('href', 'http://127.0.0.1:4212/movie/100004');

		await search.click();
		await expect(search).toContainText('✓', { timeout: 30_000 });
	});

	test('service drawer: open link and confirmed restart through the remediation layer', async ({
		page
	}) => {
		await page.goto('/services');
		await page
			.getByRole('button', { name: /^Radarr:/ })
			.first()
			.click();
		const drawer = page.locator('[role=dialog]');
		await expect(drawer).toBeVisible();

		// Open service (§2): the configured integration URL, new tab.
		const openLink = drawer.getByRole('link', { name: 'Open Radarr' });
		await expect(openLink).toHaveAttribute('href', 'http://127.0.0.1:4212');
		await expect(openLink).toHaveAttribute('target', '_blank');

		// Restart service (§3/§21): confirmation required, then accepted via
		// DUMB's own management route — never a container restart.
		const restart = drawer.getByRole('button', { name: 'Restart Radarr' });
		await expect(restart).toBeEnabled();
		await restart.click();

		const confirm = page.getByRole('dialog', { name: 'Confirm restart' });
		await expect(confirm).toBeVisible();
		await expect(confirm.getByText(/Only this managed service will be restarted/)).toBeVisible();
		await confirm.getByRole('button', { name: 'Restart service' }).click();
		await expect(drawer.getByText(/Restart accepted for Radarr/)).toBeVisible({
			timeout: 30_000
		});
	});
});
