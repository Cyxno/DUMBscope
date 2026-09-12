/**
 * Unified library browse service (read-only, §1/§2). Everything reads the
 * integration manager's in-process caches — a browser request never touches
 * Sonarr/Radarr/Bazarr directly (§79). The only on-demand upstream fetches
 * are the lazy per-series episode/subtitle loads behind a TTL cache (§80),
 * bounded to one bulk request per series (§75, §172).
 */
import { getIntegrationCache, listIntegrationTypes } from '$lib/server/integrations/manager';
import { getApiKey, getIntegration } from '$lib/server/integrations/store';
import { ArrBaseClient } from '$lib/server/integrations/arr/base';
import { BazarrClient } from '$lib/server/integrations/bazarr';
import {
	normalizeHistoryEvent,
	normalizeSonarrEpisode,
	normalizeSubtitleState,
	queueIndexByEpisode,
	queueIndexByMovieId
} from './browse-normalize';
import type {
	BazarrBrowseCache,
	BrowseEpisode,
	BrowseHistoryEvent,
	BrowseMovie,
	BrowseSeries,
	BrowseSubtitleState
} from './browse-models';
import {
	filterSortMovies,
	filterSortSeries,
	movieListParams,
	pageOf,
	seriesListParams
} from './browse-filter';

export type Availability = 'available' | 'unconfigured' | 'unavailable' | 'stale';

/** How old the browse cache may be before the UI shows "stale" (§81). */
const STALE_WINDOW_MS = 15 * 60_000;
/** Lazy per-series fetches: TTL + entry bound (§80, §173). */
const EPISODES_TTL_MS = 10 * 60_000;
const BAZARR_EPISODES_TTL_MS = 15 * 60_000;
const MAX_LAZY_ENTRIES = 60;
/** Bounded recent history per item (§116). */
const HISTORY_LIMIT = 10;

interface QueueCache {
	queue?: {
		total: number;
		items: {
			episodeId: number | null;
			movieId: number | null;
			status: string;
			trackedDownloadState: string;
			progress: number;
		}[];
	};
}

interface WantedCache {
	wanted?: { missing: number; cutoffUnmet: number };
}

interface LibraryIntelligenceCache {
	library?: {
		tv?: { completionPct: number | null; monitoredMissing: number };
		movies?: { completionPct: number | null; monitoredMissing: number };
	};
}

interface UpcomingCache {
	upcoming?: {
		title: string;
		episodeTitle: string | null;
		seriesId: number | null;
		seasonNumber: number | null;
		episodeNumber: number | null;
		airDateUtc: number | null;
		hasFile: boolean;
	}[];
}

interface BrowseInstance<T> {
	integrationId: string;
	items: T[];
	fetchedAt: number;
}

interface SonarrBrowseCacheShape {
	series: BrowseSeries[];
	fetchedAt: number;
}
interface RadarrBrowseCacheShape {
	movies: BrowseMovie[];
	fetchedAt: number;
}

function enabledOf(type: string): { id: string }[] {
	return listIntegrationTypes().filter((i) => i.type === type && i.enabled);
}

function availabilityOf(configured: number, fetchedAt: number | null): Availability {
	if (configured === 0) return 'unconfigured';
	if (fetchedAt === null) return 'unavailable';
	return Date.now() - fetchedAt > STALE_WINDOW_MS ? 'stale' : 'available';
}

function integrationUrl(id: string): string {
	return getIntegration(id)?.url?.replace(/\/+$/, '') ?? '';
}

// ---------------------------------------------------------------------------
// Inventory readers
// ---------------------------------------------------------------------------

function getSonarrBrowse(): {
	instances: BrowseInstance<BrowseSeries>[];
	availability: Availability;
	fetchedAt: number | null;
} {
	const configured = enabledOf('sonarr');
	const instances: BrowseInstance<BrowseSeries>[] = [];
	let fetchedAt: number | null = null;
	for (const info of configured) {
		const cache = getIntegrationCache(info.id) as { browse?: SonarrBrowseCacheShape };
		const browse = cache.browse;
		if (!browse) continue;
		fetchedAt = Math.max(fetchedAt ?? 0, browse.fetchedAt);
		instances.push({ integrationId: info.id, items: browse.series, fetchedAt: browse.fetchedAt });
	}
	return { instances, availability: availabilityOf(configured.length, fetchedAt), fetchedAt };
}

