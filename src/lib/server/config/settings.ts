/**
 * Application settings persisted in SQLite.
 *
 * Secret values (DUMB credentials) are stored encrypted via crypto.ts and are
 * never returned to the client — only presence flags.
 */
import { getDb } from '../database/db';
import { decryptSecret, encryptSecret } from '../security/crypto';

export interface DumbCredentials {
	username: string;
	password: string;
}

export interface AppSettings {
	dumbUrl: string | null;
	/** true when a credentials pair is stored for DUMB. */
	hasDumbCredentials: boolean;
	setupCompleted: boolean;
	theme: 'system' | 'dark' | 'oled' | 'light';
	accent: 'cyan' | 'blue' | 'indigo' | 'violet';
	/** Status stream interval in seconds (0.5–10), forwarded to DUMB. */
	statusInterval: number;
	metricsInterval: number;
	reducedMotion: boolean;
	/** Reliability monitoring switches (read-only observation; no remediation). */
	mountMonitoring: boolean;
	memoryMonitoring: boolean;
	/** Per-process RSS thresholds in GiB for memory anomaly detection. */
	memoryWarningGb: number;
	memoryCriticalGb: number;
	/** Optional public origin for deep links in outbound notifications. */
	notificationPublicBaseUrl: string | null;
	/** Which integration URL "Open service" links use (§2): auto resolves to
	 *  the public URL when the browser is not on the internal host. */
	linkOpenPreference: 'auto' | 'internal' | 'public';
}

function getSetting(key: string): string | null {
	const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
	return (row?.value as string) ?? null;
}

