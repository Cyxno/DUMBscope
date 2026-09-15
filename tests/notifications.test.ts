/**
 * Alerts & Notifications (§18): filter matching, severity/category matching,
 * dedupe/escalation/resolution/reopen, quiet hours with critical bypass,
 * Discord/Telegram delivery success+failure, retry on transient errors, rate
 * limiting, secret masking and browser pickup. Uses the isolated test DB and
 * a stubbed global fetch — no real outbound traffic.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { NotificationEvent } from '../src/lib/shared/notifications';
import {
	dedupeDecision,
	processEvent,
	quietDecision,
	ruleMatches,
	type NotificationEventInput
} from '../src/lib/server/notifications/engine';
import {
	enqueueDelivery,
	processQueueOnce,
	stopWorker
} from '../src/lib/server/notifications/queue';
import {
	createDestination,
	createRule,
	deleteRule,
	getDestination,
	listHistory,
	maskedConfig
} from '../src/lib/server/notifications/store';
import { getDb } from '../src/lib/server/database/db';
import type { DestinationRecord } from '../src/lib/server/notifications/store';

function eventInput(overrides: Partial<NotificationEventInput> = {}): NotificationEventInput {
	return {
		action: 'opened',
		severity: 'warning',
		category: 'mount',
		service: null,
		title: 'TV symlink root: missing',
		summary: 'Configured mount path does not exist',
		fingerprint: 'mount:test',
		deepLink: '/system',
		at: Date.now(),
		...overrides
	};
}

async function discordDestination(
	overrides: Partial<{ url: string }> = {}
): Promise<DestinationRecord> {
	return createDestination({
		kind: 'discord',
		label: 'Discord test',
		enabled: true,
		config: { webhookUrl: overrides.url ?? 'https://discord.example/api/webhooks/1/abc' }
	});
}

function telegramDestination(): DestinationRecord {
	return createDestination({
		kind: 'telegram',
		label: 'Telegram test',
		enabled: true,
		config: { botToken: '12345:abcdef', chatId: '-10042' }
	});
}

function fullRule(
	destinationId: string,
	overrides: Partial<Parameters<typeof createRule>[0]> = {}
) {
	return createRule({
		label: 'Test rule',
		enabled: true,
		preset: 'custom',
		severities: ['info', 'attention', 'warning', 'critical'],
		categories: [],
		services: [],
		events: ['opened', 'escalated', 'resolved', 'reopened'],
		destinationIds: [destinationId],
		cooldownMinutes: 60,
		quietEnabled: false,
		quietStart: null,
		quietEnd: null,
		quietTimezone: null,
		quietBehavior: 'defer',
		ratePerMinute: null,
		...overrides
	});
}

beforeEach(() => {
	stopWorker();
	vi.restoreAllMocks();
	const db = getDb();
	db.prepare('DELETE FROM notification_rules').run();
	db.prepare('DELETE FROM notification_destinations').run();
	db.prepare('DELETE FROM notification_history').run();
	db.prepare('DELETE FROM notification_dedupe').run();
	db.prepare('DELETE FROM notification_browser_deliveries').run();
});

afterEach(() => {
	stopWorker();
});

describe('rule matching (§3/§4)', () => {
	const rule = {
		enabled: true,
		severities: ['warning', 'critical'] as ('warning' | 'critical')[],
		categories: ['mount'] as 'mount'[],
		services: [] as string[],
		destinationIds: ['d1'],
		events: ['opened', 'escalated'] as ('opened' | 'escalated')[]
	};

	it('matches severity, category and event', () => {
		expect(ruleMatches(rule, eventInput())).toBe(true);
		expect(ruleMatches(rule, eventInput({ severity: 'info' }))).toBe(false);
		expect(ruleMatches(rule, eventInput({ category: 'memory' }))).toBe(false);
	});

	it('empty filter lists mean everything', () => {
		const open = { ...rule, severities: [], categories: [] };
		expect(ruleMatches(open, eventInput({ severity: 'info' }))).toBe(true);
	});

	it('service allowlist admits only listed services', () => {
		const serviceBound = { ...rule, services: ['sonarr'], categories: [] };
		expect(ruleMatches(serviceBound, eventInput({ category: 'service', service: 'sonarr' }))).toBe(
			true
		);
		expect(ruleMatches(serviceBound, eventInput({ category: 'service', service: 'radarr' }))).toBe(
			false
		);
		// A service-bound rule never matches findings without a service.
		expect(ruleMatches(serviceBound, eventInput({ service: null }))).toBe(false);
	});

	it('disabled rules and rules without destinations never match', () => {
		expect(ruleMatches({ ...rule, enabled: false }, eventInput())).toBe(false);
		expect(ruleMatches({ ...rule, destinationIds: [] }, eventInput())).toBe(false);
	});
});

describe('dedupe (§5)', () => {
	it('notifies first open, suppresses repeats, notifies escalation', () => {
		const events: NotificationEvent[] = ['opened', 'escalated', 'resolved', 'reopened'];
		const first = dedupeDecision(events, 60, eventInput(), null);
		expect(first).toMatchObject({ event: 'opened', notify: true });

		const open = { lastSeverity: 'warning' as const, resolvedAt: null };
		const repeat = dedupeDecision(events, 60, eventInput(), open);
		expect(repeat.notify).toBe(false);

		const escalation = dedupeDecision(events, 60, eventInput({ severity: 'critical' }), open);
		expect(escalation).toMatchObject({ event: 'escalated', notify: true });

		// De-escalation while open is suppressed.
		const deEscalation = dedupeDecision(events, 60, eventInput({ severity: 'warning' }), {
			lastSeverity: 'critical',
			resolvedAt: null
		});
		expect(deEscalation.notify).toBe(false);
	});

	it('resolution is optional and reopen honors the cooldown (§5)', () => {
		const now = Date.now();
		const events: NotificationEvent[] = ['opened', 'escalated', 'resolved', 'reopened'];
		const resolved = dedupeDecision(
			['opened', 'escalated'],
			60,
			eventInput({ action: 'resolved' }),
			{ lastSeverity: 'warning', resolvedAt: null }
		);
		expect(resolved.notify).toBe(false);

		const recoveryRule: NotificationEvent[] = ['opened', 'escalated', 'resolved'];
		expect(
			dedupeDecision(recoveryRule, 60, eventInput({ action: 'resolved' }), {
				lastSeverity: 'warning',
				resolvedAt: null
			}).notify
		).toBe(true);

		const justResolved = { lastSeverity: 'warning' as const, resolvedAt: now - 60_000 };
		const insideCooldown = dedupeDecision(
			events,
			60,
			eventInput({ action: 'opened' }),
			justResolved
		);
		expect(insideCooldown.notify).toBe(false);

		const afterCooldown = dedupeDecision(events, 60, eventInput({ action: 'opened' }), {
			lastSeverity: 'warning',
			resolvedAt: now - 61 * 60_000
		});
		expect(afterCooldown).toMatchObject({ event: 'reopened', notify: true });
	});
});

describe('quiet hours (§6)', () => {
	const base = {
		quietEnabled: true,
		quietStart: '22:30',
		quietEnd: '07:00',
		quietTimezone: null,
		quietBehavior: 'defer' as const,
		destinationKind: 'discord' as const
	};

	// 2026-09-15T23:00:00Z is inside 22:30–07:00 in UTC.
	const atNight = Date.UTC(2026, 8, 15, 23, 0);
	// 12:00 UTC is daytime.
	const atDay = Date.UTC(2026, 8, 15, 12, 0);

	it('delivers outside the window', () => {
		const decision = quietDecision(base, 'warning', atDay);
		expect(decision.deliver).toBe(true);
	});

	it('defers warnings inside the window and delivers them when it ends', () => {
		const decision = quietDecision(base, 'warning', atNight);
		expect(decision.deliver).toBe(false);
		expect(decision.suppress).toBe(false);
		expect(decision.deferUntil).toBeGreaterThan(atNight);
	});

	it('critical always bypasses quiet hours', () => {
		const decision = quietDecision(base, 'critical', atNight);
		expect(decision.deliver).toBe(true);
		expect(decision.suppress).toBe(false);
	});

	it('suppress behavior drops non-critical inside the window', () => {
		const decision = quietDecision({ ...base, quietBehavior: 'suppress' }, 'warning', atNight);
		expect(decision.suppress).toBe(true);
	});

	it('browser destination suppresses non-critical during quiet hours (real-time only)', () => {
		const decision = quietDecision({ ...base, destinationKind: 'browser' }, 'warning', atNight);
		expect(decision.suppress).toBe(true);
	});

	it('invalid timezone never silently enables quiet hours', () => {
		const decision = quietDecision({ ...base, quietTimezone: 'Not/AZone' }, 'warning', atNight);
		expect(decision.deliver).toBe(true);
	});
});

describe('end-to-end through the engine with the test DB', () => {
	it('open → suppress → escalate → resolve → reopen, single destination (§19 shape)', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const destination = await discordDestination();
		fullRule(destination.id, { events: ['opened', 'escalated', 'resolved', 'reopened'] });

		const base = { fingerprint: 'mount:e2e', title: 'Mount finding', deepLink: '/system' };
		// First open → delivered.
		processEvent(eventInput(base));
		await processQueueOnce();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Same warning again → suppressed, no new delivery.
		processEvent(eventInput(base));
		await processQueueOnce();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Escalate to critical → second delivery.
		processEvent(eventInput({ ...base, severity: 'critical' }));
		await processQueueOnce();
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// Resolve → recovery notification (rule includes 'resolved').
		processEvent(eventInput({ ...base, action: 'resolved', severity: 'critical' }));
		await processQueueOnce();
		expect(fetchMock).toHaveBeenCalledTimes(3);

		// Reopen after cooldown → new notification.
		const later = Date.now() - 61 * 60_000;
		getDb()
			.prepare('UPDATE notification_dedupe SET resolved_at = ? WHERE dedupe_key LIKE ?')
			.run(later, '%mount:e2e');
		processEvent(eventInput({ ...base, at: Date.now() }));
		await processQueueOnce();
		expect(fetchMock).toHaveBeenCalledTimes(4);

		const history = listHistory(100);
		const sent = history.filter((h) => h.destinationId === destination.id && h.result === 'sent');
		expect(sent).toHaveLength(4);
		expect(history.some((h) => h.ruleId !== null && h.result === 'suppressed')).toBe(true);
	});

	it('filters exclude non-matching severities entirely', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const destination = await discordDestination();
		fullRule(destination.id, { severities: ['critical'], events: ['opened'] });
		processEvent(eventInput({ fingerprint: 'mount:x', severity: 'warning' }));
		await processQueueOnce();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(listHistory(50).every((h) => h.result !== 'sent')).toBe(true);
	});

	it('Discord failures do not block Telegram and retry only transient errors (§14/§15)', async () => {
		const responses: Response[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('discord')) {
				return responses.shift() ?? new Response('{}', { status: 200 });
			}
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		});
		vi.stubGlobal('fetch', fetchMock);
		const discord = await discordDestination();
		const telegram = telegramDestination();
		fullRule(discord.id, {
			label: 'All Discord',
			destinationIds: [discord.id, telegram.id],
			events: ['opened']
		});

		// Discord 500 (retryable) + Telegram success in the same round.
		responses.push(new Response('{}', { status: 500 }));
		processEvent(eventInput({ fingerprint: 'mount:iso' }));
		await processQueueOnce();
		await new Promise((r) => setTimeout(r, 10));

		// Telegram succeeded despite Discord failing (§15).
		const telegramSent = listHistory(100).some(
			(h) => h.destinationKind === 'telegram' && h.result === 'sent'
		);
		expect(telegramSent).toBe(true);
		// Discord first attempt recorded as deferred-with-retry, not sent.
		const discordRows = listHistory(100).filter((h) => h.destinationId === discord.id);
		expect(discordRows.some((h) => h.result === 'sent')).toBe(false);

		// Retry succeeds once the backoff has elapsed (forced for determinism).
		responses.push(new Response('{}', { status: 200 }));
		await processQueueOnce(true);
		expect(
			listHistory(100).some((h) => h.destinationId === discord.id && h.result === 'sent')
		).toBe(true);
	});

	it('non-retryable client errors fail immediately', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 404 }));
		vi.stubGlobal('fetch', fetchMock);
		const destination = await discordDestination();
		fullRule(destination.id, { label: '404 rule' });
		processEvent(eventInput({ fingerprint: 'mount:404' }));
		await processQueueOnce();
		await new Promise((r) => setTimeout(r, 10));
		await processQueueOnce();
		const failed = listHistory(100).filter((h) => h.result === 'failed');
		expect(failed.length).toBe(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rate cap drops the storm beyond the configured limit (§16)', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const destination = await discordDestination();
		fullRule(destination.id, { ratePerMinute: 2, cooldownMinutes: 0 });
		for (let i = 0; i < 5; i++) {
			// Distinct fingerprints: cooldown stays out of the way, cap kicks in.
			processEvent(eventInput({ fingerprint: `mount:storm-${i}` }));
		}
		await processQueueOnce();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const limited = listHistory(100).filter((h) => h.result === 'rate_limited');
		expect(limited.length).toBe(3);
	});

	it('browser destination records in-app pickups; masked config never leaks secrets (§9/§13)', async () => {
		const browser = createDestination({
			kind: 'browser',
			label: 'Browser',
			enabled: true,
			config: null
		});
		expect(maskedConfig(browser)).toBeNull();

		const discord = await discordDestination({
			url: 'https://discord.com/api/webhooks/123456/abcdef-xyz'
		});
		const masked = maskedConfig(getDestination(discord.id)!);
		expect(Object.values(masked ?? {}).join('')).not.toContain('abcdef-xyz');
		expect(Object.values(masked ?? {}).join('')).toContain('••••');

		const telegram = telegramDestination();
		const telegramMasked = maskedConfig(getDestination(telegram.id)!);
		expect(JSON.stringify(telegramMasked)).not.toContain('12345:abcdef');
		expect(telegramMasked?.chatId).toBe('-10042');

		fullRule(browser.id, { label: 'Browser rule', destinationIds: [browser.id] });
		processEvent(eventInput({ fingerprint: 'mount:browser' }));
		await processQueueOnce();
		const deliveries = getDb()
			.prepare('SELECT * FROM notification_browser_deliveries')
			.all() as unknown[];
		expect(deliveries.length).toBe(1);
	});

	it('disabled destinations are skipped', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const destination = await discordDestination();
		updateDisabled(destination.id);
		fullRule(destination.id, { cooldownMinutes: 0 });
		processEvent(eventInput({ fingerprint: 'mount:disabled' }));
		await processQueueOnce();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('deleteRule stops deliveries', async () => {
		const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const destination = await discordDestination();
		const rule = fullRule(destination.id, { cooldownMinutes: 0 });
		deleteRule(rule.id);
		processEvent(eventInput({ fingerprint: 'mount:deleted' }));
		await processQueueOnce();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

function updateDisabled(id: string): void {
	getDb().prepare('UPDATE notification_destinations SET enabled = 0 WHERE id = ?').run(id);
}

// Keep the import surface honest: enqueueDelivery is exercised through
// processEvent, and this reference prevents tree-shaking complaints in strict
// lint setups.
void enqueueDelivery;