function getRadarrBrowse(): {
	instances: BrowseInstance<BrowseMovie>[];
	availability: Availability;
	fetchedAt: number | null;
} {
	const configured = enabledOf('radarr');
	const instances: BrowseInstance<BrowseMovie>[] = [];
	let fetchedAt: number | null = null;
	for (const info of configured) {
		const cache = getIntegrationCache(info.id) as { browse?: RadarrBrowseCacheShape };
		const browse = cache.browse;
		if (!browse) continue;
		fetchedAt = Math.max(fetchedAt ?? 0, browse.fetchedAt);
		instances.push({ integrationId: info.id, items: browse.movies, fetchedAt: browse.fetchedAt });
	}
	return { instances, availability: availabilityOf(configured.length, fetchedAt), fetchedAt };
}

export function getBazarrBrowse(): { cache: BazarrBrowseCache | null; availability: Availability } {
	const configured = enabledOf('bazarr');
	if (configured.length === 0) return { cache: null, availability: 'unconfigured' };
	for (const info of configured) {
		const cache = getIntegrationCache(info.id) as { browse?: BazarrBrowseCache };
		if (cache.browse) {
			const fresh = Date.now() - cache.browse.fetchedAt <= STALE_WINDOW_MS;
			return { cache: cache.browse, availability: fresh ? 'available' : 'stale' };
		}
	}
	return { cache: null, availability: 'unavailable' };
}

function allSeries(): BrowseSeries[] {
	return getSonarrBrowse().instances.flatMap((i) => i.items);
}

function allMovies(): BrowseMovie[] {
	return getRadarrBrowse().instances.flatMap((i) => i.items);
}

/** Wanted-poller counts (exact upstream totals) for the headers (§5/§33). */
function wantedTotals(type: 'sonarr' | 'radarr'): { missing: number; cutoffUnmet: number } {
	let missing = 0;
	let cutoffUnmet = 0;
	for (const info of enabledOf(type)) {
		const cache = getIntegrationCache(info.id) as WantedCache;
		missing += cache.wanted?.missing ?? 0;
		cutoffUnmet += cache.wanted?.cutoffUnmet ?? 0;
	}
	return { missing, cutoffUnmet };
}

/** Library Intelligence numbers — reused so both views never disagree (§3). */
function intelligenceValue(
	type: 'sonarr' | 'radarr',
	field: 'completionPct' | 'monitoredMissing'
): number | null {
	for (const info of enabledOf(type)) {
		const cache = getIntegrationCache(info.id) as LibraryIntelligenceCache;
		const lib = type === 'sonarr' ? cache.library?.tv : cache.library?.movies;
		const value = lib?.[field];
		if (value != null) return value;
	}
	return null;
}

