import { expect, test } from '@playwright/test';

/**
 * Incident lifecycle journeys (v0.8): an operator acknowledges an ACTIVE
 * finding, the detector resolves it after verified recovery (live, no
 * reload), the resolved incident moves through Resolved → Archived, the
 * bulk "Clear resolved" control works, and the System page exposes the
 * DUMBscope runtime self-monitoring panel.
 *
 * Uses the mock gateway's RSS control with the DUMBSCOPE_RELIABILITY_FAST
 * clock (seconds-scale persistence windows) for deterministic opens/resolves.
 */
const MOCK_URL = 'http://127.0.0.1:3105';

async function setRss(name: string, bytes: number | null): Promise<void> {
	const res = await fetch(`${MOCK_URL}/__control/rss`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name, bytes })
	});
	if (!res.ok) throw new Error(`rss control failed: ${res.status}`);
}

const FINDING = /Decypharr memory use is unusually high/;

test('lifecycle: acknowledge → verified recovery → archive → clear, with live updates', async ({
	page
}) => {
	test.setTimeout(300_000);
	await page.goto('/incidents');

	// Tabs and header counts are always present.
	await expect(page.getByRole('navigation').getByText('Active')).toBeVisible();
	await expect(page.getByText(/acknowledged/).first()).toBeVisible();

	// Open the drawer of the ACTIVE finding (acknowledge from there).
	await setRss('Decypharr', Math.round(4.2 * 1024 ** 3));
	let restored = false;
	try {
		const openList = page.getByTestId('open-incidents');
		await expect(openList.getByTestId('incident-row').filter({ hasText: FINDING })).toBeVisible({
			timeout: 90_000
		});

		// Acknowledge from the row: it moves off the Active tab (which shows
		// only active problems) into the Acknowledged view, muted and marked
		// as still technically open.
		const targetRow = openList.getByTestId('incident-row').filter({ hasText: FINDING });
		await targetRow.getByTestId('row-acknowledge').click();
		await expect(openList.getByTestId('incident-row').filter({ hasText: FINDING })).toHaveCount(0, {
			timeout: 10_000
		});

		await page.getByRole('navigation').getByText('Acknowledged').click();
		const ackRow = page
			.getByTestId('open-incidents')
			.getByTestId('incident-row')
			.filter({ hasText: FINDING });
		await expect(ackRow).toBeVisible();
		await expect(ackRow).toHaveAttribute('data-incident-status', 'acknowledged');
		await expect(ackRow.getByText('acknowledged', { exact: true })).toBeVisible();

		// The Active tab shows no open problems now.
		await page.getByRole('navigation').getByText('Active', { exact: true }).click();
		await expect(page.getByTestId('open-incidents').getByTestId('incident-row')).toHaveCount(0, {
			timeout: 10_000
		});

		// Detector-verified recovery: the acknowledged incident resolves live.
		await setRss('Decypharr', null);
		restored = true;
		await page.getByRole('navigation').getByText('Acknowledged').click();
		await expect(
			page.getByTestId('open-incidents').getByTestId('incident-row').filter({ hasText: FINDING })
		).toHaveCount(0, { timeout: 90_000 });

		// The resolved incident is in the Resolved history with a truthful
		// "recovered" banner, and archives from there.
		await page.getByRole('navigation').getByText('Resolved').click();
		const history = page.getByTestId('history-list');
		await expect(history.getByText(/Decypharr memory use is unusually high/)).toBeVisible({
			timeout: 15_000
		});
		await history.getByRole('button').first().click();
		await expect(page.getByText('Recovered — verified by detector')).toBeVisible({
			timeout: 10_000
		});
		await page.getByRole('dialog').getByRole('button', { name: 'Archive' }).click();
		// The drawer subtitle flips to archived while the banner stays honest:
		// this incident WAS recovered; archiving is operator bookkeeping.
		await expect(page.getByRole('dialog').getByText('WARNING · archived')).toBeVisible({
			timeout: 10_000
		});
		// Close the drawer before navigating on.
		await page.keyboard.press('Escape');
		await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 10_000 });

		// Archived tab holds the record.
		await page.getByRole('navigation').getByText('Archived').click();
		await expect(
			page.getByTestId('history-list').getByText(/Decypharr memory use is unusually high/)
		).toBeVisible({ timeout: 10_000 });

		// Bulk "Clear resolved": produce a second resolved record first (open
		// verified on the Active tab, then recovered), then archive every
		// resolved incident in one action.
		await setRss('Decypharr', Math.round(4.2 * 1024 ** 3));
		await page.getByRole('navigation').getByText('Active', { exact: true }).click();
		await expect(
			page.getByTestId('open-incidents').getByTestId('incident-row').filter({ hasText: FINDING })
		).toBeVisible({ timeout: 60_000 });
		await setRss('Decypharr', null);
		await page.getByRole('navigation').getByText('Resolved').click();
		await expect(
			page.getByTestId('history-list').getByText(/Decypharr memory use is unusually high/)
		).toBeVisible({ timeout: 90_000 });
		await page.getByRole('button', { name: /Clear resolved/ }).click();
		await page.getByRole('button', { name: 'All resolved' }).click();
		await expect(page.getByTestId('history-list')).toHaveCount(0, { timeout: 10_000 });
		await expect(page.getByText('No resolved incidents')).toBeVisible();
	} finally {
		if (!restored) await setRss('Decypharr', null).catch(() => {});
	}
});

test('runtime: System page shows the DUMBscope self-monitoring panel', async ({ page }) => {
	test.setTimeout(60_000);
	await page.goto('/system');
	await expect(page.getByText('DUMBscope runtime', { exact: true })).toBeVisible({
		timeout: 30_000
	});
	// Vitals grid renders current sampled values.
	await expect(page.getByText('Process RSS', { exact: true })).toBeVisible();
	await expect(page.getByText('Worker threads', { exact: true })).toBeVisible();
	await expect(page.getByText('Event-loop lag', { exact: true })).toBeVisible();
	await expect(page.getByText('SSE clients', { exact: true })).toBeVisible();
	// Reconciliation observability block.
	await expect(page.getByText('Library reconciliation', { exact: true })).toBeVisible();
	// Lifecycle safety net heartbeat.
	await expect(page.getByText('Lifecycle safety net', { exact: true })).toBeVisible();
	// The runtime API feeds the panel with trend estimates.
	const response = await page.waitForResponse(
		(r) => r.url().includes('/api/runtime') && r.status() === 200,
		{ timeout: 15_000 }
	);
	const payload = (await response.json()) as { current: { sample: { rssBytes: number | null } } };
	expect(payload.current.sample.rssBytes).toBeGreaterThan(0);
});
