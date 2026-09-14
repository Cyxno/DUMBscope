import { expect, test } from '@playwright/test';

/**
 * Connectivity reliability journey (brief §8/§12/§144/§214).
 *
 * The mock DUMB gateway really goes away (sockets destroyed, requests
 * refused) and comes back. DUMBscope must: report honest amber recovery
 * states instead of a false red, never claim "unreachable" inside the
 * recovery window, and return to CONNECTED entirely on its own — no browser
 * reload, no manual refresh.
 */
const MOCK_URL = 'http://127.0.0.1:3105';

async function setGateway(down: boolean): Promise<void> {
	const res = await fetch(`${MOCK_URL}/__control/${down ? 'down' : 'up'}`, { method: 'POST' });
	if (!res.ok) throw new Error(`gateway control failed: ${res.status}`);
}

test('DUMB outage: amber reconnect banner, automatic recovery, honest layer detail', async ({
	page
}) => {
	test.setTimeout(150_000);
	// Never leave the gateway down for the rest of the suite.
	let restored = false;
	try {
		await page.goto('/');

		// Baseline: connected and telemetry flowing.
		const indicator = page.getByRole('button', { name: /Connection status/i });
		await expect(indicator).toHaveText(/CONNECTED/, { timeout: 30_000 });
		await expect(
			page.getByRole('heading', { name: 'All services are running normally' })
		).toBeVisible();

		// The gateway disappears (a "reboot"): TCP sockets are destroyed.
		await setGateway(true);

		// Amber recovery semantics — reconnecting/partial, never a red outage
		// banner inside the recovery window (brief §12).
		await expect(indicator).not.toHaveText(/CONNECTED/, { timeout: 30_000 });
		await expect(page.getByText('DUMB is currently unreachable')).toHaveCount(0);
		await expect(page.getByText(/Reconnecting to DUMB/).first()).toBeVisible({ timeout: 30_000 });

		// The indicator popover tells the honest per-layer story while
		// reconnecting (brief §9/§10).
		await indicator.click();
		const dialog = page.getByRole('dialog', { name: 'Connection details' });
		await expect(dialog.getByText('Last successful contact', { exact: true })).toBeVisible();
		await expect(dialog.getByText('Reconnecting to DUMB · last successful contact')).toBeVisible();

		// The gateway returns — DUMBscope must recover by itself.
		await setGateway(false);
		restored = true;
		await expect(indicator).toHaveText(/CONNECTED/, { timeout: 90_000 });
		await expect(page.getByText(/Reconnecting to DUMB/).first()).toHaveCount(0);

		// The popover now tells the fully-restored story.
		await indicator.click();
		await expect(page.getByText('Connected — telemetry is updating.')).toBeVisible();
	} finally {
		if (!restored) await setGateway(false).catch(() => {});
	}
});

test('system page: DUMB connection diagnostics card reflects the live state', async ({ page }) => {
	test.setTimeout(60_000);
	await page.goto('/system');

	await expect(page.getByText('DUMB connection', { exact: true })).toBeVisible({
		timeout: 30_000
	});
	// Per-layer rows exist (brief §10)…
	for (const layer of ['HTTP', 'Auth', 'REST', 'Status stream', 'Metrics stream']) {
		await expect(page.getByText(layer, { exact: true })).toBeVisible();
	}
	// …plus the contact bookkeeping (brief §9).
	await expect(page.getByText('Last successful contact', { exact: true })).toBeVisible();
	await expect(page.getByText('Last telemetry update', { exact: true })).toBeVisible();
});
