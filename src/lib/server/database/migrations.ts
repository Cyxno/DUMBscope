/**
 * Versioned, transactional database migrations.
 *
 * Each migration runs once, inside a transaction, and is recorded in
 * `schema_version`. Never edit an applied migration — add a new one.
 */
import type { DatabaseSync } from 'node:sqlite';

interface Migration {
	version: number;
	name: string;
	sql: string;
}

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: 'initial schema',
		sql: `
			CREATE TABLE settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);

			CREATE TABLE users (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				username TEXT NOT NULL UNIQUE,
				password_hash TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				last_login_at INTEGER
			);

			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				created_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				last_seen_at INTEGER NOT NULL,
				user_agent TEXT
			);
			CREATE INDEX idx_sessions_expires ON sessions(expires_at);

			CREATE TABLE incidents (
				id TEXT PRIMARY KEY,
				fingerprint TEXT NOT NULL,
				severity TEXT NOT NULL,
				status TEXT NOT NULL,
				title TEXT NOT NULL,
				summary TEXT,
				root_cause_service TEXT,
				root_cause_fingerprint TEXT,
				affected_services TEXT NOT NULL DEFAULT '[]',
				first_seen INTEGER NOT NULL,
				last_seen INTEGER NOT NULL,
				resolved_at INTEGER,
				occurrences INTEGER NOT NULL DEFAULT 1
			);
			CREATE INDEX idx_incidents_status ON incidents(status, last_seen);
			CREATE INDEX idx_incidents_fingerprint ON incidents(fingerprint);

			CREATE TABLE incident_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
				at INTEGER NOT NULL,
				kind TEXT NOT NULL,
				message TEXT NOT NULL,
				severity TEXT
			);
			CREATE INDEX idx_incident_events_incident ON incident_events(incident_id, at);

			CREATE TABLE health_transitions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				service_key TEXT NOT NULL,
				from_health TEXT,
				to_health TEXT NOT NULL,
				reason TEXT,
				at INTEGER NOT NULL
			);
			CREATE INDEX idx_health_transitions_time ON health_transitions(at);

			CREATE TABLE service_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				service_key TEXT NOT NULL,
				kind TEXT NOT NULL,
				message TEXT NOT NULL,
				at INTEGER NOT NULL
			);
			CREATE INDEX idx_service_events_time ON service_events(at);
		`
	},
	{
		version: 2,
		name: 'unique active fingerprint per incident',
		sql: `
			-- One open incident per fingerprint: the engine dedupes, this guards races.
			CREATE UNIQUE INDEX IF NOT EXISTS idx_incidents_active_fingerprint
				ON incidents(fingerprint) WHERE status = 'active';
		`
	},
	{
		version: 3,
		name: 'integrations and activity',
		sql: `
			-- Deep integration connections. API keys live encrypted in api_key_enc
			-- (AES-256-GCM envelope, crypto.ts) and are never selected into API
			-- responses — only presence flags.
			CREATE TABLE IF NOT EXISTS integrations (
				id TEXT PRIMARY KEY,
				type TEXT NOT NULL,
				url TEXT NOT NULL,
				api_key_enc TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				last_test_at INTEGER,
				last_test_ok INTEGER,
				last_test_error TEXT
			);
			CREATE INDEX idx_integrations_type ON integrations(type);

			-- Semantic activity feed (brief §15). observed=1 rows come straight
			-- from a source system; inferred rows are correlated and always
			-- labeled. Retention: housekeeper prunes older than activity.max_age.
			CREATE TABLE IF NOT EXISTS activity (
				id TEXT PRIMARY KEY,
				at INTEGER NOT NULL,
				source TEXT NOT NULL,
				service_key TEXT,
				category TEXT NOT NULL,
				title TEXT NOT NULL,
				detail TEXT,
				severity TEXT,
				observed INTEGER NOT NULL DEFAULT 1,
				correlation_id TEXT
			);
			CREATE INDEX idx_activity_at ON activity(at);
			CREATE INDEX idx_activity_service_at ON activity(service_key, at);
			CREATE INDEX idx_activity_category ON activity(category, at);
		`
	},
	{
		version: 4,
		name: 'media library snapshots',
		sql: `
			-- Compact hourly aggregates for library trends (brief §16–§18).
			-- One row per kind (tv/movies/subtitles) per capture: 3 rows/hour,
			-- ~63k rows / a few MB per year before retention. Aggregates only —
			-- never a library dump.
			CREATE TABLE IF NOT EXISTS media_snapshots (
				at INTEGER NOT NULL,
				kind TEXT NOT NULL,
				missing INTEGER NOT NULL,
				upgrades INTEGER NOT NULL,
				total INTEGER,
				available INTEGER,
				gaps INTEGER
			);
			CREATE INDEX idx_media_snapshots_kind_at ON media_snapshots(kind, at);
		`
	},
	{
		version: 5,
		name: 'memory samples for anomaly detection',
		sql: `
			-- FASE C: compact per-process RSS samples, at most one row per
			-- process per minute. Bounded by retention pruning (default 26h):
			-- worst case ~1.5k rows/process · few MB total, never a raw probe
			-- firehose. Powers rolling-median baselines and 1h/6h/24h deltas.
			CREATE TABLE IF NOT EXISTS memory_samples (
				process TEXT NOT NULL,
				at INTEGER NOT NULL,
				rss_bytes INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_memory_samples_process_at ON memory_samples(process, at);
			CREATE INDEX IF NOT EXISTS idx_memory_samples_at ON memory_samples(at);
		`
	},
	{
		version: 6,
		name: 'acquisition ledger and remediation audit',
		sql: `
			-- DEEL 2: bounded recent acquisition ledger. One row per upstream
			-- request (integration + download GUID), deduped by poll retries.
			-- Retention-pruned at 14 days: ~50-200 grabs/day on this stack →
			-- well under 3k rows steady state, a few hundred KB.
			CREATE TABLE IF NOT EXISTS media_acquisitions (
				integration_id TEXT NOT NULL,
				request_id TEXT NOT NULL,
				media_key TEXT NOT NULL,
				title TEXT NOT NULL,
				client TEXT,
				first_seen INTEGER NOT NULL,
				last_observed_at INTEGER NOT NULL,
				accepted_at INTEGER,
				failed_at INTEGER,
				completed_at INTEGER,
				last_event TEXT,
				PRIMARY KEY (integration_id, request_id)
			);
			CREATE INDEX IF NOT EXISTS idx_media_acq_media ON media_acquisitions(media_key, first_seen);
			CREATE INDEX IF NOT EXISTS idx_media_acq_seen ON media_acquisitions(last_observed_at);

			-- Remediation audit trail: one row per action request. Actor,
			-- evidence, verification and result are recorded — the audit is the
			-- product, execution is the exception.
			CREATE TABLE IF NOT EXISTS remediation_actions (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				target TEXT NOT NULL,
				actor TEXT NOT NULL,
				trigger_source TEXT NOT NULL,
				reason TEXT,
				evidence TEXT NOT NULL DEFAULT '[]',
				state TEXT NOT NULL,
				finding_fingerprint TEXT,
				requested_at INTEGER NOT NULL,
				executed_at INTEGER,
				verified_at INTEGER,
				verification TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_remediation_target_at ON remediation_actions(target, requested_at);
		`
	},
	{
		version: 7,
		name: 'alerts & notifications: destinations, rules, history, dedupe',
		sql: `
			-- Outbound alert destinations. Secrets (Discord webhook URL, Telegram
			-- bot token) live encrypted in config_enc — never returned to the
			-- browser (masked representation only).
			CREATE TABLE IF NOT EXISTS notification_destinations (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				label TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 1,
				config_enc TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);

			-- Notification rules: filters (severity/category/service/event),
			-- target destinations, dedupe cooldown and quiet hours. Section
			-- membership of a rule's filters is copied from its preset; 'custom'
			-- is user-edited.
			CREATE TABLE IF NOT EXISTS notification_rules (
				id TEXT PRIMARY KEY,
				label TEXT NOT NULL,
				enabled INTEGER NOT NULL DEFAULT 1,
				preset TEXT NOT NULL DEFAULT 'custom',
				severities TEXT NOT NULL,
				categories TEXT NOT NULL,
				services TEXT NOT NULL,
				events TEXT NOT NULL,
				destination_ids TEXT NOT NULL,
				cooldown_minutes INTEGER NOT NULL DEFAULT 60,
				quiet_enabled INTEGER NOT NULL DEFAULT 0,
				quiet_start TEXT,
				quiet_end TEXT,
				quiet_timezone TEXT,
				quiet_behavior TEXT NOT NULL DEFAULT 'defer',
				rate_per_minute INTEGER,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);

			-- Bounded delivery history (30 days, pruned opportunistically):
			-- one row per event x destination decision, including suppressed
			-- and rate-limited decisions so the history explains itself.
			CREATE TABLE IF NOT EXISTS notification_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				at INTEGER NOT NULL,
				event TEXT NOT NULL,
				destination_id TEXT,
				destination_kind TEXT,
				rule_id TEXT,
				rule_label TEXT,
				severity TEXT NOT NULL,
				category TEXT NOT NULL,
				service TEXT,
				title TEXT NOT NULL,
				summary TEXT,
				result TEXT NOT NULL,
				error TEXT,
				deep_link TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_notif_history_at ON notification_history(at);
			CREATE INDEX IF NOT EXISTS idx_notif_history_dest ON notification_history(destination_id, at);

			-- Per rule x finding dedupe state: last notified severity, open/
			-- resolved state and timestamps drive first-open / suppress /
			-- escalate / resolved / reopen-after-cooldown semantics.
			CREATE TABLE IF NOT EXISTS notification_dedupe (
				dedupe_key TEXT PRIMARY KEY,
				last_severity TEXT NOT NULL,
				last_event TEXT NOT NULL,
				last_notified_at INTEGER,
				resolved_at INTEGER,
				updated_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_notif_dedupe_updated ON notification_dedupe(updated_at);

			-- Deliveries for the in-app browser destination, picked up by the
			-- open client through polling. Bounded by retention pruning.
			CREATE TABLE IF NOT EXISTS notification_browser_deliveries (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				at INTEGER NOT NULL,
				severity TEXT NOT NULL,
				title TEXT NOT NULL,
				summary TEXT,
				deep_link TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_notif_browser_at ON notification_browser_deliveries(at);
		`
	}
];
export function currentVersion(db: DatabaseSync): number {
	const table = db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
		.get();
	if (!table) return 0;
	const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
	return (row?.v as number) ?? 0;
}

export function runMigrations(db: DatabaseSync, targetVersion = Number.MAX_SAFE_INTEGER): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_version (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		);
	`);
	const from = currentVersion(db);
	for (const migration of MIGRATIONS) {
		if (migration.version <= from) continue;
		if (migration.version > targetVersion) continue;
		db.exec('BEGIN');
		try {
			db.exec(migration.sql);
			db.prepare('INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)').run(
				migration.version,
				migration.name,
				Date.now()
			);
			db.exec('COMMIT');
			console.log(`[dumbscope] database migration ${migration.version} applied: ${migration.name}`);
		} catch (err) {
			db.exec('ROLLBACK');
			throw err;
		}
	}
}
