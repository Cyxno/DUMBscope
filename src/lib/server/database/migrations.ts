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

export function runMigrations(db: DatabaseSync): void {
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
