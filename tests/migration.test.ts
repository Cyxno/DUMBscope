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

	it('applies migration 3 and reports the current version (media snapshots, memory samples, acquisition ledger, notifications)', () => {
		const db = new DatabaseSync(file, { readOnly: true });
		expect(currentVersion(db)).toBe(11);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all()
			.map((r) => r.name);
		db.close();
		expect(tables).toContain('integrations');
		expect(tables).toContain('activity');
		expect(tables).toContain('media_snapshots');
		expect(tables).toContain('memory_samples');
		expect(tables).toContain('media_acquisitions');
		expect(tables).toContain('remediation_actions');
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

	it('applies migration 4 exactly once and reports the current version', () => {
		const db = new DatabaseSync(file, { readOnly: true });
		expect(currentVersion(db)).toBe(11);
		const rows = db
			.prepare('SELECT version, COUNT(*) c FROM schema_version GROUP BY version ORDER BY version')
			.all() as { version: number; c: number }[];
		db.close();
		expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
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

	it('applies migration 10 (cgroup tiers + observability timeline)', () => {
		const db = new DatabaseSync(file, { readOnly: true });
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all()
			.map((r) => r.name);
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
			.all()
			.map((r) => r.name);
		db.close();
		expect(tables).toContain('cgroup_samples');
		expect(tables).toContain('cgroup_samples_5m');
		expect(tables).toContain('cgroup_samples_30m');
		expect(tables).toContain('observability_events');
		expect(indexes).toContain('idx_observability_events_at');
		expect(indexes).toContain('idx_observability_events_kind_at');
	});
});

/**
 * v0.4-like intermediate state (release brief §8): a database that already
 * has migration 4 (as a Library Intelligence preview install would) must be
 * a no-op on upgrade — no duplicate tables/indexes/version rows.
 */
/**
 * First start on a truly empty database — the most common production path —
 * must land on the current schema in one shot: every migration applies
 * cleanly in order, with no fixture data anywhere.
 */
describe('empty database → current schema (first start)', () => {
	it('applies all migrations to a brand-new database file', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-empty-'));
		const file = path.join(dir, 'dumbscope.db');
		const db = new DatabaseSync(file);
		expect(currentVersion(db)).toBe(0);
		runMigrations(db);
		const version = currentVersion(db);
		const versionRows = db
			.prepare('SELECT version FROM schema_version ORDER BY version')
			.all()
			.map((r) => (r as { version: number }).version);
		const tables = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
			.all()
			.map((r) => (r as { name: string }).name);
		const activeActions = db
			.prepare("SELECT COUNT(*) c FROM integration_actions WHERE state IN ('requested','accepted')")
			.get() as { c: number };
		// The claim index exists from the very first boot.
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type='index'")
			.all()
			.map((r) => (r as { name: string }).name);
		db.close();
		expect(version).toBe(11);
		expect(versionRows).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
		expect(tables).toContain('users');
		expect(tables).toContain('incidents');
		expect(tables).toContain('integration_actions');
		expect(tables).toContain('cgroup_samples');
		expect(tables).toContain('observability_events');
		expect(indexes).toContain('idx_integration_actions_active_claim');
		expect(activeActions.c).toBe(0);
	});
});

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
		expect(version).toBe(11);
	});
});

/**
 * v0.9.7 → v0.11 migration: a database left with in-flight Safe Actions rows
 * by a crashed process — including two ACTIVE rows for the same logical
 * action, which the pre-v0.11 executor could produce under concurrency —
 * must migrate cleanly: in-flight rows settle to an honest 'unconfirmed'
 * BEFORE the active-claim UNIQUE index is created, so the index can never
 * fail on existing production rows, and duplicate claims become
 * structurally impossible afterwards.
 */
