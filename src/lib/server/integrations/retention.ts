/**
 * Bounded retention (brief §24–§26): one in-process daily pass keeps the
 * database small. Runs inside the server process — no worker/container.
 * Logged summary contains counts only, never content.
 */
import { getDb } from '../database/db';

export const RETENTION = {
	/** Semantic + DUMB activity events. */
	activityDays: 14,
	/** Health transition rows. */
	healthTransitionsDays: 30,
	/** Incident rows + their events. */
	incidentsDays: 90
} as const;

export function runRetention(now = Date.now()): {
	activity: number;
	healthTransitions: number;
	incidents: number;
} {
	const db = getDb();
	const activity = db
		.prepare('DELETE FROM activity WHERE at < ?')
		.run(now - RETENTION.activityDays * 86_400_000).changes as number;
	const healthTransitions = db
		.prepare('DELETE FROM health_transitions WHERE at < ?')
		.run(now - RETENTION.healthTransitionsDays * 86_400_000).changes as number;
	// Incidents: resolve-before-delete is the engine's job; retention only
	// removes history older than the window (and their events via FK cascade
	// semantics — explicit delete keeps it obvious).
	const oldIncidents = db
		.prepare(
			`SELECT id FROM incidents WHERE last_seen < ? AND status != 'active'`
		)
		.all(now - RETENTION.incidentsDays * 86_400_000) as { id: string }[];
	for (const row of oldIncidents) {
		db.prepare('DELETE FROM incident_events WHERE incident_id = ?').run(row.id);
		db.prepare('DELETE FROM incidents WHERE id = ?').run(row.id);
	}
	return { activity, healthTransitions, incidents: oldIncidents.length };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Start the daily retention pass (idempotent). */
export function startRetentionJob(): void {
	if ((globalThis as Record<string, unknown>).__dumbscopeRetentionStarted) return;
	(globalThis as Record<string, unknown>).__dumbscopeRetentionStarted = true;
	const tick = () => {
		try {
			const removed = runRetention();
			if (removed.activity + removed.healthTransitions + removed.incidents > 0) {
				console.log(
					`[dumbscope] retention cleanup completed — activity: ${removed.activity} removed, health transitions: ${removed.healthTransitions} removed, incidents: ${removed.incidents} removed`
				);
			}
		} catch (err) {
			console.warn(
				'[dumbscope] retention pass failed:',
				err instanceof Error ? err.message : err
			);
		}
	};
	setTimeout(() => {
		tick();
		setInterval(tick, DAY_MS);
	}, 60_000);
}
