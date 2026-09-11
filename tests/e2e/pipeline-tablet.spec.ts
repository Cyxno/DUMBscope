import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('tablet (768) uses the mobile timeline deliberately, without overflow', async ({ page }) => {
	await page.goto('/pipeline');
	await expect(page.getByTestId('mobile-pipeline')).toBeVisible();
	await expect(page.getByTestId('desktop-pipeline')).toBeHidden();

	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth
	);
	expect(overflow).toBeLessThanOrEqual(1);

	for (const stage of ['Requests', 'Automation', 'Media']) {
		const heading = page.getByRole('heading', { name: stage, exact: true });
		await heading.scrollIntoViewIfNeeded();
		await expect(heading).toBeVisible();
	}
});
