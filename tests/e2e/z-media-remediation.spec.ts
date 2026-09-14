import { expect, test, type Page } from '@playwright/test';

/**
 * DEEL 2 journeys: cross-service media correlation and the bounded
 * remediation foundation. Runs against the mock stack with the
 * DUMBSCOPE_RELIABILITY_FAST clock.
 *
 * 1. Item missing + acquisition active → the library drawer shows Acquiring.
 * 2. Repeated request → finding visible + item detail evidence.
 * 3. Memory anomaly → recommended action appears.
 * 4. Review restart → confirmation modal → mock action → verifying → success.
 * 5. Verification failure → the action is never labelled successful.
 * 6. Cooldown visible after an executed action.
 */
const MOCK_URL = 'http://127.0.0.1:3105';
const SONARR_URL = 'http://127.0.0.1:4211';

async function setFlow(grabs: unknown[], missingIds: number[] | null): Promise<void> {
	const res = await fetch(`${SONARR_URL}/__control/media-flow`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ grabs, missingIds })
	});
	if (!res.ok) throw new Error(`media-flow control failed: ${res.status}`);
}

async function setRestartFail(fail: boolean): Promise<void> {
	const res = await fetch(`${MOCK_URL}/__control/restart-fail`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ fail })
	});
	if (!res.ok) throw new Error(`restart control failed: ${res.status}`);
}

async function openSeriesDrawer(page: Page): Promise<void> {
	await page.goto('/library?view=tv');
	const grid = page.locator('ul.grid');
	await grid.locator('button', { hasText: 'Dark Meadow' }).first().click();
	const drawer = page.locator('[role=dialog]');
	await expect(drawer).toBeVisible();
}

test('acquisition active: item flow shows Acquiring and repeated request finding opens', async ({
	page
}) => {
	test.setTimeout(120_000);
	// Dark Meadow S02E07: grabbed twice in the last 20 minutes, never
	// imported, still on the Arr missing list (the production loop shape).
	await setFlow(
		[
			{ downloadId: 'req-1', episodeId: 4043, seriesId: 4, ageMin: 20, client: 'SABnzbd' },
			{ downloadId: 'req-2', episodeId: 4043, seriesId: 4, ageMin: 5, client: 'SABnzbd' }
		],
		[4043]
	);

	// The System media-state card correlates the flow…
	await page.goto('/system');
	await expect(page.getByText(/2 requests/).first()).toBeVisible({ timeout: 60_000 });

	// …and the finding opens in the incident list.
	await page.goto('/incidents');
	await expect(page.getByText(/repeated acquisition request/).first()).toBeVisible({
		timeout: 60_000
	});

	// The library drawer carries the per-item evidence.
	await openSeriesDrawer(page);
	const drawer = page.locator('[role=dialog]');
	await expect(drawer.getByText('Media flow')).toBeVisible({ timeout: 30_000 });
	await expect(drawer.getByText('Acquiring')).toBeVisible();
	await expect(drawer.getByText(/Repeated request detected/)).toBeVisible();
});

test('memory anomaly: recommendation, confirmation modal, execution, verification and cooldown', async ({
	page
}) => {
	test.setTimeout(180_000);
	// Sustained anomaly on a managed, running service → recommendation only.
	const res = await fetch(`${MOCK_URL}/__control/rss`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name: 'rclone w/ InfiniDysk', bytes: Math.round(4.2 * 1024 ** 3) })
	});
	if (!res.ok) throw new Error('rss control failed');
	let restored = false;
	try {
		await page.goto('/system');
		const review = page.getByRole('button', { name: 'Review…' }).first();
		await expect(review).toBeVisible({ timeout: 90_000 });

		// Journey 5 first: the mock gateway rejects the restart — the action
		// must never be labelled successful.
		await setRestartFail(true);
		await review.click();
		const dialog = page.getByRole('dialog', { name: 'Confirm restart' });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText(/Only this managed service will be restarted/)).toBeVisible();
		await expect(dialog.getByText(/Current evidence:/)).toBeVisible();
		await dialog.getByRole('button', { name: 'Restart service' }).click();
		await expect(page.getByText(/did not accept|rejected/i).first()).toBeVisible({
			timeout: 30_000
		});
		await setRestartFail(false);

		// Journey 4: accepted restart → verifying → verified success.
		await page.getByRole('button', { name: 'Review…' }).first().click();
		await page
			.getByRole('dialog', { name: 'Confirm restart' })
			.getByRole('button', { name: 'Restart service' })
			.click();
		await expect(page.getByText(/Restart accepted for rclone w\/ InfiniDysk/)).toBeVisible({
			timeout: 30_000
		});
		await page.getByText('Recent actions').click();
		await expect(page.getByText(/rclone w\/ InfiniDysk · succeeded/).first()).toBeVisible({
			timeout: 60_000
		});
		// Journey 6: the executed action carries its cooldown window.
		await expect(page.getByText(/cooldown/i).first()).toBeVisible({ timeout: 30_000 });
		restored = true;
	} finally {
		await fetch(`${MOCK_URL}/__control/rss`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'rclone w/ InfiniDysk', bytes: null })
		}).catch(() => {});
		if (!restored) await setRestartFail(false).catch(() => {});
	}
});
