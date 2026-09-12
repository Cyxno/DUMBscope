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
