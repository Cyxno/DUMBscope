import { expect, test } from '@playwright/test';

test('reduced motion: pipeline renders with no running animations', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/pipeline');
	await expect(page.getByRole('button', { name: 'Sonarr: Healthy' })).toBeVisible();

	const animating = await page.evaluate(() => {
		const nodes = document.querySelectorAll<HTMLElement>('button, [role="dialog"], svg *');
		let running = 0;
		nodes.forEach((el) => {
			const cs = getComputedStyle(el);
			if (cs.animationName !== 'none' && cs.animationPlayState !== 'paused') running += 1;
		});
		return running;
	});
	expect(animating).toBe(0);

	// Status stays fully understandable without motion.
	await expect(page.getByRole('heading', { name: 'Storage', exact: true })).toBeVisible();
});
