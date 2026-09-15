import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Alerts & Notifications end-to-end (§19): a real finding walks the whole
 * pipeline — rule matching → dedupe → queue → destination — against mock
 * Discord/Telegram endpoints (tests/mock-notifications). Uses the memory
 * finding (same fingerprint across warning → critical) for the escalation
 * step, and the browser destination for the in-app notification flow.
 *
 * No real Discord/Telegram traffic ever leaves the machine.
 */

const MOCK_NOTIF = 'http://127.0.0.1:4214';
const MOCK_DUMB = 'http://127.0.0.1:3105';
const WEBHOOK_URL = `${MOCK_NOTIF}/discord/gw-hook`;

async function setRss(name: string, bytes: number | null): Promise<void> {
	const res = await fetch(`${MOCK_DUMB}/__control/rss`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ name, bytes })
	});
	if (!res.ok) throw new Error(`rss control failed: ${res.status}`);
}

type Received = { channel: string; body: string };

async function received(request: APIRequestContext): Promise<Received[]> {
	const res = await request.get(`${MOCK_NOTIF}/_received`);
	return (await res.json()).received as Received[];
}

async function waitForReceived(
	request: APIRequestContext,
	minDiscord: number,
	minTelegram: number,
	timeoutMs = 120_000
): Promise<Received[]> {
	const deadline = Date.now() + timeoutMs;
	let current = await received(request);
	for (;;) {
		const discord = current.filter((r) => r.channel === 'discord').length;
		const telegram = current.filter((r) => r.channel === 'telegram').length;
		if (discord >= minDiscord && telegram >= minTelegram) return current;
		if (Date.now() > deadline) {
			throw new Error(
				`expected ≥${minDiscord} discord / ≥${minTelegram} telegram deliveries, got ${discord}/${telegram}`
			);
		}
		await page.waitForTimeout(2000);
		current = await received(request);
	}
}

let page: Page;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
});

async function api(): Promise<APIRequestContext> {
	return page.request;
}

