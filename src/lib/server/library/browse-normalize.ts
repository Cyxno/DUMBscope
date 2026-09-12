/**
 * Pure upstream→browse normalizers (§54/§55). No I/O, no state — fully
 * unit-testable. Every field maps from the structured upstream object; no
 * string parsing where structured data exists (§20). Missing/available
 * semantics come straight from Sonarr/Radarr/Bazarr — never derived
 * heuristically (§112/§113/§114/§189).
 */
import type {
	BrowseEpisode,
	EpisodeState,
	BrowseHistoryEvent,
	BrowseLanguageProfile,
	BrowseMovie,
	BrowseSeason,
	BrowseSeries,
	BrowseSubtitleFile,
	BrowseSubtitleState,
	MovieStatus,
	SeriesStatus
} from './browse-models';

function toEpoch(value: unknown): number | null {
	if (typeof value !== 'string' || value.length === 0) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

function str(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function arr<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

/** "WEBDL-2160p" → { name, resolution } from Sonarr/Radarr's quality object. */
export function qualityLabel(quality: unknown): { name: string | null; resolution: number | null } {
	if (quality === null || typeof quality !== 'object') return { name: null, resolution: null };
	const q = quality as { quality?: { name?: unknown; resolution?: unknown } };
	const name = str(q.quality?.name);
	const resolution = num(q.quality?.resolution);
	return { name, resolution };
}

export function normalizeSeriesStatus(raw: unknown): SeriesStatus {
	const value = str(raw) ?? 'continuing';
	if (value === 'ended') return 'ended';
	if (value === 'upcoming') return 'upcoming';
	return 'continuing';
}

export function normalizeMovieStatus(raw: unknown): MovieStatus {
	const value = str(raw);
	switch (value) {
		case 'released':
			return 'released';
		case 'inCinemas':
			return 'inCinemas';
		case 'announced':
			return 'announced';
		case 'deleted':
			return 'deleted';
		default:
			return 'tba';
	}
}

function posterVersionOf(images: unknown): string | null {
	for (const image of arr<{ coverType?: unknown; url?: unknown }>(images)) {
		if (image.coverType === 'poster' && typeof image.url === 'string') {
			const lastWrite = /[?&]lastWrite=(\d+)/.exec(image.url);
			return lastWrite?.[1] ?? image.url;
		}
	}
	return null;
}

interface SonarrSeasonStatistics {
	episodeFileCount?: unknown;
	episodeCount?: unknown;
	totalEpisodeCount?: unknown;
	sizeOnDisk?: unknown;
}

/** Sonarr `/api/v3/series` record → BrowseSeries (+ seasons). */
export function normalizeSonarrSeries(
	raw: Record<string, unknown>,
	integrationId: string,
	profileNames: Map<number, string>,
	fetchedAt = Date.now()
): BrowseSeries {
	const statistics = (raw.statistics ?? {}) as Record<string, unknown>;
	const seasonsRaw = arr<Record<string, unknown>>(raw.seasons);
	const seasons: BrowseSeason[] = seasonsRaw.map((s) => {
		const stats = (s.statistics ?? {}) as SonarrSeasonStatistics;
		return {
			seasonNumber: num(s.seasonNumber) ?? 0,
			monitored: s.monitored === true,
			fileCount: num(stats.episodeFileCount) ?? 0,
			airedCount: num(stats.episodeCount) ?? 0,
			totalCount: num(stats.totalEpisodeCount) ?? 0,
			sizeOnDiskBytes: num(stats.sizeOnDisk) ?? 0
		};
	});
	const id = num(raw.id) ?? 0;
	const episodeCount = num(statistics.episodeCount) ?? 0;
	const episodeFileCount = num(statistics.episodeFileCount) ?? 0;
	const totalEpisodeCount = num(statistics.totalEpisodeCount) ?? episodeCount;
	const profileId = num(raw.qualityProfileId);
	return {
		key: `sonarr-series-${id}`,
		source: 'sonarr',
		integrationId,
		id,
		title: str(raw.title) ?? `Series ${id}`,
		sortTitle: str(raw.sortTitle) ?? str(raw.title) ?? `Series ${id}`,
		year: num(raw.year),
		status: normalizeSeriesStatus(raw.status),
		monitored: raw.monitored === true,
		network: str(raw.network),
		runtime: num(raw.runtime),
		genres: arr<string>(raw.genres),
		seriesType: str(raw.seriesType) ?? 'standard',
		qualityProfile: (profileId !== null && profileNames.get(profileId)) || null,
		seasons,
		episodeFileCount,
		episodeCount,
		episodeFutureCount: Math.max(0, totalEpisodeCount - episodeCount),
		missingCount: Math.max(0, episodeCount - episodeFileCount),
		completionPct: num(statistics.percentOfEpisodes),
		sizeOnDiskBytes: num(statistics.sizeOnDisk) ?? 0,
		addedAt: toEpoch(raw.added),
		path: str(raw.path),
		posterVersion: posterVersionOf(raw.images),
		fetchedAt
	};
}

/** Radarr `/api/v3/movie` record → BrowseMovie (file embedded). */
export function normalizeRadarrMovie(
	raw: Record<string, unknown>,
	integrationId: string,
	profileNames: Map<number, string>,
	fetchedAt = Date.now()
): BrowseMovie {
	const file = (raw.movieFile ?? null) as Record<string, unknown> | null;
	const quality = qualityLabel(file?.quality);
	const id = num(raw.id) ?? 0;
	const profileId = num(raw.qualityProfileId);
	return {
		key: `radarr-movie-${id}`,
		source: 'radarr',
		integrationId,
		id,
		title: str(raw.title) ?? `Movie ${id}`,
		sortTitle: str(raw.sortTitle) ?? str(raw.title) ?? `Movie ${id}`,
		year: num(raw.year),
		status: normalizeMovieStatus(raw.status),
		monitored: raw.monitored === true,
		isAvailable: raw.isAvailable !== false,
		hasFile: raw.hasFile === true,
		quality: quality.name,
		qualityResolution: quality.resolution,
		sizeBytes: num(file?.size),
		releaseGroup: str(file?.releaseGroup),
		dateAdded: toEpoch(file?.dateAdded),
		edition: str(file?.edition),
		languages: arr<{ name?: unknown }>(file?.languages)
			.map((l) => str(l.name))
			.filter((n): n is string => n !== null),
		customFormats: arr<{ name?: unknown }>(file?.customFormats)
			.map((f) => str(f.name))
			.filter((n): n is string => n !== null),
		upgradeAvailable: file?.qualityCutoffNotMet === true,
		qualityProfile: (profileId !== null && profileNames.get(profileId)) || null,
		runtime: num(raw.runtime),
		certification: str(raw.certification),
		studio: str(raw.studio),
		genres: arr<string>(raw.genres),
		collection: str((raw.collection as { title?: unknown } | undefined)?.title),
		digitalRelease: toEpoch(raw.digitalRelease),
		inCinemas: toEpoch(raw.inCinemas),
		physicalRelease: toEpoch(raw.physicalRelease),
		tmdbId: num(raw.tmdbId),
		imdbId: str(raw.imdbId),
		path: str(raw.path),
		posterVersion: posterVersionOf(raw.images),
		addedAt: toEpoch(raw.added),
		fetchedAt
	};
}

interface SonarrEpisodeFile {
	size?: unknown;
	quality?: unknown;
	releaseGroup?: unknown;
	dateAdded?: unknown;
	sceneName?: unknown;
	languages?: unknown;
	customFormats?: unknown;
	qualityCutoffNotMet?: unknown;
}

/**
 * Sonarr `/api/v3/episode?seriesId=X&includeEpisodeFile=true` record →
 * BrowseEpisode. `queueByEpisode` carries id-correlated queue state (§115);
 * `state` derives from upstream booleans + air date only.
 */
export function normalizeSonarrEpisode(
	raw: Record<string, unknown>,
	integrationId: string,
	queueByEpisode: Map<number, NonNullable<BrowseEpisode['queue']>>,
	now = Date.now()
): BrowseEpisode {
	const file = (raw.episodeFile ?? null) as SonarrEpisodeFile | null;
	const quality = qualityLabel(file?.quality);
	const id = num(raw.id) ?? 0;
	const airDateUtc = toEpoch(raw.airDateUtc);
	const monitored = raw.monitored !== false;
	const hasFile = raw.hasFile === true;
	const queue = queueByEpisode.get(id) ?? null;
	let state: EpisodeState;
	if (queue) state = queue.state === 'downloading' ? 'downloading' : queue.state;
	else if (hasFile) state = 'available';
	else if (airDateUtc === null || airDateUtc > now) state = 'future';
	else if (!monitored) state = 'unmonitored';
	else state = 'missing';
	return {
		id,
		key: `sonarr-episode-${id}`,
		seriesId: num(raw.seriesId) ?? 0,
		integrationId,
		seasonNumber: num(raw.seasonNumber) ?? 0,
		episodeNumber: num(raw.episodeNumber) ?? 0,
		title: str(raw.title),
		airDateUtc,
		monitored,
		hasFile,
		state,
		quality: hasFile ? quality.name : null,
		qualityResolution: hasFile ? quality.resolution : null,
		sizeBytes: hasFile ? num(file?.size) : null,
		releaseGroup: hasFile ? str(file?.releaseGroup) : null,
		dateAdded: hasFile ? toEpoch(file?.dateAdded) : null,
		languages: hasFile
			? arr<{ name?: unknown }>(file?.languages)
					.map((l) => str(l.name))
					.filter((n): n is string => n !== null)
			: [],
		customFormats: hasFile
			? arr<{ name?: unknown }>(file?.customFormats)
					.map((f) => str(f.name))
					.filter((n): n is string => n !== null)
			: [],
		releaseTitle: hasFile ? str(file?.sceneName) : null,
		upgradeAvailable: hasFile ? file?.qualityCutoffNotMet === true : false,
		queue,
		subtitles: null
	};
}

/** Bazarr subtitles/missing_subtitles arrays → normalized subtitle state. */
export function normalizeSubtitleState(
	subtitles: unknown,
	missingSubtitles: unknown
): BrowseSubtitleState {
	const present: BrowseSubtitleFile[] = arr<Record<string, unknown>>(subtitles)
		.map((s) => ({
			code2: str(s.code2) ?? '',
			name: str(s.name) ?? str(s.code2) ?? 'Unknown',
			forced: s.forced === true,
			hearingImpaired: s.hi === true,
			provider: str(s.provider)
		}))
		.filter((s) => s.code2 !== '');
	const missing = arr<Record<string, unknown>>(missingSubtitles)
		.map((s) => ({ code2: str(s.code2) ?? '', name: str(s.name) ?? str(s.code2) ?? 'Unknown' }))
		.filter((s) => s.code2 !== '');
	return { present, missing };
}

/**
 * Map the Arr queue onto per-item correlation keys using upstream ids only
 * (§115). Titles are never used for matching.
 */
export function queueIndexByEpisode(
	items: {
		episodeId?: number | null;
		status?: string;
		trackedDownloadStatus?: string;
		trackedDownloadState?: string;
		progress?: number;
	}[]
): Map<number, NonNullable<BrowseEpisode['queue']>> {
	const index = new Map<number, NonNullable<BrowseEpisode['queue']>>();
	for (const item of items) {
		if (typeof item.episodeId !== 'number') continue;
		const state = queueStateOf(item.status ?? '', item.trackedDownloadState ?? '');
		index.set(item.episodeId, {
			state,
			progress: typeof item.progress === 'number' ? Math.round(item.progress) : null
		});
	}
	return index;
}

export function queueIndexByMovieId(
	items: {
		movieId?: number | null;
		status?: string;
		trackedDownloadState?: string;
		progress?: number;
	}[]
): Map<number, NonNullable<BrowseEpisode['queue']>> {
	const index = new Map<number, NonNullable<BrowseEpisode['queue']>>();
	for (const item of items) {
		if (typeof item.movieId !== 'number') continue;
		const state = queueStateOf(item.status ?? '', item.trackedDownloadState ?? '');
		index.set(item.movieId, {
			state,
			progress: typeof item.progress === 'number' ? Math.round(item.progress) : null
		});
	}
	return index;
}

export function queueStateOf(
	status: string,
	trackedDownloadState: string
): 'downloading' | 'queued' | 'importing' {
	const haystack = `${status} ${trackedDownloadState}`;
	// Import states take precedence: Radarr reports "importPending" while the
	// item is still in the queue header as "queued".
	if (/import/i.test(haystack)) return 'importing';
	if (/queued|delay|pending/i.test(haystack)) return 'queued';
	return 'downloading';
}

const HISTORY_LABELS: Record<string, BrowseHistoryEvent['label']> = {
	grabbed: 'Grabbed',
	downloadfolderimported: 'Imported',
	moviefileimported: 'Imported',
	episodeimported: 'Imported',
	downloadfailed: 'Download failed',
	moviefiledeleted: 'Deleted',
	episodefiledeleted: 'Deleted',
	episodefilerenamed: 'Renamed',
	moviefilerenamed: 'Renamed'
};

export function normalizeHistoryEvent(raw: Record<string, unknown>): BrowseHistoryEvent | null {
	const rawType = str(raw.eventType);
	if (!rawType) return null;
	const label = HISTORY_LABELS[rawType.toLowerCase()] ?? 'Other';
	const quality = qualityLabel(raw.quality).name;
	return {
		at: toEpoch(raw.date) ?? Date.now(),
		label,
		detail: str(raw.sourceTitle),
		quality
	};
}

/** Bazarr language profiles → normalized profile (§51, read-only). */
export function normalizeLanguageProfile(
	raw: Record<string, unknown>
): BrowseLanguageProfile | null {
	const id = num(raw.profileId);
	if (id === null) return null;
	const items = arr<{ language?: unknown; id?: unknown }>(raw.items);
	const languages = items.map((item) => str(item.language)).filter((l): l is string => l !== null);
	const cutoffId = num(raw.cutoff);
	const cutoffLanguage = items.find((item, i) => cutoffId === item.id || cutoffId === i + 1);
	return {
		id,
		name: str(raw.name) ?? `Profile ${id}`,
		cutoff: str(cutoffLanguage?.language),
		languages
	};
}
