/**
 * Library intelligence service: reads the normalized integration caches
 * (written by the pollers), derives the cross-service library view, records
 * hourly snapshots and serves trend data. Read-only over the pollers' data —
 * a browser request never touches Sonarr/Radarr/Bazarr directly (§49).
 */
import { getIntegrationCache, listIntegrationTypes } from '$lib/server/integrations/manager';
import type {
	AttentionItem,
	LibraryTotals,
	MissingItem,
	MoviesLibrary,
	QueueGroup,
	QueueIssue,
	SubtitlesLibrary,
	TvLibrary
} from './models';
import { countBacklogAges, rankAttention } from './aggregate';
import { getDb } from '../database/db';

interface ArrLibraryCache {
	tv?: TvLibrary;
	movies?: MoviesLibrary;
	missing: MissingItem[];
}

interface BazarrLibraryCache {
	subtitles: SubtitlesLibrary;
	wanted: MissingItem[];
}

interface IntegrationQueueCache {
	queue?: {
		total: number;
		items: {
			title: string;
			status: string;
			trackedDownloadStatus: string;
			trackedDownloadState: string;
			errorMessage: string | null;
		}[];
		warnings: number;
		failures: number;
		fetchedAt: number;
	};
	health?: { source: string; type: string; message: string }[];
}

export interface Availability {
	tv: 'available' | 'unconfigured' | 'unavailable' | 'stale';
	movies: 'available' | 'unconfigured' | 'unavailable' | 'stale';
	subtitles: 'available' | 'unconfigured' | 'unavailable' | 'stale';
}

export interface LibraryView {
	availability: Availability;
	tv: TvLibrary | null;
	movies: MoviesLibrary | null;
	subtitles: SubtitlesLibrary | null;
	queue: { groups: QueueGroup[]; issues: QueueIssue[]; total: number };
	healthWarnings: { integrationId: string; type: string; message: string }[];
	attention: AttentionItem[];
	fetchedAt: number | null;
}

/** Identical messages across services (same download client) group once. */
function dedupeWarnings(warnings: { integrationId: string; type: string; message: string }[]) {
	const byMessage = new Map();
	for (const warning of warnings) {
		const existing = byMessage.get(warning.message);
		if (existing) existing.types.push(warning.type);
		else
			byMessage.set(warning.message, {
				message: warning.message,
				types: [warning.type],
				integrationIds: [warning.integrationId]
			});
	}
	return [...byMessage.values()];
}

const STALE_WINDOW_MS = 30 * 60_000;

interface QueueSource {
	type: string;
	integrationId: string;
	status: string;
	trackedDownloadStatus: string;
	trackedDownloadState: string;
}

interface IntegrationInfo {
	id: string;
	type: string;
	enabled: boolean;
}

function integrationsOfType(...types: string[]): IntegrationInfo[] {
	return listIntegrationTypes().filter((i) => types.includes(i.type) && i.enabled);
}

function worstState(states: Availability['tv'][]): Availability['tv'] {
	if (states.every((s) => s === 'unconfigured')) return 'unconfigured';
	if (states.includes('unavailable')) return 'unavailable';
	if (states.includes('stale')) return 'stale';
	return 'available';
}

/** Merged missing backlog across all configured Sonarr/Radarr instances. */
export function getMissingItems(): MissingItem[] {
	const out: MissingItem[] = [];
	for (const info of integrationsOfType('sonarr', 'radarr')) {
		const cache = getIntegrationCache(info.id) as { library?: ArrLibraryCache };
		out.push(...(cache.library?.missing ?? []));
	}
	return out;
}

/** Bazarr wanted list (subtitle gaps) across configured instances. */
export function getSubtitleWanted(): MissingItem[] {
	const out: MissingItem[] = [];
	for (const info of integrationsOfType('bazarr')) {
		const cache = getIntegrationCache(info.id) as { library?: BazarrLibraryCache };
		out.push(...(cache.library?.wanted ?? []));
	}
	return out;
}