/** Active queue entries across all Arr instances (id-correlated, §115). */
function queueItems(): {
	episodeId: number | null;
	movieId: number | null;
	status: string;
	trackedDownloadState: string;
	progress: number;
}[] {
	const out: {
		episodeId: number | null;
		movieId: number | null;
		status: string;
		trackedDownloadState: string;
		progress: number;
	}[] = [];
	for (const info of [...enabledOf('sonarr'), ...enabledOf('radarr')]) {
		const cache = getIntegrationCache(info.id) as QueueCache;
		for (const item of cache.queue?.items ?? []) {
			out.push({
				episodeId: item.episodeId ?? null,
				movieId: item.movieId ?? null,
				status: item.status,
				trackedDownloadState: item.trackedDownloadState,
				progress: item.progress
			});
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// TV
// ---------------------------------------------------------------------------

export interface SeriesSummary {
	key: string;
	id: number;
	integrationId: string;
	title: string;
	year: number | null;
	status: BrowseSeries['status'];
	monitored: boolean;
	network: string | null;
	seasonsCount: number;
	hasSpecials: boolean;
	missingCount: number;
	episodeFutureCount: number;
	completionPct: number | null;
	qualityProfile: string | null;
	posterVersion: string | null;
	addedAt: number | null;
}

export function seriesSummary(s: BrowseSeries): SeriesSummary {
	return {
		key: s.key,
		id: s.id,
		integrationId: s.integrationId,
		title: s.title,
		year: s.year,
		status: s.status,
		monitored: s.monitored,
		network: s.network,
		seasonsCount: s.seasons.filter((season) => season.seasonNumber > 0).length,
		hasSpecials: s.seasons.some((season) => season.seasonNumber === 0),
		missingCount: s.missingCount,
		episodeFutureCount: s.episodeFutureCount,
		completionPct: s.completionPct,
		qualityProfile: s.qualityProfile,
		posterVersion: s.posterVersion,
		addedAt: s.addedAt
	};
}

export interface UpcomingEntry {
	key: string;
	seriesTitle: string;
	episodeTitle: string | null;
	seasonNumber: number | null;
	episodeNumber: number | null;
	at: number;
	/** UI grouping bucket (§32): today/tomorrow/week/later. */
	bucket: 'today' | 'tomorrow' | 'week' | 'later';
}

/** Upcoming episodes grouped into Today/Tomorrow/This week/Later (§32). */
export function tvUpcoming(now = Date.now()): UpcomingEntry[] {
	const entries: {
		title: string;
		episodeTitle: string | null;
		seriesId: number | null;
		seasonNumber: number | null;
		episodeNumber: number | null;
		at: number;
	}[] = [];
	for (const info of enabledOf('sonarr')) {
		const cache = getIntegrationCache(info.id) as UpcomingCache;
		for (const item of cache.upcoming ?? []) {
			if (typeof item.airDateUtc !== 'number') continue;
			entries.push({
				title: item.title,
				episodeTitle: item.episodeTitle,
				seriesId: item.seriesId,
				seasonNumber: item.seasonNumber,
				episodeNumber: item.episodeNumber,
				at: item.airDateUtc
			});
		}
	}
	entries.sort((a, b) => a.at - b.at);
	const dayStart = (ts: number) => {
		const d = new Date(ts);
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	};
	const todayStart = dayStart(now);
	const tomorrowStart = todayStart + 86_400_000;
	const weekEnd = todayStart + 7 * 86_400_000;
	return entries.slice(0, 30).map((e) => {
		const bucket: UpcomingEntry['bucket'] =
			e.at < tomorrowStart
				? 'today'
				: e.at < dayStart(tomorrowStart) + 86_400_000
					? 'tomorrow'
					: e.at < weekEnd
						? 'week'
						: 'later';
		return {
			key: e.seriesId !== null ? `sonarr-series-${e.seriesId}` : '',
			seriesTitle: e.title,
			episodeTitle: e.episodeTitle,
			seasonNumber: e.seasonNumber,
			episodeNumber: e.episodeNumber,
			at: e.at,
			bucket
		};
	});
}

export interface TvListResponse {
	availability: Availability;
	fetchedAt: number | null;
	header: {
		seriesTotal: number;
		seriesMonitored: number;
		completionPct: number | null;
		missing: number | null;
		upgrades: number;
	};
	items: SeriesSummary[];
	total: number;
	limit: number;
	offset: number;
	upcoming: UpcomingEntry[];
}

export function tvList(url: URL): TvListResponse {
	const browse = getSonarrBrowse();
	const items = allSeries();
	const params = seriesListParams(url);
	const filtered = filterSortSeries(items, params.filter, params.sort, params.q);
	const page = pageOf(filtered, params.limit, params.offset);
	const wanted = wantedTotals('sonarr');
	return {
		availability: browse.availability,
		fetchedAt: browse.fetchedAt,
		header: {
			seriesTotal: items.length,
			seriesMonitored: items.filter((s) => s.monitored).length,
			completionPct: intelligenceValue('sonarr', 'completionPct'),
			missing: intelligenceValue('sonarr', 'monitoredMissing'),
			upgrades: wanted.cutoffUnmet
		},
		items: page.items.map(seriesSummary),
		total: page.total,
		limit: params.limit,
		offset: params.offset,
		upcoming: tvUpcoming()
	};
}

export function findSeries(
	key: string
): { series: BrowseSeries; availability: Availability } | null {
	const browse = getSonarrBrowse();
	for (const instance of browse.instances) {
		const hit = instance.items.find((s) => s.key === key);
		if (hit) return { series: hit, availability: browse.availability };
	}
	return null;
}

export interface SeriesDetailResponse {
	availability: Availability;
	series: BrowseSeries;
	overview: {
		monitored: boolean;
		episodesFiled: number;
		episodesAired: number;
		episodesFuture: number;
		missing: number;
		qualityProfile: string | null;
	};
}

export function tvDetail(key: string): SeriesDetailResponse | null {
	const found = findSeries(key);
	if (!found) return null;
	const { series, availability } = found;
	return {
		availability,
		series,
		overview: {
			monitored: series.monitored,
			episodesFiled: series.episodeFileCount,
			episodesAired: series.episodeCount,
			episodesFuture: series.episodeFutureCount,
			missing: series.missingCount,
			qualityProfile: series.qualityProfile
		}
	};
}

// ---------------------------------------------------------------------------
// Lazy episodes (per series) + queue/subtitle overlays
// ---------------------------------------------------------------------------

export interface SeasonEpisodes {
	seasonNumber: number;
	monitored: boolean;
	fileCount: number;
	airedCount: number;
	totalCount: number;
	episodes: BrowseEpisode[];
}

const lazyCaches = new Map<string, Map<string, { value: unknown; expiresAt: number }>>();

function lazyCache(kind: string): Map<string, { value: unknown; expiresAt: number }> {
	let cache = lazyCaches.get(kind);
	if (!cache) {
		cache = new Map();
		lazyCaches.set(kind, cache);
	}
	return cache;
}

function lazyGet<T>(
	cache: Map<string, { value: unknown; expiresAt: number }>,
	key: string
): T | null {
	const hit = cache.get(key);
	if (!hit) return null;
	if (hit.expiresAt <= Date.now()) {
		cache.delete(key);
		return null;
	}
	return hit.value as T;
}

function lazySet(
	cache: Map<string, { value: unknown; expiresAt: number }>,
	key: string,
	value: unknown,
	ttlMs: number
): void {
	// Simple bound: drop the soonest-expiring entry when over capacity (§173).
	if (cache.size >= MAX_LAZY_ENTRIES) {
		let oldestKey: string | null = null;
		let oldestAt = Number.MAX_SAFE_INTEGER;
		for (const [k, v] of cache) {
			if (v.expiresAt < oldestAt) {
				oldestAt = v.expiresAt;
				oldestKey = k;
			}
		}
		if (oldestKey) cache.delete(oldestKey);
	}
	cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function episodesWithOverlays(
	series: BrowseSeries,
	rawEpisodes: Record<string, unknown>[],
	bazarrEpisodes: Record<string, unknown>[] | null
): SeasonEpisodes[] {
	const queueIdx = queueIndexByEpisode(queueItems());
	const subtitleByEpisode = new Map<number, BrowseSubtitleState>();
	if (bazarrEpisodes) {
		for (const raw of bazarrEpisodes) {
			const id = typeof raw.sonarrEpisodeId === 'number' ? raw.sonarrEpisodeId : null;
			if (id === null) continue;
			subtitleByEpisode.set(id, normalizeSubtitleState(raw.subtitles, raw.missing_subtitles));
		}
	}
	const bySeason = new Map<number, SeasonEpisodes>();
	for (const raw of rawEpisodes) {
		const episode = normalizeSonarrEpisode(raw, series.integrationId, queueIdx);
		episode.subtitles = subtitleByEpisode.get(episode.id) ?? null;
		let season = bySeason.get(episode.seasonNumber);
		if (!season) {
			const upstream = series.seasons.find((s) => s.seasonNumber === episode.seasonNumber);
			season = {
				seasonNumber: episode.seasonNumber,
				monitored: upstream?.monitored ?? true,
				fileCount: upstream?.fileCount ?? 0,
				airedCount: upstream?.airedCount ?? 0,
				totalCount: upstream?.totalCount ?? 0,
				episodes: []
			};
			bySeason.set(episode.seasonNumber, season);
		}
		season.episodes.push(episode);
	}
	const seasons = [...bySeason.values()].sort((a, b) => a.seasonNumber - b.seasonNumber);
	for (const season of seasons) {
		season.episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
	}
	return seasons;
}

/** First enabled Bazarr instance, or null when unconfigured. */
function bazarrClient(): BazarrClient | null {
	const instance = enabledOf('bazarr')[0];
	if (!instance) return null;
	const apiKey = getApiKey(instance.id);
	if (!apiKey) return null;
	return new BazarrClient(integrationUrl(instance.id), apiKey);
}

/**
 * Bazarr episodes for one Sonarr series, behind the lazy TTL cache.
 * Returns null when Bazarr is not configured.
 */
async function loadBazarrEpisodes(
	sonarrSeriesId: number
): Promise<Record<string, unknown>[] | null> {
	const client = bazarrClient();
	if (!client) return null;
	const cache = lazyCache('bazarr-episodes');
	const instance = enabledOf('bazarr')[0]!;
	const cacheKey = `${instance.id}:${sonarrSeriesId}`;
	const hit = lazyGet<Record<string, unknown>[]>(cache, cacheKey);
	if (hit) return hit;
	const episodes = await client.episodesBySeries(sonarrSeriesId);
	lazySet(cache, cacheKey, episodes, BAZARR_EPISODES_TTL_MS);
	return episodes;
}

export interface TvEpisodesResponse {
	key: string;
	title: string;
	seasons: SeasonEpisodes[];
	upgradeCount: number;
	missingCount: number;
	/** Languages configured in Bazarr — subtitle chips show these first (§24). */
	enabledLanguages: { code2: string; name: string }[];
	/** Epoch ms of the underlying Sonarr fetch. */
	fetchedAt: number;
}

/**
 * Lazy per-series episodes (§80): one Sonarr request + (when Bazarr is
 * configured) one Bazarr request, both behind TTL caches. Never called for
 * list views (§75).
 */
export async function tvEpisodes(key: string): Promise<TvEpisodesResponse | null> {
	const found = findSeries(key);
	if (!found) return null;
	const { series } = found;
	const apiKey = getApiKey(series.integrationId);
	if (!apiKey) return null;

	const cache = lazyCache('sonarr-episodes');
	const cacheKey = `${series.integrationId}:${series.id}`;
	let seasons = lazyGet<SeasonEpisodes[]>(cache, cacheKey);
	if (!seasons) {
		const client = new ArrBaseClient(integrationUrl(series.integrationId), apiKey);
		const rawEpisodes = await client.episodesBySeries(series.id);
		let bazarrEpisodes: Record<string, unknown>[] | null = null;
		try {
			bazarrEpisodes = await loadBazarrEpisodes(series.id);
		} catch {
			// Subtitle detail is additive — TV browsing continues without it (§82).
			bazarrEpisodes = null;
		}
		seasons = episodesWithOverlays(series, rawEpisodes, bazarrEpisodes);
		lazySet(cache, cacheKey, seasons, EPISODES_TTL_MS);
	}

	let upgradeCount = 0;
	let missingCount = 0;
	for (const season of seasons) {
		for (const episode of season.episodes) {
			if (episode.upgradeAvailable) upgradeCount += 1;
			if (episode.state === 'missing') missingCount += 1;
		}
	}

	return {
		key: series.key,
		title: series.title,
		seasons,
		upgradeCount,
		missingCount,
		enabledLanguages: getBazarrBrowse().cache?.enabledLanguages ?? [],
		fetchedAt: getSonarrBrowse().fetchedAt ?? Date.now()
	};
}

// ---------------------------------------------------------------------------
// Movies
// ---------------------------------------------------------------------------

export interface MovieSummary {
	key: string;
	id: number;
	integrationId: string;
	title: string;
	year: number | null;
	monitored: boolean;
	isAvailable: boolean;
	hasFile: boolean;
	missing: boolean;
	upgradeAvailable: boolean;
	quality: string | null;
	qualityResolution: number | null;
	sizeBytes: number | null;
	releaseDate: number | null;
	posterVersion: string | null;
	addedAt: number | null;
}

export function movieSummary(m: BrowseMovie): MovieSummary {
	return {
		key: m.key,
		id: m.id,
		integrationId: m.integrationId,
		title: m.title,
		year: m.year,
		monitored: m.monitored,
		isAvailable: m.isAvailable,
		hasFile: m.hasFile,
		missing: m.isAvailable && !m.hasFile,
		upgradeAvailable: m.upgradeAvailable,
		quality: m.quality,
		qualityResolution: m.qualityResolution,
		sizeBytes: m.sizeBytes,
		releaseDate: m.digitalRelease ?? m.inCinemas ?? m.physicalRelease,
		posterVersion: m.posterVersion,
		addedAt: m.addedAt
	};
}

export interface MoviesListResponse {
	availability: Availability;
	fetchedAt: number | null;
	header: {
		moviesTotal: number;
		monitored: number;
		completionPct: number | null;
		missing: number | null;
		upgrades: number;
	};
	items: MovieSummary[];
	total: number;
	limit: number;
	offset: number;
}

export function moviesList(url: URL): MoviesListResponse {
	const browse = getRadarrBrowse();
	const items = allMovies();
	const params = movieListParams(url);
	const filtered = filterSortMovies(items, params.filter, params.sort, params.q);
	const page = pageOf(filtered, params.limit, params.offset);
	const wanted = wantedTotals('radarr');
	return {
		availability: browse.availability,
		fetchedAt: browse.fetchedAt,
		header: {
			moviesTotal: items.length,
			monitored: items.filter((m) => m.monitored).length,
			completionPct: intelligenceValue('radarr', 'completionPct'),
			missing: intelligenceValue('radarr', 'monitoredMissing'),
			upgrades: wanted.cutoffUnmet
		},
		items: page.items.map(movieSummary),
		total: page.total,
		limit: params.limit,
		offset: params.offset
	};
}

export interface MovieDetailResponse {
	availability: Availability;
	movie: BrowseMovie;
	queue: { state: 'downloading' | 'queued' | 'importing'; progress: number | null } | null;
	subtitles: {
		present: { code2: string; name: string }[];
		missing: { code2: string; name: string }[];
	} | null;
	profileName: string | null;
	history: BrowseHistoryEvent[];
	subtitleHistory: { at: string; description: string }[];
}

export async function movieDetail(key: string): Promise<MovieDetailResponse | null> {
	const browse = getRadarrBrowse();
	let movie: BrowseMovie | null = null;
	for (const instance of browse.instances) {
		const hit = instance.items.find((m) => m.key === key);
		if (hit) {
			movie = hit;
			break;
		}
	}
	if (!movie) return null;

	// Queue correlation by upstream movieId only (§115).
	const queueIdx = queueIndexByMovieId(queueItems());
	const queue = queueIdx.get(movie.id) ?? null;

	// Subtitle state from the Bazarr browse cache (moviesById, §62).
	const bazarr = getBazarrBrowse();
	let subtitles: MovieDetailResponse['subtitles'] = null;
	let profileName: string | null = null;
	let subtitleHistory: MovieDetailResponse['subtitleHistory'] = [];
	if (bazarr.cache && bazarr.cache.moviesById[movie.id]) {
		const state = bazarr.cache.moviesById[movie.id]!;
		const name = (code: string) => bazarr.cache?.languageNames[code] ?? code.toUpperCase();
		subtitles = {
			present: state.present.map((code) => ({ code2: code, name: name(code) })),
			missing: state.missing.map((code) => ({ code2: code, name: name(code) }))
		};
		const profile = bazarr.cache.profiles.find((p) => p.id === state.profileId);
		profileName = profile?.name ?? null;
		try {
			const client = bazarrClient();
			const events = (await client?.moviesHistory(20)) ?? [];
			subtitleHistory = events
				.filter((e) => e.radarrId === movie!.id)
				.slice(0, 5)
				.map((e) => ({
					at: typeof e.timestamp === 'string' ? e.timestamp : '',
					description: typeof e.description === 'string' ? e.description : 'Subtitle updated'
				}));
		} catch {
			// Subtitle history is additive detail (§82).
		}
	}

	// Bounded history (§116), normalized labels (§117).
	const apiKey = getApiKey(movie.integrationId);
	let history: BrowseHistoryEvent[] = [];
	if (apiKey) {
		try {
			const client = new ArrBaseClient(integrationUrl(movie.integrationId), apiKey);
			const raw = await client.history(20, { movieId: String(movie.id) });
			history = raw
				.map(normalizeHistoryEvent)
				.filter((e): e is BrowseHistoryEvent => e !== null)
				.slice(0, HISTORY_LIMIT);
		} catch {
			// Detail stays useful without history (§82).
		}
	}

	return {
		availability: browse.availability,
		movie,
		queue,
		subtitles,
		profileName,
		history,
		subtitleHistory
	};
}

// ---------------------------------------------------------------------------
// Subtitles browser
// ---------------------------------------------------------------------------

export interface SubtitlesResponse {
	availability: Availability;
	header: {
		episodeGaps: number | null;
		movieGaps: number | null;
		seriesWithGaps: number;
		moviesWithGaps: number;
	};
	enabledLanguages: { code2: string; name: string }[];
	profiles: { id: number; name: string; cutoff: string | null; languages: string[] }[];
	languages: { code2: string; name: string; movieGaps: number }[];
	movies: {
		key: string;
		title: string;
		year: number | null;
		present: { code2: string; name: string }[];
		missing: { code2: string; name: string }[];
	}[];
	series: { key: string; title: string; episodeGaps: number }[];
	totalMovies: number;
	totalSeries: number;
}

export function subtitlesBrowser(url: URL): SubtitlesResponse {
	const bazarr = getBazarrBrowse();
	const empty: SubtitlesResponse = {
		availability: bazarr.availability,
		header: { episodeGaps: null, movieGaps: null, seriesWithGaps: 0, moviesWithGaps: 0 },
		enabledLanguages: [],
		profiles: [],
		languages: [],
		movies: [],
		series: [],
		totalMovies: 0,
		totalSeries: 0
	};
	if (!bazarr.cache) return empty;
	const cache = bazarr.cache;
	const name = (code: string) => cache.languageNames[code] ?? code.toUpperCase();

	// Movie rows joined with the Radarr inventory for year (+ deep links).
	const movieRows: SubtitlesResponse['movies'] = [];
	for (const movie of allMovies()) {
		const state = cache.moviesById[movie.id];
		if (!state) continue;
		movieRows.push({
			key: movie.key,
			title: movie.title,
			year: movie.year,
			present: state.present.map((code) => ({ code2: code, name: name(code) })),
			missing: state.missing.map((code) => ({ code2: code, name: name(code) }))
		});
	}

	const seriesRows: SubtitlesResponse['series'] = [];
	for (const series of allSeries()) {
		const state = cache.seriesById[series.id];
		if (!state) continue;
		seriesRows.push({
			key: series.key,
			title: series.title,
			episodeGaps: state.episodeGaps
		});
	}

	// Per-language movie gaps; episode-level per-language counts would need the
	// per-series drill-down, so they are omitted rather than guessed (§50).
	const languageGaps = new Map<string, number>();
	for (const row of movieRows) {
		for (const lang of row.missing) {
			languageGaps.set(lang.code2, (languageGaps.get(lang.code2) ?? 0) + 1);
		}
	}

	const filterRaw = url.searchParams.get('filter') ?? 'has-gaps';
	const filter = ['has-gaps', 'complete', 'all'].includes(filterRaw) ? filterRaw : 'has-gaps';
	let movieList = movieRows;
	if (filter === 'has-gaps') movieList = movieList.filter((m) => m.missing.length > 0);
	if (filter === 'complete') movieList = movieList.filter((m) => m.missing.length === 0);
	const langParam = (url.searchParams.get('lang') ?? '').trim().toLowerCase().slice(0, 8);
	if (langParam) {
		movieList = movieList.filter(
			(m) =>
				m.missing.some((l) => l.code2 === langParam) || m.present.some((l) => l.code2 === langParam)
		);
	}
	const limitRaw = Number(url.searchParams.get('limit') ?? 50);
	const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.floor(limitRaw))) : 50;
	const offsetRaw = Number(url.searchParams.get('offset') ?? 0);
	const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;

	let seriesList = seriesRows;
	if (filter === 'has-gaps') seriesList = seriesList.filter((s) => s.episodeGaps > 0);
	if (filter === 'complete') seriesList = seriesList.filter((s) => s.episodeGaps === 0);
	seriesList = seriesList.sort(
		(a, b) => b.episodeGaps - a.episodeGaps || a.title.localeCompare(b.title)
	);
	movieList = movieList.sort(
		(a, b) => b.missing.length - a.missing.length || a.title.localeCompare(b.title)
	);

	return {
		availability: bazarr.availability,
		header: {
			episodeGaps: seriesRows.reduce((sum, s) => sum + s.episodeGaps, 0),
			movieGaps: movieRows.reduce((sum, m) => sum + m.missing.length, 0),
			seriesWithGaps: seriesRows.filter((s) => s.episodeGaps > 0).length,
			moviesWithGaps: movieRows.filter((m) => m.missing.length > 0).length
		},
		enabledLanguages: cache.enabledLanguages,
		profiles: cache.profiles.map((p) => ({
			id: p.id,
			name: p.name,
			cutoff: p.cutoff ? name(p.cutoff) : null,
			languages: p.languages.map(name)
		})),
		languages: [...languageGaps.entries()]
			.map(([code2, gaps]) => ({ code2, name: name(code2), movieGaps: gaps }))
			.sort((a, b) => b.movieGaps - a.movieGaps || a.name.localeCompare(b.name)),
		movies: movieList.slice(offset, offset + limit),
		series: seriesList.slice(offset, offset + limit),
		totalMovies: movieList.length,
		totalSeries: seriesList.length
	};
}

/** Per-episode subtitle states for one series (§48/§49). */
export interface SubtitlesSeriesResponse {
	availability: Availability;
	seriesTitle: string;
	enabledLanguages: { code2: string; name: string }[];
	episodes: {
		sonarrEpisodeId: number;
		seasonNumber: number;
		episodeNumber: number;
		title: string | null;
		present: { code2: string; name: string }[];
		missing: { code2: string; name: string }[];
	}[];
}

export async function subtitlesSeries(key: string): Promise<SubtitlesSeriesResponse | null> {
	const found = findSeries(key);
	if (!found) return null;
	const bazarr = getBazarrBrowse();
	if (!bazarr.cache) {
		return {
			availability: bazarr.availability,
			seriesTitle: found.series.title,
			enabledLanguages: [],
			episodes: []
		};
	}
	const raw = (await loadBazarrEpisodes(found.series.id)) ?? [];
	const cache = bazarr.cache;
	const name = (code: string) => cache.languageNames[code] ?? code.toUpperCase();
	const episodes = raw
		.map((e) => {
			const id = typeof e.sonarrEpisodeId === 'number' ? e.sonarrEpisodeId : null;
			if (id === null) return null;
			const state = normalizeSubtitleState(e.subtitles, e.missing_subtitles);
			return {
				sonarrEpisodeId: id,
				seasonNumber: typeof e.season === 'number' ? e.season : 0,
				episodeNumber: typeof e.episode === 'number' ? e.episode : 0,
				title: typeof e.title === 'string' ? e.title : null,
				present: dedupeLanguages(
					state.present.map((p) => ({ code2: p.code2, name: name(p.code2) }))
				),
				missing: dedupeLanguages(
					state.missing.map((p) => ({ code2: p.code2, name: name(p.code2) }))
				)
			};
		})
		.filter((e): e is NonNullable<typeof e> => e !== null)
		.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
	return {
		availability: bazarr.availability,
		seriesTitle: found.series.title,
		enabledLanguages: cache.enabledLanguages,
		episodes
	};
}

function dedupeLanguages(
	list: { code2: string; name: string }[]
): { code2: string; name: string }[] {
	const seen = new Set<string>();
	return list.filter((l) => {
		if (seen.has(l.code2)) return false;
		seen.add(l.code2);
		return true;
	});
}

// ---------------------------------------------------------------------------
// Poster lookup (§63): known item ids only — never an open proxy.
// ---------------------------------------------------------------------------

export interface PosterInfo {
	integrationId: string;
	baseUrl: string;
	apiKey: string;
	/** Path under the integration base URL. */
	path: string;
	/** MediaCover lastWrite — ETag seed for cheap revalidation (§64). */
	version: string | null;
}

export function posterInfo(key: string): PosterInfo | null {
	const match = /^(sonarr-series|radarr-movie)-(\d+)$/.exec(key);
	if (!match) return null;
	const id = match[2]!;
	const isSeries = match[1] === 'sonarr-series';
	const browse = isSeries ? getSonarrBrowse() : getRadarrBrowse();
	for (const instance of browse.instances) {
		const hit = instance.items.find((s) => s.key === key);
		if (!hit) continue;
		const apiKey = getApiKey(instance.integrationId);
		if (!apiKey) return null;
		return {
			integrationId: instance.integrationId,
			baseUrl: integrationUrl(instance.integrationId),
			apiKey,
			path: `/api/v3/MediaCover/${id}/poster.jpg`,
			version: hit.posterVersion
		};
	}
	return null;
}
