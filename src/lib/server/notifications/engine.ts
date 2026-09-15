/**
 * Notification engine: turns incident/finding lifecycle events into
 * per-rule delivery decisions.
 *
 * Flow (§1): Finding/Incident → rule matching → dedupe/cooldown → quiet hours
 * → per-destination rate limit → delivery queue → destination.
 *
 * The engine consumes ONLY existing incident lifecycle callbacks — the
 * incident engine is the findings model; no second monitoring pipeline lives
 * here. The effective event (opened / escalated / resolved / reopened) is
 * derived per rule from the shared dedupe state, so the same lifecycle change
 * can notify one rule as an escalation and be suppressed by another. Every
 * decision lands in the bounded history so the UI can explain deliveries and
 * suppressions alike.
 */
import type { Incident } from '$lib/types';
import { rateLimit } from '../security/rate-limit';
import {
	categoryForFingerprint,
	deepLinkForCategory,
	isMoreSevere,
	isQuietNow,
	type NotificationCategory,
	type NotificationEvent,
	type NotificationSeverity
} from '$lib/shared/notifications';
import { getDestination, getDedupe, listRules, recordHistory, setDedupe } from './store';
import { enqueueDelivery, deliverNow } from './queue';

/** Public base URL used for deep links in outbound messages (optional). */
let publicBaseUrl: string | null = null;
export function setPublicBaseUrl(url: string | null): void {
	publicBaseUrl = url && /^https?:\/\//.test(url) ? url.replace(/\/+$/, '') : null;
}

function absoluteLink(link: string): string {
	return publicBaseUrl ? `${publicBaseUrl}${link}` : link;
}

export interface NotificationEventInput {
	action: 'opened' | 'updated' | 'resolved';
	severity: NotificationSeverity;
	category: NotificationCategory;
	service: string | null;
	title: string;
	summary: string | null;
	fingerprint: string;
	deepLink: string;
	at: number;
}

const DEFAULT_RATE_PER_MINUTE = 10;

/** Base input for one incident lifecycle change. */
export function eventFromIncidentChange(
	incident: Incident,
	action: 'opened' | 'updated' | 'resolved'
): NotificationEventInput {
	const category = categoryForFingerprint(incident.fingerprint);
	return {
		action,
		severity: incident.severity,
		category,
		service: incident.affectedServices[0] ?? null,
		title: incident.title,
		summary: incident.summary,
		fingerprint: incident.fingerprint,
		deepLink: deepLinkForCategory(category),
		at: Date.now()
	};
}

/** Evaluate one event against one rule's static filters (§3/§4). */
export function ruleMatches(
	rule: {
		enabled: boolean;
		severities: NotificationSeverity[];
		categories: NotificationCategory[];
		services: string[];
		destinationIds: string[];
	},
	event: NotificationEventInput
): boolean {
	if (!rule.enabled) return false;
	if (rule.destinationIds.length === 0) return false;
	if (rule.severities.length > 0 && !rule.severities.includes(event.severity)) return false;
	if (rule.categories.length > 0 && !rule.categories.includes(event.category)) return false;
	if (rule.services.length > 0) {
		const service = event.service;
		if (!service) return false; // service-bound rule, unserviceable finding
		if (!rule.services.includes(service) && !rule.services.includes('*')) return false;
	}
	return true;
}

export interface DedupePrevious {
	lastSeverity: NotificationSeverity;
	resolvedAt: number | null;
}

/**
 * Derive the effective event and the notify decision from dedupe state (§5):
 * first open → notify; repeat at same/lower severity → suppress; severity
 * increase → escalate; resolution → optional notify; reopen inside cooldown →
 * suppress, after cooldown → notify.
 */