export function getLibraryView(): LibraryView {
	const sonarr = integrationsOfType('sonarr');
	const radarr = integrationsOfType('radarr');
	const bazarr = integrationsOfType('bazarr');

	// --- Sonarr + Radarr (tv / movies) --------------------------------------
	const tvStates: Availability['tv'][] = [];
	const movieStates: Availability['tv'][] = [];
	let tv: TvLibrary | null = null;
	let movies: MoviesLibrary | null = null;
	const missing: MissingItem[] = [];
	const queueSources: QueueSource[] = [];
	const healthWarnings: { integrationId: string; type: string; message: string }[] = [];
	const queueIssuesList: QueueIssue[] = [];
	let lastFetched: number | null = null;

	for (const info of [...sonarr, ...radarr]) {
		const cache = getIntegrationCache(info.id) as {
			library?: ArrLibraryCache;
		} & IntegrationQueueCache & {
				wanted?: { missing: number; cutoffUnmet: number };
			};
		const isTv = info.type === 'sonarr';
		const library = cache.library;
		if (!library || (isTv ? !library.tv : !library.movies)) {
			(isTv ? tvStates : movieStates).push('unavailable');
			continue;
		}
		// Upgrades available = cutoff-unmet count from the existing wanted poller.
		const upgrades = cache.wanted?.cutoffUnmet ?? 0;
		if (isTv && library.tv) {
			library.tv.upgradesAvailable = upgrades;
			tv = mergeTv(tv, library.tv);
			missing.push(...(library.missing ?? []));
			tvStates.push(
				Date.now() - (library.tv.fetchedAt ?? 0) > STALE_WINDOW_MS ? 'stale' : 'available'
			);
			lastFetched = Math.max(lastFetched ?? 0, library.tv.fetchedAt ?? 0);
		}
		if (!isTv && library.movies) {
			library.movies.upgradesAvailable = upgrades;
			movies = mergeMovies(movies, library.movies);
			missing.push(...(library.missing ?? []));
			movieStates.push(
				Date.now() - (library.movies.fetchedAt ?? 0) > STALE_WINDOW_MS ? 'stale' : 'available'
			);
			lastFetched = Math.max(lastFetched ?? 0, library.movies.fetchedAt ?? 0);
		}
	}

	// --- queue + health (existing pollers) ----------------------------------
	let queueTotal = 0;
	for (const info of [...sonarr, ...radarr]) {
		const cache = getIntegrationCache(info.id) as IntegrationQueueCache;
		const q = cache.queue;
		if (q) {
			queueTotal += q.total;
			for (const item of q.items) {
				queueSources.push({
					type: info.type,
					integrationId: info.id,
					status: item.status,
					trackedDownloadStatus: item.trackedDownloadStatus,
					trackedDownloadState: item.trackedDownloadState
				});
			}
		}
		for (const warning of cache.health ?? []) {
			healthWarnings.push({ integrationId: info.id, type: info.type, message: warning.message });
		}
	}
	const { groups, issues } = groupQueues(queueSources);
	queueIssuesList.push(...issues);

	// --- subtitles (Bazarr) --------------------------------------------------
	const subtitleStates: Availability['subtitles'][] = [];
	let subtitles: SubtitlesLibrary | null = null;
	for (const info of bazarr) {
		const cache = getIntegrationCache(info.id) as { library?: BazarrLibraryCache };
		const data = cache.library;
		if (!data?.subtitles) {
			subtitleStates.push('unavailable');
			continue;
		}
		subtitles = mergeSubtitles(subtitles, data.subtitles);
		subtitleStates.push(
			Date.now() - (data.subtitles.fetchedAt ?? 0) > STALE_WINDOW_MS ? 'stale' : 'available'
		);
		lastFetched = Math.max(lastFetched ?? 0, data.subtitles.fetchedAt ?? 0);
	}

	const availability: Availability = {
		tv: sonarr.length === 0 ? 'unconfigured' : worstState(tvStates),
		movies: radarr.length === 0 ? 'unconfigured' : worstState(movieStates),
		subtitles: bazarr.length === 0 ? 'unconfigured' : worstState(subtitleStates)
	};

	// Backlog ages are derived over released missing items only (§13).
	if (tv) tv.backlogAges = countBacklogAges(missing.filter((m) => m.kind === 'episode'));
	if (movies) movies.backlogAges = countBacklogAges(missing.filter((m) => m.kind === 'movie'));

	// Overall subtitle coverage (derived): gaps against the monitored library
	// units reported by Sonarr/Radarr — Bazarr alone has no episode totals.
	if (subtitles) {
		const units = (tv?.totalUnits ?? 0) + (movies?.totalUnits ?? 0);
		subtitles.coveragePct =
			units > 0
				? Math.max(0, Math.round(((units - subtitles.totalGaps) / units) * 1000)) / 10
				: null;
	}

	if (tv && availability.tv === 'stale') tv = { ...tv, fetchedAt: tv.fetchedAt ?? null };
	if (movies && availability.movies === 'stale') movies = { ...movies };

	const attention = rankAttention({
		available: {
			tv: availability.tv === 'available' || availability.tv === 'stale',
			movies: availability.movies === 'available' || availability.movies === 'stale',
			subtitles: availability.subtitles === 'available' || availability.subtitles === 'stale'
		},
		failedImports: queueIssuesList.filter((i) => i.severity === 'issue').length,
		queueIssues: queueIssuesList,
		healthWarnings: dedupeWarnings(healthWarnings).map((w) => ({
			integrationId: w.integrationIds.join(','),
			type: w.types.join(' + '),
			message: w.message
		})),
		missing,
		stale: {
			tv: availability.tv === 'stale',
			movies: availability.movies === 'stale',
			subtitles: availability.subtitles === 'stale'
		}
	});

	return {
		availability,
		tv,
		movies,
		subtitles,
		queue: { groups, issues: queueIssuesList, total: queueTotal },
		healthWarnings,
		attention,
		fetchedAt: lastFetched
	};
}

