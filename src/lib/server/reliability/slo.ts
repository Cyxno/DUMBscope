/**
 * Per-service operational statistics (§12): availability, incident counts,
 * restart counts, degraded/unavailable time, longest outage and MTTR over
 * 24h / 7d / 30d windows.
 *
 * What "availability" honestly means here: the share of *monitored* time in
 * the window during which DUMBscope had no open unhealthy/stopped/degraded
 * evidence for the service (incidents `svc-unhealthy`/`svc-stopped`/
 * `svc-degraded` bound to it). Time before DUMBscope first observed the
 * service, and time while DUMBscope itself was not running, is EXCLUDED from
 * the denominator and reported as `coverageMs` — availability is never
 * claimed over unmonitored periods.
 *
 * Source data: the existing incident history + the observed service-events
 * table. No second history store.
 */
import { getDb } from '../database/db';

export interface ServiceSlo {
	serviceKey: string;
	name: string;
	windowMs: number;
	/** Monitored time in the window (ms) — window ∩ observed-by-DUMBscope time. */
	coverageMs: number;
	/** Full window length (ms). */
	windowLengthMs: number;
	/** Monitored time without open unhealthy/stopped/degraded incidents. */
	availableMs: number;
	availability: number | null;
	incidentCount: number;
	restartCount: number;
	/** Total time with an open availability-relevant incident (ms). */
	degradedMs: number;
	longestOutageMs: number;
	/** Mean time to recovery across resolved incidents (ms | null). */
	mttrMs: number | null;
	/** Epoch ms of the earliest evidence for this service in the window. */
	firstObservedAt: number | null;
}

export const WINDOWS = [24 * 60 * 60_000, 7 * 24 * 60 * 60_000, 30 * 24 * 60 * 60_000] as const;

interface OutageInterval {
	firstSeen: number;
	resolvedAt: number | null;
}

function loadOutages(since: number, serviceKey: string): OutageInterval[] {
	// Availability-relevant fingerprints, matched by prefix against stored
	// fingerprints; the affected entity recorded on the row binds them to the
	// service (JSON array containment via LIKE on the encoded key).
	const rows = getDb()
		.prepare(
			`SELECT fingerprint, affected_services, first_seen, resolved_at, status
			 FROM incidents
			 WHERE last_seen >= ?
			   AND (fingerprint LIKE 'svc-unhealthy:%' OR fingerprint LIKE 'svc-stopped:%' OR fingerprint LIKE 'svc-degraded:%')
			   AND affected_services LIKE ?`
		)
		.all(since, `%${JSON.stringify(serviceKey).slice(1, -1)}%`) as {
		fingerprint: string;
		affected_services: string;
		first_seen: number;
		resolved_at: number | null;
		status: string;
	}[];
	return rows
		.filter((row) => {
			try {
				return (JSON.parse(row.affected_services) as string[]).includes(serviceKey);
			} catch {
				return false;
			}
		})
		.map((row) => ({
			firstSeen: row.first_seen,
			resolvedAt: row.resolved_at
		}));
}

/** Observed restarts (service-started transitions) in the window. */
function restartCount(serviceKey: string, since: number): number {
	const row = getDb()
		.prepare(
			`SELECT COUNT(*) AS c FROM service_events
			 WHERE kind = 'service-started' AND service_key = ? AND at >= ?`
		)
		.get(serviceKey, since) as { c: number };
	return Number(row.c ?? 0);
}

/** Earliest evidence DUMBscope has for a service (incidents + events). */
export function firstObservedAtFor(serviceKey: string): number | null {
	const incident = getDb()
		.prepare(`SELECT MIN(first_seen) AS t FROM incidents WHERE affected_services LIKE ?`)
		.get(`%${JSON.stringify(serviceKey).slice(1, -1)}%`) as { t: number | null };
	const event = getDb()
		.prepare(`SELECT MIN(at) AS t FROM service_events WHERE service_key = ?`)
		.get(serviceKey) as { t: number | null };
	const candidates = [incident.t, event.t].filter((t): t is number => t !== null);
	return candidates.length > 0 ? Math.min(...candidates) : null;
}

export function serviceSlo(
	serviceKey: string,
	name: string,
	windowMs: number,
	firstObservedAt: number | null,
	now = Date.now()
): ServiceSlo {
	const windowStart = now - windowMs;
	const outages = loadOutages(windowStart, serviceKey);
	const restarts = restartCount(serviceKey, windowStart);

	// Coverage: from the later of window start and first observation.
	const coverageStart = Math.max(windowStart, firstObservedAt ?? windowStart);
	const coverageMs = Math.max(0, now - coverageStart);

	// Merge outages into busy time (clamped to coverage).
	let degradedMs = 0;
	let longest = 0;
	let resolvedCount = 0;
	let totalRecoveryMs = 0;
	for (const outage of outages) {
		const start = Math.max(outage.firstSeen, coverageStart);
		const end = outage.resolvedAt ?? now;
		const duration = Math.max(0, end - start);
		degradedMs += duration;
		longest = Math.max(longest, duration);
		if (outage.resolvedAt !== null) {
			resolvedCount++;
			totalRecoveryMs += Math.max(0, outage.resolvedAt - outage.firstSeen);
		}
	}
	const incidentCount = outages.length;
	return {
		serviceKey,
		name,
		windowMs,
		coverageMs,
		windowLengthMs: windowMs,
		availableMs: Math.max(0, coverageMs - degradedMs),
		availability:
			coverageMs > 0 ? Math.max(0, Math.min(1, (coverageMs - degradedMs) / coverageMs)) : null,
		incidentCount,
		restartCount: restarts,
		degradedMs,
		longestOutageMs: longest,
		mttrMs: resolvedCount > 0 ? Math.round(totalRecoveryMs / resolvedCount) : null,
		firstObservedAt
	};
}

/** SLO rows for every service that has any incident/evidence history. */
export function allServiceSlos(
	displayNameFor: (serviceKey: string) => string,
	firstObservedFor: (serviceKey: string) => number | null,
	now = Date.now()
): ServiceSlo[] {
	const keys = new Set<string>();
	const rows = getDb()
		.prepare(
			`SELECT DISTINCT affected_services FROM incidents
			 WHERE fingerprint LIKE 'svc-%' AND last_seen >= ?`
		)
		.all(now - 30 * 24 * 60 * 60_000) as { affected_services: string }[];
	for (const row of rows) {
		try {
			const parsed = JSON.parse(row.affected_services) as string[];
			for (const key of parsed) keys.add(key);
		} catch {
			// malformed row: skip
		}
	}
	const events = getDb()
		.prepare(
			`SELECT DISTINCT service_key FROM service_events
			 WHERE service_key IS NOT NULL AND at >= ?`
		)
		.all(now - 30 * 24 * 60 * 60_000) as { service_key: string }[];
	for (const row of events) keys.add(row.service_key);

	return [...keys]
		.map((key) => serviceSlo(key, displayNameFor(key), WINDOWS[0], firstObservedFor(key), now))
		.sort((a, b) => (a.availability ?? 1) - (b.availability ?? 1));
}
