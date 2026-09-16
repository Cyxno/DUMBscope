/**
 * Plex library source for reconciliation.
 *
 * The media-parts table is the only place Plex records concrete file paths,
 * and the HTTP API cannot return them in bulk, so the reconciliation reads a
 * throwaway snapshot copy of Plex's library database with node:sqlite.
 * The original database is never opened or written — SQLite may be mid-
 * transaction, the copy is what we read (WAL pages ride along so the
 * snapshot is consistent enough for divergence detection).
 *
 * All configuration comes from settings; when no Plex database path is
 * configured the Plex dimension is skipped honestly (coverage is reported).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { PlexPartRecord } from './library';

export interface PlexSnapshot {
	parts: PlexPartRecord[];
	sections: { id: number; name: string; type: number }[];
}

export function readPlexLibrarySnapshot(dbPath: string): PlexSnapshot {
	const tmp = path.join(os.tmpdir(), `dumbscope-plex-snapshot-${process.pid}.db`);
	try {
		fs.copyFileSync(dbPath, tmp);
		for (const ext of ['-wal', '-shm']) {
			const src = dbPath + ext;
			if (fs.existsSync(src)) {
				try {
					fs.copyFileSync(src, tmp + ext);
				} catch {
					// best effort — a missing WAL just means an older snapshot
				}
			}
		}
		const db = new DatabaseSync(tmp, { readOnly: true });
		try {
			const sections: PlexSnapshot['sections'] = [];
			for (const row of db
				.prepare('SELECT id, name, section_type FROM library_sections')
				.iterate() as Iterable<{ id: number; name: string; section_type: number }>) {
				sections.push({
					id: Number(row.id),
					name: String(row.name),
					type: Number(row.section_type)
				});
			}
			const parts: PlexPartRecord[] = [];
			const q = `
				SELECT mi.library_section_id AS section,
				       mp.id AS part_id,
				       mp.file AS file,
				       mp.size AS size
				FROM media_parts mp
				JOIN media_items mi ON mi.id = mp.media_item_id
				WHERE mp.file IS NOT NULL AND mp.file != ''
				  AND mp.deleted_at IS NULL
			`;
			for (const row of db.prepare(q).iterate() as Iterable<{
				section: number;
				part_id: number;
				file: string;
				size: number | null;
			}>) {
				parts.push({
					key: `plex:part:${row.part_id}`,
					label: path.basename(String(row.file)),
					path: String(row.file),
					sectionId: Number(row.section),
					size: row.size === null ? null : Number(row.size)
				});
			}
			return { parts, sections };
		} finally {
			db.close();
		}
	} finally {
		try {
			fs.rmSync(tmp, { force: true });
			fs.rmSync(tmp + '-wal', { force: true });
			fs.rmSync(tmp + '-shm', { force: true });
		} catch {
			// best effort
		}
	}
}

/**
 * Ask Plex to rescan a section. Opt-in remediation: only called when the
 * user configured Plex credentials AND enabled auto-refresh. Uses the
 * section refresh endpoint — the per-path scan endpoint is gone on current
 * PMS builds (production test 2026-09-16: /scan 404, /refresh 200).
 */
export async function refreshPlexSection(
	baseUrl: string,
	token: string,
	sectionId: number
): Promise<boolean> {
	try {
		const url = `${baseUrl.replace(/\/$/, '')}/library/sections/${sectionId}/refresh?X-Plex-Token=${encodeURIComponent(token)}`;
		const res = await fetch(url, { method: 'GET' });
		return res.ok;
	} catch {
		return false;
	}
}
