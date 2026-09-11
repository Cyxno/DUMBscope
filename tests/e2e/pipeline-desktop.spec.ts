import { expect, test } from '@playwright/test';

const STAGES = ['Requests', 'Automation', 'Acquisition', 'Storage', 'Media'];

test('healthy pipeline renders all stages left to right with full service names', async ({
	page
}) => {
	await page.goto('/pipeline');
	await expect(page.getByRole('heading', { name: 'Media pipeline' })).toBeVisible();

	for (const stage of STAGES) {
		await expect(page.getByRole('heading', { name: stage, exact: true })).toBeVisible();
	}

	// Full canonical names — never truncated internal keys.
	for (const name of ['Seerr', 'Sonarr', 'Radarr', 'Prowlarr', 'Decypharr', 'InfiniDysk', 'Plex']) {
		await expect(page.getByRole('button', { name: `${name}: Healthy` })).toBeVisible();
	}

	// Header count matches the hero's managed-registry count.
	await expect(page.getByText(/11 services online · no incidents/)).toBeVisible();

	// No horizontal page overflow at desktop width.
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);
});

test('service selection opens the drawer and restores state after close', async ({ page }) => {
	await page.goto('/pipeline');
	const sonarr = page.getByRole('button', { name: 'Sonarr: Healthy' });
	await sonarr.click();
	await expect(sonarr).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByRole('dialog')).toContainText('Sonarr');
	await expect(page.getByRole('dialog')).toContainText('TV automation');

	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toBeHidden();
	await expect(sonarr).toHaveAttribute('aria-pressed', 'false');
});

test('keyboard: Enter opens the drawer, Escape closes it, focus is kept', async ({ page }) => {
	await page.goto('/pipeline');
	const sonarr = page.getByRole('button', { name: 'Sonarr: Healthy' });
	await sonarr.focus();
	await expect(sonarr).toBeFocused();
	await sonarr.press('Enter');
	await expect(page.getByRole('dialog')).toBeVisible();

	await page.keyboard.press('Escape');
	await expect(page.getByRole('dialog')).toBeHidden();
	await expect(sonarr).toBeVisible();
});

test('Simple/Detailed toggle hides infrastructure by default and reveals it on demand', async ({
	page
}) => {
	await page.goto('/pipeline');
	await expect(page.getByText(/infrastructure processes hidden/)).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Infrastructure' })).toBeHidden();

	await page.getByRole('button', { name: 'Detailed' }).click();
	const infra = page.getByTestId('pipeline-infrastructure');
	await expect(infra).toBeVisible();
	await expect(infra.getByText('PostgreSQL')).toBeVisible();

	await page.getByRole('button', { name: 'Simple' }).click();
	await expect(page.getByTestId('pipeline-infrastructure')).toBeHidden();
});
