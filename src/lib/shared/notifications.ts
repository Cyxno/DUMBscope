/**
 * Alerts & Notifications: shared vocabulary for the notification layer.
 *
 * The layer consumes existing incident/finding lifecycle events (the incident
 * engine *is* the findings model — no second monitoring pipeline) and decides
 * per rule whether/where/when to notify: filters → dedupe/cooldown → quiet
 * hours → per-destination rate limit → bounded delivery queue.
 */

export type NotificationSeverity = 'info' | 'attention' | 'warning' | 'critical';
export type NotificationCategory =
	'connectivity' | 'mount' | 'memory' | 'media-state' | 'service' | 'storage' | 'incident';
export type NotificationEvent = 'opened' | 'escalated' | 'resolved' | 'reopened';
export type DestinationKind = 'browser' | 'discord' | 'telegram';
export type RulePreset =
	'critical_only' | 'warnings_critical' | 'operations' | 'everything' | 'custom';
export type QuietBehavior = 'defer' | 'suppress';

export const SEVERITIES: readonly NotificationSeverity[] = [
	'info',
	'attention',
	'warning',
	'critical'
];
export const CATEGORIES: readonly NotificationCategory[] = [
	'connectivity',
	'mount',
	'memory',
	'media-state',
	'service',
	'storage',
	'incident'
];
export const EVENTS: readonly NotificationEvent[] = ['opened', 'escalated', 'resolved', 'reopened'];
export const ALL_SERVICES_ALLOWLIST = [] as const;

/** Severity ranking used for escalation detection (higher = more severe). */
const SEVERITY_RANK: Record<NotificationSeverity, number> = {
	info: 0,
	attention: 1,
	warning: 2,
	critical: 3
};

export function severityAtLeast(a: NotificationSeverity, b: NotificationSeverity): boolean {
	return SEVERITY_RANK[a] >= SEVERITY_RANK[b];
}

export function isMoreSevere(a: NotificationSeverity, b: NotificationSeverity): boolean {
	return SEVERITY_RANK[a] > SEVERITY_RANK[b];
}

export interface NotificationRule {
	id: string;
	label: string;
	enabled: boolean;
	preset: RulePreset;
	severities: NotificationSeverity[];
	categories: NotificationCategory[];
	/** Service allowlist; empty = every service. */
	services: string[];
	events: NotificationEvent[];
	destinationIds: string[];
	cooldownMinutes: number;
	quietEnabled: boolean;
	quietStart: string | null;
	quietEnd: string | null;
	quietTimezone: string | null;
	quietBehavior: QuietBehavior;
	/** Per-destination cap applied through the shared rule; null = default 10. */
	ratePerMinute: number | null;
}

export interface DestinationPublic {
	id: string;
	kind: DestinationKind;
	label: string;
	enabled: boolean;
	configured: boolean;
	/** Masked secret representation for the UI (never the real secret). */
	configMasked: Record<string, string> | null;
	createdAt: number;
}

/** Filter sets behind the built-in presets (§4). */
export const PRESETS: Record<
	Exclude<RulePreset, 'custom'>,
	{
		label: string;
		description: string;
		severities: NotificationSeverity[];
		categories: NotificationCategory[];
		events: NotificationEvent[];
		cooldownMinutes: number;
	}
> = {
	critical_only: {
		label: 'Critical only',
		description: 'Only critical findings, including escalation and recovery.',
		severities: ['critical'],
		categories: [],
		events: ['opened', 'escalated', 'resolved', 'reopened'],
		cooldownMinutes: 60
	},
	warnings_critical: {
		label: 'Warnings + Critical',
		description: 'Warnings and criticals when they open or escalate.',
		severities: ['warning', 'critical'],
		categories: [],
		events: ['opened', 'escalated', 'reopened'],
		cooldownMinutes: 60
	},
	operations: {
		label: 'Operations',
		description: 'Warnings and criticals with recovery notifications.',
		severities: ['warning', 'critical'],
		categories: [],
		events: ['opened', 'escalated', 'resolved', 'reopened'],
		cooldownMinutes: 30
	},
	everything: {
		label: 'Everything',
		description: 'Every severity, every event. Noisy by design.',
		severities: ['info', 'attention', 'warning', 'critical'],
		categories: [],
		events: ['opened', 'escalated', 'resolved', 'reopened'],
		cooldownMinutes: 15
	}
};

/** Map an incident fingerprint prefix to a notification category (§3). */
export function categoryForFingerprint(fingerprint: string): NotificationCategory {
	if (fingerprint.startsWith('svc-')) return 'service';
	if (
		fingerprint.startsWith('dumb-') ||
		fingerprint.startsWith('telemetry-') ||
		fingerprint.startsWith('integration-')
	)
		return 'connectivity';
	if (fingerprint.startsWith('mount:') || fingerprint.startsWith('symlinks:')) return 'mount';
	if (fingerprint.startsWith('memory:')) return 'memory';
	if (fingerprint.startsWith('disk-') || fingerprint.startsWith('db-health:')) return 'storage';
	if (fingerprint.startsWith('media-')) return 'media-state';
	return 'incident';
}

/** Where a notification should land in the app (§17). */
export function deepLinkForCategory(category: NotificationCategory): string {
	switch (category) {
		case 'mount':
		case 'memory':
		case 'storage':
			return '/system';
		case 'media-state':
			return '/library';
		default:
			return '/incidents';
	}
}

/** Validate an HH:MM quiet-hours boundary. */
export function isValidHhMm(value: string | null | undefined): value is string {
	return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/**
 * True when `nowMs` falls inside the [start, end) window interpreted in
 * `timezone` (IANA name; empty = server-local). Handles windows that cross
 * midnight (22:30–07:00).
 */
export function isQuietNow(
	start: string,
	end: string,
	timezone: string | null,
	nowMs: number
): boolean {
	if (!isValidHhMm(start) || !isValidHhMm(end)) return false;
	let local: string;
	try {
		const parts = new Intl.DateTimeFormat('en-GB', {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			...(timezone ? { timeZone: timezone } : {})
		}).formatToParts(new Date(nowMs));
		const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
		const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
		local = `${hour === '24' ? '00' : hour}:${minute}`;
	} catch {
		return false; // invalid timezone never silently enables quiet hours
	}
	if (start === end) return true; // full-day window
	if (start < end) return local >= start && local < end;
	return local >= start || local < end; // crosses midnight
}

/** Milliseconds until the quiet window ends (for deferred deliveries). */
export function msUntilQuietEnd(
	start: string,
	end: string,
	timezone: string | null,
	nowMs: number
): number {
	// Re-probe every minute; the queue re-checks quiet state on each attempt so
	// an approximate delay is enough.
	return isQuietNow(start, end, timezone, nowMs) ? 60_000 : 0;
}
