/**
 * Bounded delivery queue for notification destinations (§14/§15/§16).
 *
 * - Deliveries are independent: one destination failing never blocks another,
 *   never blocks findings, never crashes the app.
 * - Retries only on transient failures (429 / 5xx / network-timeout) with
 *   exponential backoff and a hard attempt cap — no infinite retry.
 * - The queue is bounded; overflow drops the oldest pending item instead of
 *   growing without limit.
 * - Secrets live only inside the destination record and are used server-side
 *   at delivery time; they are never logged.
 */
import type { DestinationRecord } from './store';
import { addBrowserDelivery, recordHistory } from './store';
import type {
	NotificationCategory,
	NotificationEvent,
	NotificationSeverity
} from '$lib/shared/notifications';

export interface DeliveryPayload {
	event: NotificationEvent;
	severity: NotificationSeverity;
	category: NotificationCategory;
	service: string | null;
	title: string;
	summary: string | null;
	deepLink: string;
	at: number;
	deferUntil: number | null;
}

interface QueueItem {
	destination: DestinationRecord;
	payload: DeliveryPayload;
	rule: { id: string; label: string };
	attempts: number;
	nextAttemptAt: number;
}

const MAX_QUEUE = 200;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [30_000, 120_000, 480_000];
const DELIVER_TIMEOUT_MS = 10_000;

const queue: QueueItem[] = [];
let processing = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function queueDepth(): number {
	return queue.length;
}

export function enqueueDelivery(item: {
	destination: DestinationRecord;
	payload: DeliveryPayload;
	rule: { id: string; label: string };
}): void {
	if (queue.length >= MAX_QUEUE) queue.shift(); // drop oldest under storm
	queue.push({
		destination: item.destination,
		payload: item.payload,
		rule: item.rule,
		attempts: 0,
		nextAttemptAt: item.payload.deferUntil ?? 0
	});
	ensureWorker();
}

function ensureWorker(): void {
	if (timer) return;
	timer = setInterval(() => void processQueueOnce(), 2_500);
	timer.unref?.();
}

/** Stop the background worker and drop all pending items (tests). */
export function stopWorker(): void {
	if (timer) clearInterval(timer);
	timer = null;
	queue.length = 0;
	processing = false;
}

/** One drain pass; exported for tests. `force` treats backed-off items as due. */
export async function processQueueOnce(force = false): Promise<void> {
	if (processing) return;
	processing = true;
	try {
		const now = Date.now();
		const due = force ? [...queue] : queue.filter((item) => item.nextAttemptAt <= now);
		for (const item of due) {
			const index = queue.indexOf(item);
			if (index === -1) continue;
			queue.splice(index, 1);
			const result = await deliverNow(item.destination, item.payload).catch((err) => ({
				ok: false,
				error: err instanceof Error ? err.message : String(err),
				retryable: false
			}));
			if (result.ok) {
				recordHistory({
					at: Date.now(),
					event: item.payload.event,
					destinationId: item.destination.id,
					destinationKind: item.destination.kind,
					ruleId: item.rule.id,
					ruleLabel: item.rule.label,
					severity: item.payload.severity,
					category: item.payload.category,
					service: item.payload.service,
					title: item.payload.title,
					summary: item.payload.summary,
					result: 'sent',
					error: null,
					deepLink: item.payload.deepLink
				});
				continue;
			}
			const retryable = result.retryable && item.attempts + 1 < MAX_ATTEMPTS;
			if (retryable) {
				const backoff = BACKOFF_MS[Math.min(item.attempts, BACKOFF_MS.length - 1)] ?? 30_000;
				queue.push({ ...item, attempts: item.attempts + 1, nextAttemptAt: Date.now() + backoff });
				recordHistory({
					at: Date.now(),
					event: item.payload.event,
					destinationId: item.destination.id,
					destinationKind: item.destination.kind,
					ruleId: item.rule.id,
					ruleLabel: item.rule.label,
					severity: item.payload.severity,
					category: item.payload.category,
					service: item.payload.service,
					title: item.payload.title,
					summary: item.payload.summary,
					result: 'deferred',
					error: `attempt ${item.attempts + 1} failed, retrying: ${result.error}`,
					deepLink: item.payload.deepLink
				});
			} else {
				recordHistory({
					at: Date.now(),
					event: item.payload.event,
					destinationId: item.destination.id,
					destinationKind: item.destination.kind,
					ruleId: item.rule.id,
					ruleLabel: item.rule.label,
					severity: item.payload.severity,
					category: item.payload.category,
					service: item.payload.service,
					title: item.payload.title,
					summary: item.payload.summary,
					result: 'failed',
					error: result.error,
					deepLink: item.payload.deepLink
				});
			}
		}
	} finally {
		processing = false;
	}
}

