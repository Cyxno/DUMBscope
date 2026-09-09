/**
 * Embedded SQLite access layer (zero-dependency, `node:sqlite`).
 *
 * One database file under the config dir (`dumbscope.db`). All schema changes
 * go through versioned migrations in `./migrations.ts`.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { runMigrations } from './migrations';

export interface DatabaseConfig {
	/** Directory holding dumbscope.db, e.g. `/config`. */
	dir: string;
}

let db: DatabaseSync | null = null;
let dbDir: string | null = null;

export function configDir(): string {
	if (dbDir) return dbDir;
	const dir = process.env.DUMBSCOPE_CONFIG_DIR || '/config';
	dbDir = dir;
	return dir;
}

export function isConfiguredOverride(): boolean {
	return Boolean(process.env.DUMBSCOPE_CONFIG_DIR);
}

/** Open (once) and migrate the database. Safe to call repeatedly. */
export function getDb(): DatabaseSync {
	if (db) return db;
	const dir = configDir();
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, 'dumbscope.db');
	db = new DatabaseSync(file);
	db.exec('PRAGMA journal_mode = WAL;');
	db.exec('PRAGMA foreign_keys = ON;');
	db.exec('PRAGMA busy_timeout = 5000;');
	runMigrations(db);
	return db;
}

/** Close the database (used by tests). */
export function closeDb(): void {
	db?.close();
	db = null;
	dbDir = null;
}

export function dbHealthy(): boolean {
	try {
		const row = getDb().prepare('SELECT 1 AS ok').get();
		return row?.ok === 1;
	} catch {
		return false;
	}
}
