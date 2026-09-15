/**
 * Notification persistence: destinations (secrets encrypted at rest), rules,
 * bounded history and dedupe state. Secrets are decrypted only server-side,
 * at delivery time — the API layer never sees plaintext.
 */
import { getDb } from '../database/db';
import { encryptSecret, decryptSecret, randomToken } from '../security/crypto';
import type {
	DestinationKind,
	DestinationPublic,
	NotificationRule,
	RulePreset,
	QuietBehavior,
	NotificationSeverity,
	NotificationCategory,
	NotificationEvent
} from '$lib/shared/notifications';

export type DestinationKindSafe = DestinationKind;

export interface DestinationRecord {
	id: string;
	kind: DestinationKind;
	label: string;
	enabled: boolean;
	/** Decrypted config. Never leaves the server. */
	config: Record<string, string> | null;
	createdAt: number;
	updatedAt: number;
}

export function newNotificationId(): string {
	return `ntf-${randomToken(8)}`;
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

function rowToDestination(row: Record<string, unknown>): DestinationRecord {
	let config: Record<string, string> | null = null;
	if (typeof row.config_enc === 'string' && row.config_enc) {
		const decrypted = decryptSecret(row.config_enc);
		if (decrypted) {
			try {
				config = JSON.parse(decrypted) as Record<string, string>;
			} catch {
				config = null;
			}
		}
	}
	return {
		id: row.id as string,
		kind: row.kind as DestinationKind,
		label: row.label as string,
		enabled: row.enabled === 1,
		config,
		createdAt: row.created_at as number,
		updatedAt: row.updated_at as number
	};
}

export function listDestinations(): DestinationRecord[] {
	return (
		getDb()
			.prepare('SELECT * FROM notification_destinations ORDER BY created_at')
			.all() as unknown as Record<string, unknown>[]
	).map(rowToDestination);
}

export function getDestination(id: string): DestinationRecord | null {
	const row = getDb().prepare('SELECT * FROM notification_destinations WHERE id = ?').get(id) as
		Record<string, unknown> | undefined;
	return row ? rowToDestination(row) : null;
}

export function createDestination(input: {
	kind: DestinationKind;
	label: string;
	enabled: boolean;
	config: Record<string, string> | null;
}): DestinationRecord {
	const db = getDb();
	const now = Date.now();
	const id = newNotificationId();
	db.prepare(
		'INSERT INTO notification_destinations (id, kind, label, enabled, config_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
	).run(
		id,
		input.kind,
		input.label,
		input.enabled ? 1 : 0,
		input.config ? encryptSecret(JSON.stringify(input.config)) : null,
		now,
		now
	);
	return getDestination(id)!;
}

export function updateDestination(
	id: string,
	patch: { label?: string; enabled?: boolean; config?: Record<string, string> | null }
): DestinationRecord | null {
	const existing = getDestination(id);
	if (!existing) return null;
	const db = getDb();
	const label = patch.label ?? existing.label;
	const enabled = patch.enabled ?? existing.enabled;
	const config = patch.config !== undefined ? patch.config : existing.config;
	db.prepare(
		'UPDATE notification_destinations SET label = ?, enabled = ?, config_enc = ?, updated_at = ? WHERE id = ?'
	).run(
		label,
		enabled ? 1 : 0,
		config ? encryptSecret(JSON.stringify(config)) : null,
		Date.now(),
		id
	);
	return getDestination(id);
}

export function deleteDestination(id: string): boolean {
	return getDb().prepare('DELETE FROM notification_destinations WHERE id = ?').run(id).changes > 0;
}

/** True when the destination has the secrets/config its kind requires. */
export function isConfigured(destination: DestinationRecord): boolean {
	switch (destination.kind) {
		case 'discord':
			return typeof destination.config?.webhookUrl === 'string';
		case 'telegram':
			return (
				typeof destination.config?.botToken === 'string' &&
				typeof destination.config?.chatId === 'string'
			);
		case 'browser':
			return true; // no secrets; gated by the browser permission client-side
	}
}

/** Masked representation for the UI — never contains a usable secret (§13). */
export function maskedConfig(destination: DestinationRecord): Record<string, string> | null {
	const config = destination.config;
	if (destination.kind === 'browser') return null;
	if (!config) return null;
	const mask = (value: string | undefined): string | undefined => {
		if (typeof value !== 'string') return undefined;
		if (value.length <= 8) return '••••••••';
		return `${value.slice(0, 6)}••••${value.slice(-4)}`;
	};
	if (destination.kind === 'discord') {
		return { webhookUrl: mask(config.webhookUrl) ?? '' };
	}
	const masked: Record<string, string> = {
		botToken: mask(config.botToken) ?? '',
		chatId: config.chatId ?? ''
	};
	if (config.apiBase) masked.apiBase = config.apiBase;
	return masked;
}

export function toPublicDestination(destination: DestinationRecord): DestinationPublic {
	return {
		id: destination.id,
		kind: destination.kind,
		label: destination.label,
		enabled: destination.enabled,
		configured: isConfigured(destination),
		configMasked: maskedConfig(destination),
		createdAt: destination.createdAt
	};
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function parseJsonArray<T extends string>(value: unknown, allowed: readonly T[]): T[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(v): v is T => typeof v === 'string' && (allowed as readonly string[]).includes(v)
	);
}

/** Service allowlists are free-form (DUMB discovery + integration ids). */
function parseStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === 'string' && v.length <= 128).slice(0, 50);
}

