import { expect, test } from '@playwright/test';

const STAGES = ['Requests', 'Automation', 'Acquisition', 'Storage', 'Media'];

test('overview shows the semantic hero and a stage-chip summary, never a graph', async ({
	page
}) => {
	await page.goto('/');
	await expect(
		page.getByRole('heading', {
			name: /All services are running normally|Your stack needs attention/
		})
	).toBeVisible();
	await expect(page.getByText('11 services online · No active incidents')).toBeVisible();

	const summary = page.getByRole('navigation', { name: 'Pipeline stage status' });
	await expect(summary).toBeVisible();
	for (const stage of STAGES) {
		await expect(summary.getByRole('link', { name: new RegExp(stage) })).toBeVisible();
	}

	// The old mini topology was an SVG graph — it must not come back here.
	await expect(page.locator('.topology-scroll')).toHaveCount(0);
	await expect(page.locator('[data-testid="desktop-pipeline"]')).toHaveCount(0);
});

test('overview failure demo: Storage breaks, Media is affected', async ({ page }) => {
	await page.goto('/?demo=failure');
	const summary = page.getByRole('navigation', { name: 'Pipeline stage status' });
	await expect(summary.getByText('✕')).toBeVisible();
	await expect(summary.getByText('affected')).toBeVisible();
	await expect(page.getByText(/InfiniDysk is unavailable/)).toBeVisible();
});
