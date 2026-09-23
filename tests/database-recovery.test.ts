/**
 * SQLite upgrade / restore / restart validation (v0.8.1):
 * - migrating a real previous-schema (v8) database with pre-v0.8 rows must
 *   preserve every row and land on the current schema with correct defaults;
 * - backup/restore (file copy) must start cleanly and keep all data;
 * - WAL-backed data must survive a clean restart.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations, currentVersion } from '../src/lib/server/database/migrations';
import { getDb, closeDb, configDir } from '../src/lib/server/database/db';
import { IncidentEngine } from '../src/lib/server/incidents/engine';
import { incidentRepository } from '../src/lib/server/incidents/repository';
import { Fingerprints } from '../src/lib/server/incidents/fingerprint';

const DB_FILE = () => path.join(configDir(), 'dumbscope.db');

beforeEach(() => {
	closeDb();
	try {
		for (const suffix of ['', '-wal', '-shm']) {
			fs.rmSync(DB_FILE() + suffix, { force: true });
		}
	} catch {
		// best effort
	}
});

afterEach(() => {
	closeDb();
});

/** Build a database exactly as v0.7.2 (schema version 8) would have left it. */
function createV8Database(): void {
	const db = new DatabaseSync(DB_FILE());
	db.exec('PRAGMA journal_mode = WAL;');
	runMigrations(db, 8);
	// Pre-v0.8 incidents: no detector / lifecycle columns exist yet.
	db.prepare(
		`INSERT INTO incidents (id, fingerprint, severity, status, title, summary, root_cause_service,
		 root_cause_fingerprint, affected_services, first_seen, last_seen, resolved_at, occurrences)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		'legacy-1',
		Fingerprints.memoryAnomaly('sonarr'),
		'warning',
		'active',
		'sonarr memory use is unusually high',
		null,
		null,
		null,
		'[]',
		Date.now() - 3_600_000,
		Date.now() - 60_000,
		null,
		1
	);
	db.prepare(
		`INSERT INTO incidents (id, fingerprint, severity, status, title, summary, root_cause_service,
		 root_cause_fingerprint, affected_services, first_seen, last_seen, resolved_at, occurrences)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	).run(
		'legacy-2',
		Fingerprints.serviceUnhealthy('prowlarr'),
		'critical',
		'active',
		'prowlarr is unhealthy',
		null,
		null,
		null,
		'["prowlarr"]',
		Date.now() - 7_200_000,
		Date.now() - 120_000,
		null,
		2
	);
	// Pre-v0.8 memory samples: no instance_key column yet.
	db.prepare('INSERT INTO memory_samples (process, at, rss_bytes) VALUES (?, ?, ?)').run(
		'sonarr',
		Date.now() - 120_000,
		2_000_000_000
	);
	db.close();
}

describe('schema upgrade from v0.7.2 (version 8)', () => {
	it('preserves all rows, applies defaults, and lands on the current version', () => {
		createV8Database();
		expect(currentVersion(new DatabaseSync(DB_FILE(), { readOnly: true }))).toBe(8);

		getDb(); // opens and migrates to current
		expect(currentVersion(new DatabaseSync(DB_FILE(), { readOnly: true }))).toBeGreaterThan(8);

		const db = getDb();
		const columns = (db.prepare("PRAGMA table_info('incidents')").all() as { name: string }[]).map(
			(c) => c.name
		);
		for (const column of ['detector', 'last_evaluated_at', 'resolution_kind', 'acknowledged_at']) {
			expect(columns).toContain(column);
		}
		// Legacy rows survive with the documented defaults.
		const rows = db
			.prepare('SELECT id, detector, last_evaluated_at, resolution_kind FROM incidents ORDER BY id')
			.all() as { id: string; detector: string; last_evaluated_at: number | null }[];
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.detector === '' && r.last_evaluated_at === null)).toBe(true);

		// Memory samples keep their rows and gain the instance key default.
		const samples = db.prepare('SELECT process, instance_key FROM memory_samples').all() as {
			process: string;
			instance_key: string;
		}[];
		expect(samples).toHaveLength(1);
		expect(samples[0]!.instance_key).toBe('');
	});

	it('hydrated pre-v0.8 incidents are safely re-evaluated after the upgrade', () => {
		createV8Database();
		getDb();
		const engine = new IncidentEngine();
		engine.hydrate();
		expect(engine.getActive()).toHaveLength(2);

		// The service is healthy now: the legacy incident resolves as RECOVERED.
		const now = Date.now();
		const healthy = {
			key: 'prowlarr',
			name: 'Prowlarr',
			processName: 'prowlarr',
			enabled: true,
			runState: 'running' as const,
			health: 'healthy' as const,
			healthReason: null,
			healthDetails: null,
			restart: null,
			cpuPercent: null,
			memoryBytes: null,
			pid: 1,
			observedAt: now
		};
		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[healthy.key, healthy]]));
		const resolved = incidentRepository.findLatestByFingerprint(
			Fingerprints.serviceUnhealthy('prowlarr')
		);
		expect(resolved?.status).toBe('resolved');
		expect(resolved?.resolutionKind).toBe('recovered');

		// The other legacy incident stays open until its detector evaluates it
		// (its fingerprint is stable across the upgrade, so re-adoption works).
		expect(
			engine.getActive().some((i) => i.fingerprint === Fingerprints.memoryAnomaly('sonarr'))
		).toBe(true);
	});
});