function rowToRule(row: Record<string, unknown>): NotificationRule {
	return {
		id: row.id as string,
		label: row.label as string,
		enabled: row.enabled === 1,
		preset: row.preset as RulePreset,
		severities: parseJsonArray<NotificationSeverity>(
			JSON.parse((row.severities as string) ?? '[]'),
			['info', 'attention', 'warning', 'critical']
		),
		categories: parseJsonArray<NotificationCategory>(
			JSON.parse((row.categories as string) ?? '[]'),
			['connectivity', 'mount', 'memory', 'media-state', 'service', 'storage', 'incident']
		),
		services: parseStringArray(JSON.parse((row.services as string) ?? '[]')),
		events: parseJsonArray<NotificationEvent>(JSON.parse((row.events as string) ?? '[]'), [
			'opened',
			'escalated',
			'resolved',
			'reopened'
		]),
		destinationIds: parseStringArray(JSON.parse((row.destination_ids as string) ?? '[]')),
		cooldownMinutes: (row.cooldown_minutes as number) ?? 60,
		quietEnabled: row.quiet_enabled === 1,
		quietStart: (row.quiet_start as string) ?? null,
		quietEnd: (row.quiet_end as string) ?? null,
		quietTimezone: (row.quiet_timezone as string) ?? null,
		quietBehavior: (row.quiet_behavior as QuietBehavior) ?? 'defer',
		ratePerMinute: (row.rate_per_minute as number) ?? null
	};
}

export function listRules(): NotificationRule[] {
	return (
		getDb()
			.prepare('SELECT * FROM notification_rules ORDER BY created_at')
			.all() as unknown as Record<string, unknown>[]
	).map(rowToRule);
}

export function getRule(id: string): NotificationRule | null {
	const row = getDb().prepare('SELECT * FROM notification_rules WHERE id = ?').get(id) as
		Record<string, unknown> | undefined;
	return row ? rowToRule(row) : null;
}

