/**
 * Migration test (brief §27): a realistic v0.1.1 database (schema_version 2,
 * no v0.2 tables) must migrate cleanly to v0.2 with all user data intact —
 * no setup wizard required after upgrade.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, currentVersion } from '../src/lib/server/database/migrations';

function createV011Fixture(): string {
	// Mirror the exact v0.1.1 schema: migrations 1+2 only.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-migrate-'));
	const file = path.join(dir, 'dumbscope.db');
	const db = new DatabaseSync(file);
	db.exec(`
		CREATE TABLE schema_version (
			version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
		);
		CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
		CREATE TABLE users (
			id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
			last_login_at INTEGER, last_seen_at INTEGER
		);
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
			created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL, user_agent TEXT
		);
		CREATE INDEX idx_sessions_expires ON sessions(expires_at);
		CREATE TABLE incidents (
			id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, severity TEXT NOT NULL,
			status TEXT NOT NULL, title TEXT NOT NULL, summary TEXT,
			root_cause_service TEXT, root_cause_fingerprint TEXT,
			affected_services TEXT NOT NULL DEFAULT '[]',
			first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
			resolved_at INTEGER, occurrences INTEGER NOT NULL DEFAULT 1
		);
		CREATE TABLE incident_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
			at INTEGER NOT NULL, severity TEXT NOT NULL, message TEXT NOT NULL
		);
		CREATE INDEX idx_incident_events_incident ON incident_events(incident_id, at);
		CREATE TABLE service_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT, service_key TEXT, kind TEXT NOT NULL,
			message TEXT NOT NULL, at INTEGER NOT NULL
		);
		CREATE INDEX idx_service_events_time ON service_events(at);
		CREATE TABLE health_transitions (
			id INTEGER PRIMARY KEY AUTOINCREMENT, service_key TEXT NOT NULL,
			from_health TEXT, to_health TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL
		);
		CREATE INDEX idx_health_transitions_time ON health_transitions(at);
		CREATE UNIQUE INDEX idx_incidents_active_fingerprint ON incidents(fingerprint) WHERE status = 'active';
	`);
	db.exec(`
		INSERT INTO schema_version (version, name, applied_at) VALUES (1, 'initial schema', 0), (2, 'unique active fingerprint per incident', 1);
		INSERT INTO users (id, username, password_hash, created_at, last_login_at, last_seen_at) VALUES (1, 'owner', 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 0, 0, 0);
		INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES ('sess-fixture', 1, 0, 9999999999999, 0, 'fixture');
		INSERT INTO settings (key, value, updated_at) VALUES
			('dumb.url', 'http://192.168.1.100:3005', 0), ('dumb.credentials', 'v1:iv:tag:ciphertext', 0),
			('setup.completed', 'true', 0), ('ui.theme', 'dark', 0);
		INSERT INTO incidents (id, fingerprint, severity, status, title, summary, affected_services, first_seen, last_seen, occurrences)
			VALUES ('inc-fixture', 'dumb-credentials:fixture', 'warning', 'active', 'DUMB credentials rejected', NULL, '[]', 0, 0, 1);
	`);
	db.close();
	return file;
}

describe('v0.1.1 → v0.2 migration', () => {
	let file: string;

	beforeAll(() => {
		file = createV011Fixture();
		const db = new DatabaseSync(file);
		runMigrations(db);
		db.close();
	});

	it('applies migration 3 and reports version 4 (media snapshots)', () => {
		const db = new DatabaseSync(file, { readOnly: true });
		expect(currentVersion(db)).toBe(4);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all()
			.map((r) => r.name);
		db.close();
		expect(tables).toContain('integrations');
		expect(tables).toContain('activity');
		expect(tables).toContain('media_snapshots');
	});

	it('preserves users, sessions, settings, incidents', () => {
		const db = new DatabaseSync(file, { readOnly: true });
		expect(db.prepare('SELECT COUNT(*) c FROM users').get()?.c).toBe(1);
		expect(db.prepare('SELECT COUNT(*) c FROM sessions').get()?.c).toBe(1);
		const creds = db.prepare("SELECT value FROM settings WHERE key = 'dumb.credentials'").get() as
			{ value: string } | undefined;
		expect(creds?.value).toBe('v1:iv:tag:ciphertext'); // decryptable by the app key
		expect(
			db.prepare("SELECT value FROM settings WHERE key = 'setup.completed'").get()?.value
		).toBe('true');
		expect(db.prepare('SELECT status FROM incidents').get()?.status).toBe('active');
		db.close();
	});

	it('boot after migration does not re-run setup', () => {
		// settings.setup.completed survived migration → the wizard stays closed.
		const db = new DatabaseSync(file, { readOnly: true });
		const completed = db.prepare("SELECT value FROM settings WHERE key = 'setup.completed'").get();
		db.close();
		expect(completed?.value).toBe('true');
	});
});

/**
 * Release rehearsal for the Library release (v0.3.0 → current): a realistic
 * v0.3.0 database (schema_version 3, integrations + activity populated) must
 * migrate to version 4 with every user row preserved — no setup wizard, no
 * credential loss (release brief §7/§11/§12).
 */