describe('v0.9.7 → v0.11 migration (interrupted Safe Actions settlement)', () => {
	function createCrashedActionsFixture(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-v0911-'));
		const file = path.join(dir, 'dumbscope.db');
		const db = new DatabaseSync(file);
		runMigrations(db, 8); // integration_actions exists from migration 8 on
		const t = 1_700_000_000_000;
		db.exec(`
			INSERT INTO integration_actions (id, action, integration_id, target, target_key, actor, state, requested_at)
				VALUES ('dup-1', 'sonarr.searchEpisode', 'sonarr-main', 'episode:42', 'sonarr.searchEpisode:episode:42', 'admin', 'requested', ${t});
			INSERT INTO integration_actions (id, action, integration_id, target, target_key, actor, state, requested_at)
				VALUES ('dup-2', 'sonarr.searchEpisode', 'sonarr-main', 'episode:42', 'sonarr.searchEpisode:episode:42', 'admin', 'requested', ${t + 5});
			INSERT INTO integration_actions (id, action, integration_id, target, target_key, actor, state, message, upstream_command_id, requested_at)
				VALUES ('acc-1', 'sonarr.searchEpisode', 'sonarr-main', 'episode:7', 'sonarr.searchEpisode:episode:7', 'admin', 'accepted', 'Search requested (command 99)', 99, ${t});
			INSERT INTO integration_actions (id, action, integration_id, target, target_key, actor, state, message, requested_at, finished_at)
				VALUES ('done-1', 'sonarr.refreshSeries', 'sonarr-main', 'series:3', 'sonarr.refreshSeries:series:3', 'admin', 'completed', 'Refresh: upstream command completed', ${t}, ${t + 1000});
		`);
		db.close();
		return file;
	}

	it('settles interrupted rows to unconfirmed, keeps terminal rows, then enforces the claim index', () => {
		const file = createCrashedActionsFixture();
		const db = new DatabaseSync(file);
		runMigrations(db);
		expect(currentVersion(db)).toBe(11);

		const rows = db
			.prepare(
				'SELECT id, state, message, upstream_command_id, finished_at FROM integration_actions ORDER BY id'
			)
			.all() as {
			id: string;
			state: string;
			message: string | null;
			upstream_command_id: number | null;
			finished_at: number | null;
		}[];

		// Both halves of the pre-migration duplicate are settled honestly.
		const dup1 = rows.find((r) => r.id === 'dup-1')!;
		const dup2 = rows.find((r) => r.id === 'dup-2')!;
		expect(dup1.state).toBe('unconfirmed');
		expect(dup2.state).toBe('unconfirmed');
		expect(dup1.message).toBe('Interrupted by restart before a final state was recorded');
		expect(dup1.finished_at).not.toBeNull();

		// The accepted row keeps its recorded upstream command id (evidence,
		// not fabrication) and settles to the same honest state.
		const acc = rows.find((r) => r.id === 'acc-1')!;
		expect(acc.state).toBe('unconfirmed');
		expect(acc.upstream_command_id).toBe(99);

		// Terminal rows are untouched.
		const done = rows.find((r) => r.id === 'done-1')!;
		expect(done.state).toBe('completed');
		expect(done.message).toBe('Refresh: upstream command completed');

		// The claim index exists and rejects a SECOND active row for the same
		// logical action — the structural half of §13a. (After settlement the
		// first insert is legal: no other active row holds the claim.)
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type='index'")
			.all()
			.map((r) => r.name);
		expect(indexes).toContain('idx_integration_actions_active_claim');
		const claim = db.prepare(
			`INSERT INTO integration_actions (id, action, integration_id, target, target_key, actor, state, requested_at)
			 VALUES (?, 'sonarr.searchEpisode', 'sonarr-main', 'episode:42', 'sonarr.searchEpisode:episode:42', 'admin', 'requested', 9999999999999)`
		);
		expect(() => claim.run('dup-3')).not.toThrow();
		expect(() => claim.run('dup-4')).toThrow(/UNIQUE constraint failed/);
		db.close();
	});
});