export interface DeliveryResult {
	ok: boolean;
	error: string | null;
	retryable: boolean;
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

function timeoutSignal(): AbortSignal {
	return AbortSignal.timeout(DELIVER_TIMEOUT_MS);
}

/** Deliver one payload to one destination right now (used by queue + test). */
export async function deliverNow(
	destination: DestinationRecord,
	payload: DeliveryPayload
): Promise<DeliveryResult> {
	try {
		switch (destination.kind) {
			case 'browser':
				return deliverBrowser(destination, payload);
			case 'discord':
				return await deliverDiscord(destination, payload);
			case 'telegram':
				return await deliverTelegram(destination, payload);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const timeout = message.includes('timeout') || message.includes('aborted');
		return { ok: false, error: message.slice(0, 300), retryable: timeout };
	}
}

function deliverBrowser(destination: DestinationRecord, payload: DeliveryPayload): DeliveryResult {
	// In-app destination: recorded for the open client to pick up on its next
	// poll. The client only shows notifications after explicitly granting the
	// browser Notification permission (§9).
	addBrowserDelivery({
		at: Date.now(),
		severity: payload.severity,
		title: payload.title,
		summary: payload.summary,
		deepLink: payload.deepLink
	});
	return { ok: true, error: null, retryable: false };
}

const SEVERITY_COLORS: Record<NotificationSeverity, number> = {
	info: 0x38bdf8,
	attention: 0xf59e0b,
	warning: 0xf59e0b,
	critical: 0xef4444
};

function severityLabel(severity: NotificationSeverity): string {
	return severity.charAt(0).toUpperCase() + severity.slice(1);
}

async function deliverDiscord(
	destination: DestinationRecord,
	payload: DeliveryPayload
): Promise<DeliveryResult> {
	const webhookUrl = destination.config?.webhookUrl;
	if (!webhookUrl || !/^https?:\/\//.test(webhookUrl)) {
		return { ok: false, error: 'Discord webhook URL is not configured', retryable: false };
	}
	const fields: { name: string; value: string; inline: boolean }[] = [];
	if (payload.service) fields.push({ name: 'Service', value: payload.service, inline: true });
	fields.push({ name: 'Event', value: payload.event, inline: true });
	fields.push({ name: 'Category', value: payload.category, inline: true });
	if (payload.deepLink) fields.push({ name: 'Open', value: payload.deepLink, inline: false });
	const body = {
		username: 'DUMBscope',
		embeds: [
			{
				title: payload.title,
				description: payload.summary ?? undefined,
				color: SEVERITY_COLORS[payload.severity],
				fields,
				timestamp: new Date(payload.at).toISOString(),
				footer: { text: `DUMBscope · ${severityLabel(payload.severity)}` }
			}
		]
	};
	const response = await fetch(webhookUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal: timeoutSignal()
	});
	if (!response.ok) {
		return {
			ok: false,
			error: `Discord webhook responded ${response.status}`,
			retryable: isRetryableStatus(response.status)
		};
	}
	return { ok: true, error: null, retryable: false };
}

async function deliverTelegram(
	destination: DestinationRecord,
	payload: DeliveryPayload
): Promise<DeliveryResult> {
	const botToken = destination.config?.botToken;
	const chatId = destination.config?.chatId;
	if (!botToken || !chatId) {
		return {
			ok: false,
			error: 'Telegram bot token or chat id is not configured',
			retryable: false
		};
	}
	const lines = [
		`${severityLabel(payload.severity)} · ${payload.title}`,
		payload.summary ?? '',
		`Event: ${payload.event}${payload.service ? ` · ${payload.service}` : ''}`,
		payload.deepLink ? payload.deepLink : ''
	].filter((line) => line.length > 0);
	// apiBase allows self-hosted Bot API instances (and the e2e mock).
	const base = destination.config?.apiBase?.replace(/\/+$/, '') ?? 'https://api.telegram.org';
	const response = await fetch(`${base}/bot${botToken}/sendMessage`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			chat_id: chatId,
			text: lines.join('\n'),
			disable_web_page_preview: true
		}),
		signal: timeoutSignal()
	});
	if (!response.ok) {
		return {
			ok: false,
			error: `Telegram responded ${response.status}`,
			retryable: isRetryableStatus(response.status)
		};
	}
	return { ok: true, error: null, retryable: false };
}