function mergeTv(base: TvLibrary | null, next: TvLibrary): TvLibrary {
	if (!base) return next;
	return {
		...next,
		seriesTotal: base.seriesTotal + next.seriesTotal,
		seriesMonitored: base.seriesMonitored + next.seriesMonitored,
		monitoredMissing: base.monitoredMissing + next.monitoredMissing,
		upgradesAvailable: base.upgradesAvailable + next.upgradesAvailable,
		queue: base.queue + next.queue,
		failedImports: base.failedImports + next.failedImports,
		totalUnits: (base.totalUnits ?? 0) + (next.totalUnits ?? 0),
		availableUnits: (base.availableUnits ?? 0) + (next.availableUnits ?? 0),
		sizeOnDiskBytes: (base.sizeOnDiskBytes ?? 0) + (next.sizeOnDiskBytes ?? 0),
		fetchedAt: Math.max(base.fetchedAt ?? 0, next.fetchedAt ?? 0),
		series: [...base.series, ...next.series].sort((a, b) => b.missing - a.missing).slice(0, 200)
	};
}

function mergeMovies(base: MoviesLibrary | null, next: MoviesLibrary): MoviesLibrary {
	if (!base) return next;
	return {
		...next,
		moviesTotal: base.moviesTotal + next.moviesTotal,
		moviesMonitored: base.moviesMonitored + next.moviesMonitored,
		monitoredMissing: base.monitoredMissing + next.monitoredMissing,
		upgradesAvailable: base.upgradesAvailable + next.upgradesAvailable,
		queue: base.queue + next.queue,
		failedImports: base.failedImports + next.failedImports,
		totalUnits: (base.totalUnits ?? 0) + (next.totalUnits ?? 0),
		availableUnits: (base.availableUnits ?? 0) + (next.availableUnits ?? 0),
		sizeOnDiskBytes: (base.sizeOnDiskBytes ?? 0) + (next.sizeOnDiskBytes ?? 0),
		fetchedAt: Math.max(base.fetchedAt ?? 0, next.fetchedAt ?? 0)
	};
}

function mergeSubtitles(base: SubtitlesLibrary | null, next: SubtitlesLibrary): SubtitlesLibrary {
	if (!base) return next;
	const languages = [...base.languages];
	for (const row of next.languages) {
		const existing = languages.find((l) => l.code2 === row.code2);
		if (existing) {
			existing.required += row.required;
			existing.missing += row.missing;
			existing.coveragePct =
				existing.required > 0
					? Math.round(((existing.required - existing.missing) / existing.required) * 1000) / 10
					: null;
		} else languages.push(row);
	}
	return {
		...next,
		episodeGaps: base.episodeGaps + next.episodeGaps,
		movieGaps: base.movieGaps + next.movieGaps,
		totalGaps: base.totalGaps + next.totalGaps,
		languages,
		worst: [...base.worst, ...next.worst].slice(0, 50),
		fetchedAt: Math.max(base.fetchedAt ?? 0, next.fetchedAt ?? 0)
	};
}

