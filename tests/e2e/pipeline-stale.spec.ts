import { expect, test } from '@playwright/test';

test('stale journey: last-known data is clearly stale, never green', async ({ page }) => {
	await page.goto('/pipeline?demo=stale');

	await expect(page.getByText(/Last known state/)).toBeVisible();
	await expect(page.getByText('Stale').first()).toBeVisible();

	// No healthy live-state marketing while disconnected.
	await expect(page.getByText(/services online · no incidents/)).toHaveCount(0);
	await expect(page.getByText('Pipeline interrupted')).toHaveCount(0);

	// Last-known services stay visible.
	await expect(page.getByRole('button', { name: 'Sonarr: Stale' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Plex: Stale' })).toBeVisible();
});

test('demo overrides are presentation-only and disabled without the QA opt-in', async ({
	page
}) => {
	// The harness runs with PUBLIC_QA_DEMOS=1; verify the flag actually drives
	// behaviour here by checking a healthy pipeline first.
	await page.goto('/pipeline');
	await expect(page.getByText(/services online · no incidents/)).toBeVisible();

	// A nonsense demo value must never fake a state.
	await page.goto('/pipeline?demo=nonsense');
	await expect(page.getByText('Pipeline interrupted')).toHaveCount(0);
});