export function createRule(rule: Omit<NotificationRule, 'id'>): NotificationRule {
	const db = getDb();
	const id = newNotificationId();
	db.prepare(
		`INSERT INTO notification_rules (
			id, label, enabled, preset, severities, categories, services, events,
			destination_ids, cooldown_minutes, quiet_enabled, quiet_start, quiet_end,
			quiet_timezone, quiet_behavior, rate_per_minute, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		id,
		rule.label,
		rule.enabled ? 1 : 0,
		rule.preset,
		JSON.stringify(rule.severities),
		JSON.stringify(rule.categories),
		JSON.stringify(rule.services),
		JSON.stringify(rule.events),
		JSON.stringify(rule.destinationIds),
		rule.cooldownMinutes,
		rule.quietEnabled ? 1 : 0,
		rule.quietStart,
		rule.quietEnd,
		rule.quietTimezone,
		rule.quietBehavior,
		rule.ratePerMinute,
		Date.now(),
		Date.now()
	);
	return getRule(id)!;
}

export function updateRule(
	id: string,
	rule: Omit<NotificationRule, 'id'>
): NotificationRule | null {
	if (!getRule(id)) return null;
	getDb()
		.prepare(
			`UPDATE notification_rules SET
				label = ?, enabled = ?, preset = ?, severities = ?, categories = ?, services = ?,
				events = ?, destination_ids = ?, cooldown_minutes = ?, quiet_enabled = ?,
				quiet_start = ?, quiet_end = ?, quiet_timezone = ?, quiet_behavior = ?,
				rate_per_minute = ?, updated_at = ?
			WHERE id = ?`
		)
		.run(
			rule.label,
			rule.enabled ? 1 : 0,
			rule.preset,
			JSON.stringify(rule.severities),
			JSON.stringify(rule.categories),
			JSON.stringify(rule.services),
			JSON.stringify(rule.events),
			JSON.stringify(rule.destinationIds),
			rule.cooldownMinutes,
			rule.quietEnabled ? 1 : 0,
			rule.quietStart,
			rule.quietEnd,
			rule.quietTimezone,
			rule.quietBehavior,
			rule.ratePerMinute,
			Date.now(),
			id
		);
	return getRule(id);
}

export function deleteRule(id: string): boolean {
	return getDb().prepare('DELETE FROM notification_rules WHERE id = ?').run(id).changes > 0;
}

export function ruleCount(): number {
	return (getDb().prepare('SELECT COUNT(*) AS c FROM notification_rules').get() as { c: number }).c;
}

// ---------------------------------------------------------------------------
// History (bounded, 30 days)
// ---------------------------------------------------------------------------

export interface HistoryRow {
	id: number;
	at: number;
	event: string;
	destinationId: string | null;
	destinationKind: string | null;
	ruleId: string | null;
	ruleLabel: string | null;
	severity: string;
	category: string;
	service: string | null;
	title: string;
	summary: string | null;
	result: string;
	error: string | null;
	deepLink: string | null;
}

const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
let lastPruneAt = 0;

export function recordHistory(row: {
	at: number;
	event: string;
	destinationId: string | null;
	destinationKind: string | null;
	ruleId: string | null;
	ruleLabel: string | null;
	severity: string;
	category: string;
	service: string | null;
	title: string;
	summary: string | null;
	result: string;
	error: string | null;
	deepLink: string | null;
}): void {
	const db = getDb();
	db.prepare(
		`INSERT INTO notification_history (
			at, event, destination_id, destination_kind, rule_id, rule_label,
			severity, category, service, title, summary, result, error, deep_link
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		row.at,
		row.event,
		row.destinationId,
		row.destinationKind,
		row.ruleId,
		row.ruleLabel,
		row.severity,
		row.category,
		row.service,
		row.title,
		row.summary,
		row.result,
		row.error,
		row.deepLink
	);
	// Opportunistic 30-day prune, at most once per hour.
	const now = Date.now();
	if (now - lastPruneAt > 60 * 60 * 1000) {
		lastPruneAt = now;
		db.prepare('DELETE FROM notification_history WHERE at < ?').run(now - HISTORY_RETENTION_MS);
		db.prepare('DELETE FROM notification_browser_deliveries WHERE at < ?').run(
			now - 24 * 60 * 60 * 1000
		);
	}
}

export function listHistory(limit: number): HistoryRow[] {
	const rows = getDb()
		.prepare('SELECT * FROM notification_history ORDER BY at DESC, id DESC LIMIT ?')
		.all(Math.min(Math.max(limit, 1), 500)) as unknown as Record<string, unknown>[];
	return rows.map((row) => ({
		id: row.id as number,
		at: row.at as number,
		event: row.event as string,
		destinationId: (row.destination_id as string) ?? null,
		destinationKind: (row.destination_kind as string) ?? null,
		ruleId: (row.rule_id as string) ?? null,
		ruleLabel: (row.rule_label as string) ?? null,
		severity: row.severity as string,
		category: row.category as string,
		service: (row.service as string) ?? null,
		title: row.title as string,
		summary: (row.summary as string) ?? null,
		result: row.result as string,
		error: (row.error as string) ?? null,
		deepLink: (row.deep_link as string) ?? null
	}));
}

// ---------------------------------------------------------------------------
// Dedupe state (§5)
// ---------------------------------------------------------------------------

export interface DedupeState {
	lastSeverity: NotificationSeverity;
	lastEvent: NotificationEvent;
	lastNotifiedAt: number | null;
	resolvedAt: number | null;
	updatedAt: number;
}

export function getDedupe(key: string): DedupeState | null {
	const row = getDb().prepare('SELECT * FROM notification_dedupe WHERE dedupe_key = ?').get(key) as
		Record<string, unknown> | undefined;
	if (!row) return null;
	return {
		lastSeverity: row.last_severity as NotificationSeverity,
		lastEvent: row.last_event as NotificationEvent,
		lastNotifiedAt: (row.last_notified_at as number) ?? null,
		resolvedAt: (row.resolved_at as number) ?? null,
		updatedAt: row.updated_at as number
	};
}

export function setDedupe(key: string, state: DedupeState): void {
	getDb()
		.prepare(
			`INSERT INTO notification_dedupe (dedupe_key, last_severity, last_event, last_notified_at, resolved_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(dedupe_key) DO UPDATE SET
				last_severity = excluded.last_severity,
				last_event = excluded.last_event,
				last_notified_at = excluded.last_notified_at,
				resolved_at = excluded.resolved_at,
				updated_at = excluded.updated_at`
		)
		.run(
			key,
			state.lastSeverity,
			state.lastEvent,
			state.lastNotifiedAt,
			state.resolvedAt,
			state.updatedAt
		);
}

// ---------------------------------------------------------------------------
// Browser deliveries (in-app destination)
// ---------------------------------------------------------------------------

export interface BrowserDelivery {
	id: number;
	at: number;
	severity: string;
	title: string;
	summary: string | null;
	deepLink: string | null;
}

export function addBrowserDelivery(row: {
	at: number;
	severity: string;
	title: string;
	summary: string | null;
	deepLink: string | null;
}): number {
	const result = getDb()
		.prepare(
			'INSERT INTO notification_browser_deliveries (at, severity, title, summary, deep_link) VALUES (?, ?, ?, ?, ?)'
		)
		.run(row.at, row.severity, row.title, row.summary, row.deepLink);
	return Number(result.lastInsertRowid);
}

export function listBrowserDeliveries(sinceId: number, limit = 20): BrowserDelivery[] {
	const rows = getDb()
		.prepare('SELECT * FROM notification_browser_deliveries WHERE id > ? ORDER BY id ASC LIMIT ?')
		.all(sinceId, limit) as unknown as Record<string, unknown>[];
	return rows.map((row) => ({
		id: row.id as number,
		at: row.at as number,
		severity: row.severity as string,
		title: row.title as string,
		summary: (row.summary as string) ?? null,
		deepLink: (row.deep_link as string) ?? null
	}));
}

/** Last successful delivery per destination, for the status card (§11). */
export function lastDelivery(destinationId: string): { at: number; result: string } | null {
	const row = getDb()
		.prepare(
			`SELECT at, result FROM notification_history
			 WHERE destination_id = ? AND result IN ('sent', 'failed')
			 ORDER BY at DESC, id DESC LIMIT 1`
		)
		.get(destinationId) as { at: number; result: string } | undefined;
	return row ? { at: row.at, result: row.result } : null;
}

/** Last error per destination, for the status card (§11). */
export function lastError(destinationId: string): { at: number; error: string } | null {
	const row = getDb()
		.prepare(
			`SELECT at, error FROM notification_history
			 WHERE destination_id = ? AND result = 'failed' AND error IS NOT NULL
			 ORDER BY at DESC, id DESC LIMIT 1`
		)
		.get(destinationId) as { at: number; error: string } | undefined;
	return row ? { at: row.at, error: row.error } : null;
}
