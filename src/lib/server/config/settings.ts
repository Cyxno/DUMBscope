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
	theme: 'dark' | 'oled' | 'light';
	accent: 'cyan' | 'blue' | 'indigo' | 'violet';
	/** Status stream interval in seconds (0.5–10), forwarded to DUMB. */
	statusInterval: number;
	metricsInterval: number;
	reducedMotion: boolean;
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
		reducedMotion: getSetting('ui.reducedMotion') === 'true'
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
		reducedMotion: s.reducedMotion
	};
}

function clampInterval(raw: string | null, fallback: number): number {
	const n = raw ? Number(raw) : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(10, Math.max(0.5, n));
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