export function dedupeDecision(
	events: NotificationEvent[],
	cooldownMinutes: number,
	event: NotificationEventInput,
	previous: DedupePrevious | null
): { event: NotificationEvent; notify: boolean; reason: string } {
	if (!previous) {
		const effective = event.action === 'resolved' ? 'resolved' : 'opened';
		return {
			event: effective,
			notify: events.includes(effective),
			reason: effective === 'opened' ? 'first occurrence' : 'resolution notification'
		};
	}

	if (event.action === 'resolved') {
		return {
			event: 'resolved',
			notify: events.includes('resolved'),
			reason: 'resolution notification'
		};
	}

	if (previous.resolvedAt !== null) {
		const sinceResolved = event.at - (previous.resolvedAt ?? 0);
		if (sinceResolved < cooldownMinutes * 60_000) {
			return { event: 'reopened', notify: false, reason: 'reopened inside cooldown' };
		}
		return {
			event: 'reopened',
			notify: events.includes('reopened'),
			reason: 'reopened after cooldown'
		};
	}

	if (isMoreSevere(event.severity, previous.lastSeverity)) {
		return {
			event: 'escalated',
			notify: events.includes('escalated'),
			reason: 'severity increased'
		};
	}
	return {
		event: 'opened',
		notify: false,
		reason: 'already notified at this or higher severity'
	};
}

/** Quiet-hours decision (§6). Critical always delivers. */
export function quietDecision(
	rule: {
		quietEnabled: boolean;
		quietStart: string | null;
		quietEnd: string | null;
		quietTimezone: string | null;
		quietBehavior: 'defer' | 'suppress';
		destinationKind: 'browser' | 'discord' | 'telegram';
	},
	severity: NotificationSeverity,
	nowMs: number
): { deliver: boolean; deferUntil: number | null; suppress: boolean } {
	if (!rule.quietEnabled || !rule.quietStart || !rule.quietEnd) {
		return { deliver: true, deferUntil: null, suppress: false };
	}
	if (!isQuietNow(rule.quietStart, rule.quietEnd, rule.quietTimezone, nowMs)) {
		return { deliver: true, deferUntil: null, suppress: false };
	}
	if (severity === 'critical') {
		return { deliver: true, deferUntil: null, suppress: false }; // critical bypasses quiet hours
	}
	if (rule.destinationKind === 'browser') {
		// The browser destination is real-time only while the app is open;
		// deferring would pop notifications hours later — suppress instead.
		return { deliver: false, deferUntil: null, suppress: true };
	}
	if (rule.quietBehavior === 'suppress') {
		return { deliver: false, deferUntil: null, suppress: true };
	}
	// Deferred deliveries re-enter the queue one minute at a time; the queue
	// re-checks quiet state before each attempt, so delivery happens at the
	// first tick after the window ends.
	return { deliver: false, deferUntil: nowMs + 60_000, suppress: false };
}

function record(
	event: NotificationEventInput,
	notificationEvent: NotificationEvent | 'test',
	result: string,
	rule: { id: string; label: string } | null,
	destination: { id: string; kind: string } | null,
	error: string | null
): void {
	recordHistory({
		at: event.at,
		event: notificationEvent,
		destinationId: destination?.id ?? null,
		destinationKind: destination?.kind ?? null,
		ruleId: rule?.id ?? null,
		ruleLabel: rule?.label ?? null,
		severity: event.severity,
		category: event.category,
		service: event.service,
		title: event.title,
		summary: event.summary,
		result,
		error,
		deepLink: event.deepLink
	});
}

/**
 * Process one incident/finding lifecycle change through every enabled rule.
 * Returns the number of deliveries enqueued.
 */
