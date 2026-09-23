import { expect, test } from '@playwright/test';

/**
 * Observability page (v0.9): deep DUMB monitoring — cgroup memory, per-service
 * classification, InfiniDysk, routing, thermal and the combined timeline.
 * Against the mock gateway the cgroup source is intentionally unavailable, so
 * the page must degrade honestly instead of pretending.
 */
test('observability page renders the headline tiles and honest cgroup state', async ({ page }) => {
	await page.goto('/observability');

	await expect(
		page.getByRole('main').getByRole('heading', { name: 'Observability' })
	).toBeVisible();
	await expect(page.getByText('DUMB memory')).toBeVisible();
	await expect(page.getByText('Anon (applications)')).toBeVisible();
	await expect(page.getByText('Thermal', { exact: true })).toBeVisible();
	await expect(page.getByText('InfiniDysk', { exact: false }).first()).toBeVisible();

	// Honest degradation: no cgroup mount in the test stack.
	await expect(
		page.getByText(/no cgroup source|no sample yet|Collecting cgroup history/).first()
	).toBeVisible();

	// The per-service table waits for baselines rather than inventing classes.
	await expect(page.getByText('Per-service memory')).toBeVisible();

	// Combined timeline card is present with its window selector.
	await expect(page.getByText('Incident timeline')).toBeVisible();
});

test('overview links to the deep observability view', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('link', { name: /Deep view/ })).toBeVisible();
});