describe('backup / restore', () => {
	it('restores from a file-copy backup and starts cleanly with intact data', () => {
		// Populate a database.
		const db = getDb();
		db.prepare(
			`INSERT INTO incidents (id, fingerprint, severity, status, title, summary, root_cause_service,
			 root_cause_fingerprint, affected_services, first_seen, last_seen, resolved_at, occurrences,
			 detector, last_evaluated_at, last_evidence_at, acknowledged_at, resolution_kind, resolution_reason)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			'backup-row',
			'test:backup',
			'warning',
			'resolved',
			'backup test incident',
			null,
			null,
			null,
			'[]',
			Date.now(),
			Date.now(),
			Date.now(),
			1,
			'memory',
			Date.now(),
			Date.now(),
			null,
			'recovered',
			'test'
		);
		const versionBefore = currentVersion(db);
		closeDb();

		// Backup: copy the (closed) database file aside, then lose the original.
		const backup = DB_FILE() + '.bak';
		fs.copyFileSync(DB_FILE(), backup);
		for (const suffix of ['', '-wal', '-shm']) {
			fs.rmSync(DB_FILE() + suffix, { force: true });
		}

		// Restore and start: the schema is current already, migrations are a no-op.
		fs.copyFileSync(backup, DB_FILE());
		const reopened = getDb();
		expect(currentVersion(reopened)).toBe(versionBefore);
		const restored = reopened
			.prepare("SELECT id, resolution_kind FROM incidents WHERE id = 'backup-row'")
			.get() as { id: string; resolution_kind: string } | undefined;
		expect(restored?.id).toBe('backup-row');
		expect(restored?.resolution_kind).toBe('recovered');
		fs.rmSync(backup, { force: true });
	});
});

describe('WAL persistence across a clean restart', () => {
	it('keeps committed data visible after close and reopen', () => {
		const db = getDb();
		db.prepare(
			`INSERT INTO incidents (id, fingerprint, severity, status, title, summary, root_cause_service,
			 root_cause_fingerprint, affected_services, first_seen, last_seen, resolved_at, occurrences,
			 detector, last_evaluated_at, last_evidence_at, acknowledged_at, resolution_kind, resolution_reason)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			'wal-row',
			'test:wal',
			'warning',
			'active',
			'wal test incident',
			null,
			null,
			null,
			'[]',
			Date.now(),
			Date.now(),
			null,
			1,
			'memory',
			Date.now(),
			Date.now(),
			null,
			null,
			null
		);
		closeDb(); // clean shutdown: SQLite checkpoints the WAL

		const reopened = getDb();
		const row = reopened.prepare("SELECT id FROM incidents WHERE id = 'wal-row'").get() as
			{ id: string } | undefined;
		expect(row?.id).toBe('wal-row');

		// A journal-mode change is not part of restart; WAL mode must persist.
		const mode = reopened.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
		expect(mode.journal_mode.toLowerCase()).toBe('wal');
	});
});