test('notification pipeline: configure → open → suppress → escalate → resolve → recovery → browser (§19)', async () => {
	test.setTimeout(600_000);
	const request = await api();

	// Isolate the mock and start from clean notification config.
	await request.post(`${MOCK_NOTIF}/_reset`);
	await request.delete('/api/notifications/destinations/x').catch(() => {});
	for (const destination of (await (await request.get('/api/notifications/destinations')).json())
		.destinations) {
		await request.delete(`/api/notifications/destinations/${destination.id}`);
	}
	for (const rule of (await (await request.get('/api/notifications/rules')).json()).rules) {
		await request.delete('/api/notifications/rules', { data: { id: rule.id } });
	}

	// Secret protection invariant: the destinations API never returns secrets.
	const secretsProbe = await request.post('/api/notifications/destinations', {
		data: {
			kind: 'discord',
			label: 'Discord E2E',
			config: { webhookUrl: WEBHOOK_URL }
		}
	});
	expect(secretsProbe.ok()).toBeTruthy();
	const secretBody = await secretsProbe.text();
	expect(secretBody).not.toContain(WEBHOOK_URL);

	// Telegram destination pointed at the mock Bot API.
	const telegramRes = await request.post('/api/notifications/destinations', {
		data: {
			kind: 'telegram',
			label: 'Telegram E2E',
			config: {
				botToken: '123456:e2e-token',
				chatId: '-10042',
				apiBase: `${MOCK_NOTIF}/telegram`
			}
		}
	});
	expect(telegramRes.ok()).toBeTruthy();

	// First destination auto-created a "Warnings + Critical" rule; widen it to
	// all events and both destinations for this journey.
	const rules = (await (await request.get('/api/notifications/rules')).json()).rules;
	expect(rules.length).toBe(1);
	const rule = rules[0];
	expect(rule.destinationIds.length).toBe(1);
	const ruleRes = await request.put('/api/notifications/rules', {
		data: {
			...rule,
			events: ['opened', 'escalated', 'resolved', 'reopened'],
			cooldownMinutes: 0,
			destinationIds: rules[0].destinationIds.concat([
				(
					(await (await request.get('/api/notifications/destinations')).json()).destinations as {
						id: string;
						kind: string;
					}[]
				).find((d) => d.kind === 'telegram')!.id
			])
		}
	});
	expect(ruleRes.ok()).toBeTruthy();

	// A browser destination joins the rule for the in-app flow.
	const browserRes = await request.post('/api/notifications/destinations', {
		data: { kind: 'browser', label: 'Browser E2E' }
	});
	expect(browserRes.ok()).toBeTruthy();
	const destinationsNow = (await (await request.get('/api/notifications/destinations')).json())
		.destinations as { id: string; kind: string }[];
	const allIds = destinationsNow.map((d) => d.id);
	await request.put('/api/notifications/rules', {
		data: {
			...(await (await request.get('/api/notifications/rules')).json()).rules[0],
			destinationIds: allIds
		}
	});

	// Memory thresholds: warning 3.5 GB, critical 4.5 GB (defaults).
	await request.patch('/api/settings', {
		data: { memoryWarningGb: 3.5, memoryCriticalGb: 4.5 }
	});

	// Baseline must exist before thresholds can trip (fast clock builds it in
	// a handful of samples).
	await page.goto('/system');
	await expect(page.getByText('Memory anomalies', { exact: true })).toBeVisible({
		timeout: 60_000
	});

	// --- Open at warning severity → one delivery per destination. ---
	await setRss('InfiniDysk', Math.round(4.2 * 1024 ** 3));
	let current = await waitForReceived(request, 1, 1);
	expect(current.filter((r) => r.channel === 'discord')).toHaveLength(1);
	expect(current[0]!.body).toContain('InfiniDysk memory use is unusually high');

	// --- Same warning again → suppressed, no new deliveries. ---
	await page.waitForTimeout(20_000);
	expect((await received(request)).filter((r) => r.channel === 'discord')).toHaveLength(1);

	// --- Escalate: lower the critical bar so 4.2 GB now crosses it. ---
	const threshold = await request.patch('/api/settings', {
		data: { memoryCriticalGb: 4.0 }
	});
	expect(threshold.ok()).toBeTruthy();
	current = await waitForReceived(request, 2, 2);
	const escalatedBody = current.filter((r) => r.channel === 'discord')[1]!.body;
	expect(escalatedBody.toLowerCase()).toContain('infinidysk');

	// --- Resolve: RSS back to baseline → recovery notification. ---
	await setRss('InfiniDysk', null);
	current = await waitForReceived(request, 3, 3);

	// --- History explains every decision (§12). ---
	const history = (await (await request.get('/api/notifications/history?limit=100')).json())
		.history as { result: string; title: string; destinationKind: string | null; event: string }[];
	expect(history.some((h) => h.result === 'sent' && h.event === 'escalated')).toBe(true);
	expect(history.some((h) => h.result === 'sent' && h.event === 'resolved')).toBe(true);
	expect(history.some((h) => h.result === 'suppressed')).toBe(true);

	// --- Test button: fires a direct test delivery (§11). ---
	const destinations = (await (await request.get('/api/notifications/destinations')).json())
		.destinations as {
		id: string;
		kind: string;
		enabled: boolean;
		configured: boolean;
		configMasked: Record<string, string> | null;
		lastDelivery: { at: number; result: string } | null;
	}[];
	const discord = destinations.find((d) => d.kind === 'discord')!;
	expect(discord.configured).toBe(true);
	// Masked, never the real URL (§13).
	expect(JSON.stringify(discord.configMasked)).not.toContain(WEBHOOK_URL);
	const testRes = await request.post(`/api/notifications/destinations/${discord.id}/test`);
	expect((await testRes.json()).ok).toBe(true);
	await waitForReceived(request, 4, 3);
	const refreshed = (await (await request.get('/api/notifications/destinations')).json())
		.destinations as { id: string; lastDelivery: { result: string } | null }[];
	expect(refreshed.find((d) => d.id === discord.id)?.lastDelivery?.result).toBe('sent');

	// --- Browser destination: in-app pickup through the open client (§9). ---
	// Shim Notification so headless runs can count constructions; the client
	// only shows notifications when permission is granted.
	await page.addInitScript(() => {
		(window as unknown as { __notifCount: number }).__notifCount = 0;
		class FakeNotification {
			static permission = 'granted';
			constructor(
				public title: string,
				public options?: NotificationOptions
			) {
				(window as unknown as { __notifCount: number }).__notifCount += 1;
			}
			onclick: (() => void) | null = null;
			close(): void {}
		}
		(window as unknown as { Notification: unknown }).Notification = FakeNotification;
	});
	await page.goto('/system');
	await page.waitForTimeout(1000);

	// New finding on a different process: fresh fingerprint → opened.
	await request.patch('/api/settings', { data: { memoryWarningGb: 0.5, memoryCriticalGb: 4.0 } });
	await setRss('Sonarr', Math.round(1024 ** 3));
	const before = await page.evaluate(
		() => (window as unknown as { __notifCount: number }).__notifCount
	);
	await expect
		.poll(
			async () => page.evaluate(() => (window as unknown as { __notifCount: number }).__notifCount),
			{ timeout: 120_000, intervals: [2000] }
		)
		.toBeGreaterThan(before);
	await waitForReceived(request, 5, 4);

	// Restore the world.
	await request.patch('/api/settings', { data: { memoryWarningGb: 3.5, memoryCriticalGb: 4.5 } });
	await setRss('Sonarr', null);
	await setRss('InfiniDysk', null);

	// Leave no active findings behind: later specs (overview hero) assert a
	// quiet stack, and memory findings resolve with hysteresis rounds.
	await expect
		.poll(
			async () => {
				const res = await request.get('/api/incidents');
				const body = (await res.json()) as { incidents: { status: string }[] };
				return body.incidents.filter((incident) => incident.status === 'active').length;
			},
			{ timeout: 180_000, intervals: [3000] }
		)
		.toBe(0);
});
