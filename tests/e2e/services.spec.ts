import { expect, test } from '@playwright/test';

// The mock gateway's 11-service stack (see tests/mock-dumb/server.mjs).
const MANAGED = [
	'Seerr',
	'Prowlarr',
	'Radarr',
	'Sonarr',
	'Decypharr',
	'InfiniDysk',
	'Plex',
	'rclone',
	'PostgreSQL',
	'DUMB API',
	'DUMB Frontend'
];

test('services page groups the full managed inventory by pipeline stage', async ({ page }) => {
	await page.goto('/services');
	await expect(page.getByText('11 managed by DUMB · grouped by pipeline stage')).toBeVisible();

	// Groups exist only where relevant, in flow order. The mock stack has no
	// running supporting services, so that group is absent here.
	for (const group of [
		'Requests',
		'Automation',
		'Acquisition',
		'Storage',
		'Media',
		'Infrastructure'
	]) {
		await expect(page.getByRole('region', { name: `${group} services` })).toBeVisible();
	}

	// The whole managed inventory is present — nothing hidden by grouping.
	for (const name of MANAGED) {
		const card = page.getByRole('button', { name: new RegExp(`^${name}:`) });
		await expect(card.first()).toBeVisible();
	}
});

test('canonical naming regression: no raw keys or titlecase artifacts', async ({ page }) => {
	await page.goto('/services');
	await expect(page.getByRole('button', { name: /^DUMB API:/ })).toBeVisible();
	await expect(page.getByRole('button', { name: /^DUMB Frontend:/ })).toBeVisible();
	await expect(page.getByRole('button', { name: /^Plex:/ })).toBeVisible();

	const body = await page.locator('body').innerText();
	expect(body).not.toContain('dumb_api_service');
	expect(body).not.toContain('Dumb Api Service');
	expect(body).not.toContain('rclone w/');
});

test('drawer CTA: monitoring copy links to Settings', async ({ page }) => {
	await page.goto('/services');
	const plex = page.getByRole('button', { name: /^Plex:/ }).first();
	await plex.click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toContainText("Detailed monitoring isn't configured");
	const cta = dialog.getByRole('link', { name: /Configure in Settings/ });
	await expect(cta).toHaveAttribute('href', '/settings');
});