function setSetting(key: string, value: string): void {
	getDb()
		.prepare(
			`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.run(key, value, Date.now());
}

export function deleteSetting(key: string): void {
	getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export function getSettings(): AppSettings {
	return {
		// Optional DUMB_URL env override acts as a seed default; the setup wizard
		// (or Settings) persists the definitive value in the database.
		dumbUrl: getSetting('dumb.url') ?? process.env.DUMB_URL ?? null,
		hasDumbCredentials: getSetting('dumb.credentials') !== null,
		setupCompleted: getSetting('setup.completed') === 'true',
		theme: (getSetting('ui.theme') as AppSettings['theme']) ?? 'dark',
		accent: (getSetting('ui.accent') as AppSettings['accent']) ?? 'cyan',
		statusInterval: clampInterval(getSetting('dumb.statusInterval'), 2),
		metricsInterval: clampInterval(getSetting('dumb.metricsInterval'), 2),
		reducedMotion: getSetting('ui.reducedMotion') === 'true',
		mountMonitoring: getSetting('reliability.mountMonitoring') !== 'false',
		memoryMonitoring: getSetting('reliability.memoryMonitoring') !== 'false',
		memoryWarningGb: clampGb(getSetting('reliability.memoryWarningGb'), 3.5),
		memoryCriticalGb: clampGb(getSetting('reliability.memoryCriticalGb'), 4.5),
		notificationPublicBaseUrl: normalizeBaseUrl(getSetting('notifications.publicBaseUrl')),
		linkOpenPreference: normalizeLinkPreference(getSetting('actions.linkOpenPreference'))
	};
}

/** Client-safe projection: same data without any internal-only fields. */
export function getSettingsForClient() {
	const s = getSettings();
	return {
		dumbUrl: s.dumbUrl,
		hasDumbCredentials: s.hasDumbCredentials,
		theme: s.theme,
		accent: s.accent,
		statusInterval: s.statusInterval,
		metricsInterval: s.metricsInterval,
		reducedMotion: s.reducedMotion,
		mountMonitoring: s.mountMonitoring,
		memoryMonitoring: s.memoryMonitoring,
		memoryWarningGb: s.memoryWarningGb,
		memoryCriticalGb: s.memoryCriticalGb,
		linkOpenPreference: s.linkOpenPreference
	};
}

function clampInterval(raw: string | null, fallback: number): number {
	const n = raw ? Number(raw) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(10, Math.max(0.5, n));
}

/** Memory thresholds live in 0.5–64 GiB; the critical bar can never sit below
 *  the warning bar (enforced here so a bad patch cannot silence detection). */
function clampGb(raw: string | null, fallback: number): number {
	const n = raw ? Number(raw) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(64, Math.max(0.5, n));
}

export function setDumbUrl(url: string): void {
	setSetting('dumb.url', url);
}

export function setDumbCredentials(credentials: DumbCredentials): void {
	setSetting('dumb.credentials', encryptSecret(JSON.stringify(credentials)));
}

export function clearDumbCredentials(): void {
	deleteSetting('dumb.credentials');
}

export function getDumbCredentials(): DumbCredentials | null {
	const envelope = getSetting('dumb.credentials');
	if (!envelope) return null;
	const raw = decryptSecret(envelope);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as DumbCredentials;
		if (typeof parsed.username === 'string' && typeof parsed.password === 'string') {
			return parsed;
		}
		return null;
	} catch {
		return null;
	}
}

export function setSetupCompleted(): void {
	setSetting('setup.completed', 'true');
}

export function setUiPreference(key: 'theme' | 'accent' | 'reducedMotion', value: string): void {
	setSetting(`ui.${key}`, value);
}

export function setStreamInterval(key: 'statusInterval' | 'metricsInterval', value: number): void {
	setSetting(`dumb.${key}`, String(Math.min(10, Math.max(0.5, value))));
}

// -------------------------------------------------------------------------
// Reliability monitoring (read-only observation — no remediation knobs)
// -------------------------------------------------------------------------

export function setReliabilityEnabled(
	key: 'mountMonitoring' | 'memoryMonitoring',
	enabled: boolean
): void {
	setSetting(`reliability.${key}`, String(enabled));
}

export function setMemoryThresholds(warningGb: number, criticalGb: number): void {
	const warn = clampGb(String(warningGb), 3.5);
	const crit = Math.max(clampGb(String(criticalGb), 4.5), warn);
	setSetting('reliability.memoryWarningGb', String(warn));
	setSetting('reliability.memoryCriticalGb', String(crit));
}

function normalizeBaseUrl(raw: string | null): string | null {
	if (!raw) return null;
	return /^https?:\/\//.test(raw) ? raw.replace(/\/+$/, '') : null;
}

function normalizeLinkPreference(raw: string | null): AppSettings['linkOpenPreference'] {
	return raw === 'internal' || raw === 'public' ? raw : 'auto';
}

/** "Open links using" preference for service web-UI links (docs/ACTIONS.md §2). */
export function setLinkOpenPreference(value: 'auto' | 'internal' | 'public'): void {
	setSetting('actions.linkOpenPreference', value);
}

/** Monitored mount targets: a JSON list of MountTarget. */
export function getMountTargetsJson(): string | null {
	return getSetting('reliability.mounts');
}

export function setMountTargetsJson(json: string): void {
	setSetting('reliability.mounts', json);
}

// ---------------------------------------------------------------------------
// Library reconciliation (FASE D) settings
// ---------------------------------------------------------------------------

/** JSON list of `{from, to}` path alias pairs (Arr root ↔ Plex library root). */
export function getReconciliationAliasesJson(): string | null {
	return getSetting('reconciliation.aliases');
}

export function getReconciliationPlexDbPath(): string | null {
	return getSetting('reconciliation.plexDbPath');
}

export function getReconciliationPlexCredentials(): { url: string; token: string } | null {
	const url = getSetting('reconciliation.plexUrl');
	const token = getSetting('reconciliation.plexToken');
	if (!url || !token) return null;
	return { url, token };
}

export function reconciliationAutoRefreshEnabled(): boolean {
	return getSetting('reconciliation.plexAutoRefresh') === 'true';
}

export function reconciliationEnabled(): boolean {
	return getSetting('reconciliation.enabled') !== 'false';
}

export function setReconciliationSettings(values: {
	aliasesJson?: string;
	plexDbPath?: string | null;
	plexUrl?: string | null;
	plexToken?: string | null;
	plexAutoRefresh?: boolean;
	enabled?: boolean;
}): void {
	if (values.aliasesJson !== undefined) setSetting('reconciliation.aliases', values.aliasesJson);
	if (values.plexDbPath !== undefined) {
		if (values.plexDbPath) setSetting('reconciliation.plexDbPath', values.plexDbPath);
		else deleteSetting('reconciliation.plexDbPath');
	}
	if (values.plexUrl !== undefined) {
		if (values.plexUrl) setSetting('reconciliation.plexUrl', values.plexUrl);
		else deleteSetting('reconciliation.plexUrl');
	}
	if (values.plexToken !== undefined) {
		if (values.plexToken) setSetting('reconciliation.plexToken', values.plexToken);
		else deleteSetting('reconciliation.plexToken');
	}
	if (values.plexAutoRefresh !== undefined) {
		setSetting('reconciliation.plexAutoRefresh', values.plexAutoRefresh ? 'true' : 'false');
	}
	if (values.enabled !== undefined) {
		setSetting('reconciliation.enabled', values.enabled ? 'true' : 'false');
	}
}

export function setNotificationPublicBaseUrl(url: string | null): void {
	if (url === null || url === '') {
		deleteSetting('notifications.publicBaseUrl');
		return;
	}
	const normalized = normalizeBaseUrl(url);
	if (normalized) setSetting('notifications.publicBaseUrl', normalized);
}