export function processEvent(event: NotificationEventInput): number {
	const rules = listRules().filter((rule) => rule.enabled && rule.destinationIds.length > 0);
	let enqueued = 0;
	for (const rule of rules) {
		if (!ruleMatches(rule, event)) continue;

		const key = `${rule.id}:${event.fingerprint}`;
		const previous = getDedupe(key);
		const decision = dedupeDecision(
			rule.events,
			rule.cooldownMinutes,
			event,
			previous ? { lastSeverity: previous.lastSeverity, resolvedAt: previous.resolvedAt } : null
		);

		// Track state regardless of delivery so a later escalation compares
		// against the newest severity even when this round was suppressed.
		setDedupe(key, {
			lastSeverity: event.severity,
			lastEvent: decision.event,
			lastNotifiedAt: decision.notify ? event.at : (previous?.lastNotifiedAt ?? null),
			resolvedAt: event.action === 'resolved' ? event.at : null,
			updatedAt: event.at
		});

		if (!decision.notify) {
			record(event, decision.event, 'suppressed', rule, null, decision.reason);
			continue;
		}

		const rateCap = rule.ratePerMinute ?? DEFAULT_RATE_PER_MINUTE;
		for (const destinationId of rule.destinationIds) {
			const destination = getDestination(destinationId);
			if (!destination || !destination.enabled) continue;
			// Browser destinations carry no secrets; outbound kinds need config.
			if (destination.kind !== 'browser' && !destination.config) continue;

			const quiet = quietDecision(
				{
					quietEnabled: rule.quietEnabled,
					quietStart: rule.quietStart,
					quietEnd: rule.quietEnd,
					quietTimezone: rule.quietTimezone,
					quietBehavior: rule.quietBehavior,
					destinationKind: destination.kind
				},
				event.severity,
				event.at
			);
			if (quiet.suppress) {
				record(event, decision.event, 'suppressed', rule, destination, 'quiet hours');
				continue;
			}
			if (quiet.deferUntil !== null) {
				record(event, decision.event, 'deferred', rule, destination, 'quiet hours');
				enqueueDelivery({
					destination,
					payload: {
						event: decision.event,
						severity: event.severity,
						category: event.category,
						service: event.service,
						title: event.title,
						summary: event.summary,
						deepLink: absoluteLink(event.deepLink),
						at: event.at,
						deferUntil: quiet.deferUntil
					},
					rule
				});
				enqueued += 1;
				continue;
			}

			const limit = rateLimit(`notify:${destination.id}`, rateCap, 60_000);
			if (!limit.allowed) {
				record(
					event,
					decision.event,
					'rate_limited',
					rule,
					destination,
					`destination cap ${rateCap}/min`
				);
				continue;
			}

			enqueueDelivery({
				destination,
				payload: {
					event: decision.event,
					severity: event.severity,
					category: event.category,
					service: event.service,
					title: event.title,
					summary: event.summary,
					deepLink: absoluteLink(event.deepLink),
					at: event.at,
					deferUntil: null
				},
				rule
			});
			enqueued += 1;
		}
	}
	return enqueued;
}

/**
 * Wire the incident engine lifecycle into the notification engine. Called
 * from the telemetry hub for every created/updated/resolved incident.
 * Notification failures must never affect monitoring (§15).
 */
export function handleIncidentChange(
	incident: Incident,
	action: 'opened' | 'updated' | 'resolved'
): void {
	try {
		processEvent(eventFromIncidentChange(incident, action));
	} catch (err) {
		console.error(
			'[notifications] failed to process incident event:',
			err instanceof Error ? err.message : err
		);
	}
}

/** Fire a test notification straight at one destination (§11). */
export async function sendTestDelivery(
	destinationId: string
): Promise<{ ok: boolean; error: string | null }> {
	const destination = getDestination(destinationId);
	if (!destination) return { ok: false, error: 'destination not found' };
	if (!destination.enabled || !destination.config) {
		return { ok: false, error: 'destination is not configured' };
	}
	const result = await deliverNow(destination, {
		event: 'opened',
		severity: 'info',
		category: 'incident',
		service: null,
		title: 'Test notification from DUMBscope',
		summary: `If you can read this, ${destination.label} is wired up correctly.`,
		deepLink: absoluteLink('/'),
		at: Date.now(),
		deferUntil: null
	});
	recordHistory({
		at: Date.now(),
		event: 'test',
		destinationId: destination.id,
		destinationKind: destination.kind,
		ruleId: null,
		ruleLabel: null,
		severity: 'info',
		category: 'incident',
		service: null,
		title: 'Test notification',
		summary: null,
		result: result.ok ? 'sent' : 'failed',
		error: result.error,
		deepLink: absoluteLink('/')
	});
	return result;
}