function groupQueues(
	items: {
		type: string;
		integrationId: string;
		status: string;
		trackedDownloadStatus: string;
		trackedDownloadState: string;
	}[]
): { groups: QueueGroup[]; issues: QueueIssue[] } {
	const byKind = new Map<QueueGroup['kind'], QueueGroup>();
	const issues: QueueIssue[] = [];
	for (const item of items) {
		const kind =
			item.trackedDownloadStatus === 'failure'
				? 'failed'
				: item.trackedDownloadStatus === 'warning'
					? 'warning'
					: /queued|delay|pending/i.test(item.status)
						? 'queued'
						: /import/i.test(item.status)
							? 'importing'
							: 'downloading';
		let group = byKind.get(kind);
		if (!group) {
			group = { kind, count: 0, sources: [] };
			byKind.set(kind, group);
		}
		group.count += 1;
		const source = group.sources.find((s) => s.integrationId === item.integrationId);
		if (source) source.count += 1;
		else group.sources.push({ type: item.type, integrationId: item.integrationId, count: 1 });

		if (item.trackedDownloadStatus === 'failure') {
			issues.push({
				integrationId: item.integrationId,
				type: item.type,
				title: 'Import failed',
				reason: 'Download completed but the import was rejected by the library.',
				severity: 'issue'
			});
		} else if (item.trackedDownloadStatus === 'warning') {
			issues.push({
				integrationId: item.integrationId,
				type: item.type,
				title: 'Download needs attention',
				reason: 'The download client reports a problem with this item.',
				severity: 'attention'
			});
		}
	}
	return { groups: [...byKind.values()], issues: issues.slice(0, 50) };
}

// ---------------------------------------------------------------------------
// Snapshots (§16–§18)
// ---------------------------------------------------------------------------

/** Capture one snapshot row per available kind. Hourly cadence. */
export function captureLibrarySnapshot(now = Date.now()): { captured: string[] } {
	const view = getLibraryView();
	const db = getDb();
	const captured: string[] = [];
	const insert = db.prepare(
		'INSERT INTO media_snapshots (at, kind, missing, upgrades, total, available, gaps) VALUES (?, ?, ?, ?, ?, ?, ?)'
	);
	const last = db.prepare('SELECT at FROM media_snapshots WHERE kind = ? ORDER BY at DESC LIMIT 1');
	if (view.tv && view.availability.tv === 'available') {
		const prev = (last.get('tv') as { at: number } | undefined)?.at ?? 0;
		if (now - prev >= 55 * 60_000) {
			insert.run(
				now,
				'tv',
				view.tv.monitoredMissing,
				view.tv.upgradesAvailable,
				view.tv.totalUnits,
				view.tv.availableUnits,
				null
			);
			captured.push('tv');
		}
	}
	if (view.movies && view.availability.movies === 'available') {
		const prev = (last.get('movies') as { at: number } | undefined)?.at ?? 0;
		if (now - prev >= 55 * 60_000) {
			insert.run(
				now,
				'movies',
				view.movies.monitoredMissing,
				view.movies.upgradesAvailable,
				view.movies.totalUnits,
				view.movies.availableUnits,
				null
			);
			captured.push('movies');
		}
	}
	if (view.subtitles && view.availability.subtitles === 'available') {
		const prev = (last.get('subtitles') as { at: number } | undefined)?.at ?? 0;
		if (now - prev >= 55 * 60_000) {
			insert.run(
				now,
				'subtitles',
				view.subtitles.totalGaps,
				0,
				null,
				null,
				view.subtitles.totalGaps
			);
			captured.push('subtitles');
		}
	}
	return { captured };
}

let snapshotTimer: ReturnType<typeof setInterval> | null = null;

/** Hourly snapshot capture (idempotent). */
export function startLibrarySnapshots(): void {
	if (snapshotTimer) return;
	snapshotTimer = setInterval(() => {
		try {
			const { captured } = captureLibrarySnapshot();
			if (captured.length > 0)
				console.log(`[dumbscope] library snapshot captured: ${captured.join(', ')}`);
		} catch (err) {
			console.warn(
				'[dumbscope] library snapshot failed:',
				err instanceof Error ? err.message : err
			);
		}
	}, 60 * 60_000);
}

/** Trend points for one kind over a window, downsampled for charting. */
export function libraryTrend(
	kind: 'tv' | 'movies' | 'subtitles',
	windowDays: 7 | 30 | 90
): { at: number; missing: number; upgrades: number; gaps: number | null }[] {
	const db = getDb();
	const rows = db
		.prepare(
			'SELECT at, missing, upgrades, gaps FROM media_snapshots WHERE kind = ? AND at > ? ORDER BY at ASC'
		)
		.all(kind, Date.now() - windowDays * 86_400_000) as {
		at: number;
		missing: number;
		upgrades: number;
		gaps: number | null;
	}[];
	// Downsample to at most ~90 points per chart.
	if (rows.length <= 90) return rows;
	const stride = Math.ceil(rows.length / 90);
	return rows.filter((_, i) => i % stride === 0);
}

export type { MissingItem, LibraryTotals };