function createV030Fixture(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-v030-'));
	const file = path.join(dir, 'dumbscope.db');
	const db = new DatabaseSync(file);
	// Migrations 1–3 are applied verbatim by running them from source, then
	// seeding v0.3.0-shaped data (guarantees schema fidelity).
	runMigrations(db, 3);
	db.exec(`
		INSERT INTO users (id, username, password_hash, created_at, last_login_at)
			VALUES (1, 'owner', 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', 0, 0);
		INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent)
			VALUES ('sess-v030', 1, 0, 9999999999999, 0, 'fixture');
		INSERT INTO settings (key, value, updated_at) VALUES
			('dumb.url', 'http://192.168.1.100:3005', 0),
			('dumb.credentials', 'v1:iv:tag:ciphertext', 0),
			('setup.completed', 'true', 0);
		INSERT INTO integrations (id, type, url, api_key_enc, enabled, created_at, updated_at, last_test_at, last_test_ok)
			VALUES ('sonarr-main', 'sonarr', 'http://192.168.1.100:8989', 'v1:iv:tag:apikey', 1, 0, 0, 0, 1);
		INSERT INTO activity (id, at, source, service_key, category, title, detail, severity, observed)
			VALUES ('act-fixture', 0, 'sonarr-main', 'sonarr', 'grab', 'Grabbed: fixture', NULL, NULL, 1);
		INSERT INTO incidents (id, fingerprint, severity, status, title, affected_services, first_seen, last_seen, occurrences)
			VALUES ('inc-v030', 'fixture:v030', 'warning', 'resolved', 'Old incident', '[]', 0, 0, 1);
	`);
	db.close();
	return file;
}

describe('v0.3.0 → current migration (release rehearsal)', () => {
	let file: string;

	beforeAll(() => {
		file = createV030Fixture();
		const db = new DatabaseSync(file);
		runMigrations(db);
		db.close();
	});

	it('applies migration 4 exactly once and reports version 4', () => {
		const db = new DatabaseSync(file, { readOnly: true });
		expect(currentVersion(db)).toBe(4);
		const rows = db
			.prepare('SELECT version, COUNT(*) c FROM schema_version GROUP BY version ORDER BY version')
			.all() as { version: number; c: number }[];
		db.close();
		expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4]);
		expect(rows.every((r) => r.c === 1)).toBe(true);
	});

	it('preserves users, sessions, settings, incidents, activity', () => {
		const db = new DatabaseSync(file, { readOnly: true });
		expect(db.prepare('SELECT COUNT(*) c FROM users').get()?.c).toBe(1);
		expect(db.prepare('SELECT COUNT(*) c FROM sessions').get()?.c).toBe(1);
		expect(
			(
				db.prepare("SELECT value FROM settings WHERE key = 'dumb.credentials'").get() as {
					value: string;
				}
			).value
		).toBe('v1:iv:tag:ciphertext');
		expect(
			(
				db.prepare("SELECT value FROM settings WHERE key = 'setup.completed'").get() as {
					value: string;
				}
			).value
		).toBe('true');
		expect((db.prepare('SELECT status FROM incidents').get() as { status: string }).status).toBe(
			'resolved'
		);
		expect(db.prepare('SELECT COUNT(*) c FROM activity').get()?.c).toBe(1);
		db.close();
	});

	it('preserves existing integration rows incl. encrypted credentials (§12)', () => {
		const db = new DatabaseSync(file, { readOnly: true });
		const row = db
			.prepare(
				"SELECT id, type, url, api_key_enc, enabled FROM integrations WHERE id = 'sonarr-main'"
			)
			.get() as { id: string; type: string; url: string; api_key_enc: string; enabled: number };
		db.close();
		expect(row).toEqual({
			id: 'sonarr-main',
			type: 'sonarr',
			url: 'http://192.168.1.100:8989',
			api_key_enc: 'v1:iv:tag:apikey',
			enabled: 1
		});
	});
});

/**
 * v0.4-like intermediate state (release brief §8): a database that already
 * has migration 4 (as a Library Intelligence preview install would) must be
 * a no-op on upgrade — no duplicate tables/indexes/version rows.
 */
describe('already-current schema is a no-op (idempotence)', () => {
	it('re-running migrations changes nothing', () => {
		const file = createV030Fixture();
		// First bring to current, snapshot the full schema, then re-run.
		const db = new DatabaseSync(file);
		runMigrations(db);
		const objectsBefore = db
			.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name')
			.all();
		const versionRowsBefore = db
			.prepare('SELECT version, name FROM schema_version ORDER BY version')
			.all();
		runMigrations(db); // second boot
		const objectsAfter = db
			.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name')
			.all();
		const versionRowsAfter = db
			.prepare('SELECT version, name FROM schema_version ORDER BY version')
			.all();
		const version = currentVersion(db);
		db.close();
		expect(objectsAfter).toEqual(objectsBefore);
		expect(versionRowsAfter).toEqual(versionRowsBefore);
		expect(version).toBe(4);
	});
});
