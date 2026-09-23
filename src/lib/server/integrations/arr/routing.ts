/**
 * Sonarr/Radarr deep observability + download routing statistics (brief §5/§6).
 *
 * Adds two low-frequency pollers to the existing Arr adapter set (read-only):
 *   - stack (5 min): queue, blocklist, history totals, DB size (via the
 *     instance's own scheduled backup sizes), uptime, version.
 *   - routing (10 min): download clients + delay profile + a history-window
 *     aggregate per client (grabs/imports/failures) so it is directly visible
 *     whether Decypharr is the working primary and when InfiniDysk (or any
 *     fallback) actually gets used.
 *
 * Aggregation is pure and testable; the pollers only fetch and cache. No
 * notifications are produced here — routing is an observability view.
 */
import type { RoutingClientStats } from '$lib/types';

/** A trimmed Arr history record (only the fields the aggregate needs). */
export interface ArrHistoryRecord {
	eventType?: string;
	date?: string;
	data?: {
		downloadClient?: string;
		client?: string;
		indexer?: string;
		protocol?: string;
		reason?: string;
	};
}

export const ARR_OBS_TUNING = {
	/** History window for the per-client aggregate (hours). */
	windowHours: 24,
	/** Second window (hours) — 7 days for trend context. */
	longWindowHours: 168,
	/** Max history records fetched per poll (bounded request). */
	maxHistoryRecords: 2000
} as const;

/** Event-type vocabulary across Sonarr/Radarr v3 APIs. */
const GRAB_EVENTS = new Set(['grabbed']);
const IMPORT_EVENTS = new Set([
	'downloadFolderImported',
	'episodeImported',
	'movieImported',
	'trackImported'
]);
const FAILURE_EVENTS = new Set(['downloadFailed', 'importFailed']);

function clientName(record: ArrHistoryRecord): string {
	return record.data?.downloadClient ?? record.data?.client ?? 'unknown';
}

export interface ClientWindowStats {
	grabs: number;
	imports: number;
	failures: number;
}

/** Aggregate grab/import/failure counts per download client over a window. */
export function aggregateRoutingByClient(
	records: ArrHistoryRecord[],
	windowHours: number,
	now = Date.now()
): Map<string, ClientWindowStats> {
	const cutoff = now - windowHours * 3_600_000;
	const out = new Map<string, ClientWindowStats>();
	for (const record of records) {
		const at = record.date ? Date.parse(record.date) : NaN;
		if (!Number.isFinite(at) || at < cutoff) continue;
		const name = clientName(record);
		const stats = out.get(name) ?? { grabs: 0, imports: 0, failures: 0 };
		const type = record.eventType ?? '';
		if (GRAB_EVENTS.has(type)) stats.grabs++;
		else if (IMPORT_EVENTS.has(type)) stats.imports++;
		else if (FAILURE_EVENTS.has(type)) stats.failures++;
		out.set(name, stats);
	}
	return out;
}

export interface RoutingClientConfig {
	name: string;
	protocol: string | null;
	priority: number | null;
	enabled: boolean;
}

/** Per-Arr routing view (the hub merges Sonarr + Radarr into one panel). */
export interface ArrRoutingView {
	windowHours: number;
	clients: RoutingClientStats[];
	/** Preferred protocol from this Arr's delay profile ('usenet'/'torrent'). */
	preferredProtocol: string | null;
	fetchedAt: number;
}

/** Compose the per-Arr routing view: configured clients + window aggregates. */
export function buildRoutingObservability(
	clients: RoutingClientConfig[],
	history: ArrHistoryRecord[],
	preferredProtocol: string | null,
	windowHours: number = ARR_OBS_TUNING.windowHours,
	now = Date.now()
): ArrRoutingView {
	const aggregates = aggregateRoutingByClient(history, windowHours, now);
	const enabled = clients.filter((c) => c.enabled);
	const lowestPriority = enabled.reduce<number | null>(
		(best, c) => (c.priority !== null && (best === null || c.priority < best) ? c.priority : best),
		null
	);
	const stats: RoutingClientStats[] = clients.map((c) => {
		const agg = aggregates.get(c.name) ?? { grabs: 0, imports: 0, failures: 0 };
		const completions = agg.imports + agg.failures;
		return {
			client: c.name,
			protocol: c.protocol,
			priority: c.priority,
			enabled: c.enabled,
			grabs: agg.grabs,
			imports: agg.imports,
			failures: agg.failures,
			successRate: completions > 0 ? agg.imports / completions : null,
			// The Arr-configured primary: lowest priority among enabled clients
			// (Arr tries clients in priority order; ties break by protocol
			// preference in the delay profile, which we display separately).
			primary: c.enabled && c.priority !== null && c.priority === lowestPriority
		};
	});
	stats.sort(
		(a, b) => b.grabs + b.imports - (a.grabs + a.imports) || a.client.localeCompare(b.client)
	);
	return {
		windowHours,
		clients: stats,
		preferredProtocol,
		fetchedAt: now
	};
}

/** Extract download-client configuration from a raw /api/v3/downloadclient payload. */
export function parseDownloadClients(raw: unknown[]): RoutingClientConfig[] {
	return raw
		.filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
		.map((c) => ({
			name: typeof c['name'] === 'string' ? c['name'] : 'unknown',
			protocol: typeof c['protocol'] === 'string' ? c['protocol'] : null,
			priority: typeof c['priority'] === 'number' ? c['priority'] : null,
			enabled: c['enable'] === true
		}));
}

/** Extract the delay profile's preferred protocol ('usenet'|'torrent'|null). */
export function parsePreferredProtocol(raw: unknown): string | null {
	const records = Array.isArray(raw) ? raw : [raw];
	for (const profile of records) {
		if (typeof profile !== 'object' || profile === null) continue;
		const preferred = (profile as Record<string, unknown>)['preferredProtocol'];
		if (preferred === 'usenet' || preferred === 'torrent') return preferred;
	}
	return null;
}

/** Which event types count as download failures → timeline facts. */
export function isDownloadFailure(record: ArrHistoryRecord): boolean {
	const type = record.eventType ?? '';
	return FAILURE_EVENTS.has(type);
}
