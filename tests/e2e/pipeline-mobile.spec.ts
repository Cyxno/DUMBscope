import { expect, test } from '@playwright/test';

const STAGES = ['Requests', 'Automation', 'Acquisition', 'Storage', 'Media'];

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test('mobile renders the vertical timeline, not the desktop flow', async ({ page }) => {
	await page.goto('/pipeline');
	await expect(page.getByTestId('mobile-pipeline')).toBeVisible();
	await expect(page.getByTestId('desktop-pipeline')).toBeHidden();
});

test('mobile has no horizontal overflow and every stage is reachable by scroll', async ({
	page
}) => {
	await page.goto('/pipeline');
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);

	for (const stage of STAGES) {
		const heading = page.getByRole('heading', { name: stage, exact: true });
		await heading.scrollIntoViewIfNeeded();
		await expect(heading).toBeVisible();
	}
});

test('mobile keeps full service names readable', async ({ page }) => {
	await page.goto('/pipeline');
	for (const name of ['Seerr', 'Sonarr', 'Radarr', 'Prowlarr', 'Decypharr', 'InfiniDysk', 'Plex']) {
		const card = page.getByRole('button', { name: `${name}: Healthy` });
		await card.scrollIntoViewIfNeeded();
		await expect(card).toBeVisible();
	}
});

test('mobile: tapping a service opens the drawer', async ({ page }) => {
	await page.goto('/pipeline');
	const plex = page.getByRole('button', { name: 'Plex: Healthy' });
	await plex.scrollIntoViewIfNeeded();
	await plex.tap();
	await expect(page.getByRole('dialog')).toContainText('Plex');
});
