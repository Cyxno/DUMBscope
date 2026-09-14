/**
 * Bounded recent acquisition ledger (DEEL 2, brief §16-§20).
 *
 * One row per upstream request (integration instance + download GUID): poll
 * retries dedupe on that identity, late/out-of-order events only ever move a
 * row forward in state precedence, and retention pruning keeps the table
 * small. This is correlation memory for a short window — never a second media
 * database.
 *
 * Retention is 14 days: the real repeat evidence on this stack spans single
 * minutes (Westworld S02E09, twice in 21 min) up to a few days (Tulsa King
 * S03E07, 09-03 → 09-05) — 14 days comfortably covers the observed retry
 * horizon while keeping the store a few hundred KB.
 */
import { getDb } from '../database/db';
import type { MediaAcquisition } from '$lib/types';

export const LEDGER_TUNING = {
	retentionDays: 14,
	/** Prune cadence; rows are tiny so this is cheap. */
	pruneIntervalMs: 60 * 60_000,
	/** Hard cap: if runaway sources ever flood the ledger, drop the oldest. */
	maxRows: 20_000
} as const;

interface AcqRow {
	integration_id: string;
	request_id: string;
	media_key: string;
	title: string;
	client: string | null;
	first_seen: number;
	last_observed_at: number;
	accepted_at: number | null;
	failed_at: number | null;
	completed_at: number | null;
	last_event: string | null;
}

function toAcquisition(row: AcqRow): MediaAcquisition {
	return {
		integrationId: row.integration_id,
		requestId: row.request_id,
		mediaKey: row.media_key,
		title: row.title,
		client: row.client,
		firstSeen: row.first_seen,
		lastObservedAt: row.last_observed_at,
		acceptedAt: row.accepted_at,
		failedAt: row.failed_at,
		completedAt: row.completed_at,
		lastEvent: row.last_event
	};
}

export class AcquisitionLedger {
	private lastPruneAt = 0;

	constructor(private readonly now: () => number = Date.now) {}

	/** Record one observed event. Returns the row (after upsert). */
	observe(input: {
		integrationId: string;
		requestId: string;
		mediaKey: string;
		title: string;
		client: string | null;
		event: 'grabbed' | 'downloadFailed' | 'downloadFolderImported' | 'downloaded';
		at: number;
	}): MediaAcquisition | null {
		// An event without a stable upstream request identity cannot be
		// correlated — skip rather than guess (title matching is forbidden).
		if (!input.requestId || !input.mediaKey) return null;
		const db = getDb();
		db.prepare(
			`INSERT INTO media_acquisitions
				(integration_id, request_id, media_key, title, client, first_seen, last_observed_at,
				 accepted_at, failed_at, completed_at, last_event)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(integration_id, request_id) DO UPDATE SET
				last_observed_at = MAX(last_observed_at, excluded.last_observed_at),
				accepted_at = COALESCE(accepted_at, excluded.accepted_at),
				failed_at = COALESCE(failed_at, excluded.failed_at),
				completed_at = COALESCE(completed_at, excluded.completed_at),
				client = COALESCE(client, excluded.client),
				last_event = excluded.last_event`
		).run(
			input.integrationId,
			input.requestId,
			input.mediaKey,
			input.title,
			input.client,
			input.at,
			input.at,
			input.event === 'grabbed' ? input.at : null,
			input.event === 'downloadFailed' ? input.at : null,
			input.event === 'downloadFolderImported' || input.event === 'downloaded' ? input.at : null,
			input.event
		);
		this.pruneIfDue();
		const row = db
			.prepare('SELECT * FROM media_acquisitions WHERE integration_id = ? AND request_id = ?')
			.get(input.integrationId, input.requestId) as AcqRow | undefined;
		return row ? toAcquisition(row) : null;
	}

	/** All ledger rows for one media key, newest first. */
	forMedia(mediaKey: string): MediaAcquisition[] {
		const rows = getDb()
			.prepare(
				'SELECT * FROM media_acquisitions WHERE media_key = ? ORDER BY first_seen DESC LIMIT 50'
			)
			.all(mediaKey) as unknown as AcqRow[];
		return rows.map(toAcquisition);
	}

	/** Bounded recent window of the whole ledger (correlation input). */
	recent(sinceMs: number): MediaAcquisition[] {
		const rows = getDb()
			.prepare(
				'SELECT * FROM media_acquisitions WHERE first_seen >= ? ORDER BY first_seen DESC LIMIT 2000'
			)
			.all(this.now() - sinceMs) as unknown as AcqRow[];
		return rows.map(toAcquisition);
	}

	private pruneIfDue(): void {
		const now = this.now();
		if (now - this.lastPruneAt < LEDGER_TUNING.pruneIntervalMs) return;
		this.lastPruneAt = now;
		try {
			const db = getDb();
			db.prepare('DELETE FROM media_acquisitions WHERE last_observed_at < ?').run(
				now - LEDGER_TUNING.retentionDays * 86_400_000
			);
			db.prepare(
				`DELETE FROM media_acquisitions WHERE rowid IN (
					SELECT rowid FROM media_acquisitions ORDER BY last_observed_at DESC LIMIT -1 OFFSET ?
				)`
			).run(LEDGER_TUNING.maxRows);
		} catch {
			// Retention is best-effort; retried on the next observe.
		}
	}
}
