import { expect, test } from '@playwright/test';

test('failure journey: break at Storage, root cause red, downstream affected (never red)', async ({
	page
}) => {
	await page.goto('/pipeline?demo=failure');

	// Root-cause banner names the break and the impact.
	const banner = page.getByText('Pipeline interrupted at Storage');
	await expect(banner).toBeVisible();

	// InfiniDysk is the critical root cause…
	const infiny = page.getByRole('button', { name: 'InfiniDysk: Unhealthy' });
	await expect(infiny).toBeVisible();

	// …while Plex is downstream-affected, explicitly NOT critical.
	const plex = page.getByRole('button', { name: 'Plex: May be affected' });
	await expect(plex).toBeVisible();
	await expect(page.getByRole('button', { name: 'Plex: Unhealthy' })).toHaveCount(0);

	// Sonarr (upstream) stays healthy.
	await expect(page.getByRole('button', { name: 'Sonarr: Healthy' })).toBeVisible();
});

test('failure navigation: View incident leads to the incidents page', async ({ page }) => {
	await page.goto('/pipeline?demo=failure');
	const link = page.getByRole('link', { name: /View incident/ });
	await expect(link).toHaveAttribute('href', '/incidents');
	await link.click();
	await expect(page).toHaveURL(/\/incidents/);
	await expect(page.getByRole('heading', { name: 'Incidents', level: 2 })).toBeVisible();
});
