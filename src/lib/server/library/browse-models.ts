/**
 * Normalized browse models for the Unified Library Manager (§54/§55). The UI
 * never sees raw Sonarr/Radarr/Bazarr JSON: pollers map upstream payloads onto
 * these shapes and the browse API serves them. Identity is always the stable
 * upstream id (`sonarr-series-1`, §61) — never a title.
 *
 * Cross-service correlation (§62):
 *   Sonarr series id  ↔  Bazarr `sonarrSeriesId` (+ `sonarrEpisodeId`)
 *   Radarr movie id   ↔  Bazarr `radarrId`
 */

export type BrowseSource = 'sonarr' | 'radarr';

/** Stable composite key, e.g. `sonarr-series-3` / `radarr-movie-9` (§61). */
export type BrowseItemKey = string;

export type SeriesStatus = 'continuing' | 'ended' | 'upcoming';

export interface BrowseSeason {
	seasonNumber: number;
	monitored: boolean;
	/** Episodes with a file. */
	fileCount: number;
	/** Aired/available episodes (excludes future). */
	airedCount: number;
	/** All episodes including future ones. */
	totalCount: number;
	sizeOnDiskBytes: number;
}

export interface BrowseSeries {
	key: BrowseItemKey;
	source: 'sonarr';
	integrationId: string;
	/** Sonarr series id. */
	id: number;
	title: string;
	sortTitle: string;
	year: number | null;
	status: SeriesStatus;
	monitored: boolean;
	network: string | null;
	runtime: number | null;
	genres: string[];
	seriesType: string;
	qualityProfile: string | null;
	seasons: BrowseSeason[];
	/** Episodes with a file (Sonarr statistics.episodeFileCount). */
	episodeFileCount: number;
	/** Aired episodes (statistics.episodeCount). */
	episodeCount: number;
	/** Future episodes (totalEpisodeCount − episodeCount). */
	episodeFutureCount: number;
	/** Aired episodes without a file — Sonarr's own series math. */
	missingCount: number;
	/** Sonarr's own percentOfEpisodes, when reported. */
	completionPct: number | null;
	sizeOnDiskBytes: number;
	addedAt: number | null;
	path: string | null;
	/** ETag seed for the poster proxy (MediaCover lastWrite). */
	posterVersion: string | null;
	fetchedAt: number;
}

export type MovieStatus = 'released' | 'inCinemas' | 'announced' | 'tba' | 'deleted';

export interface BrowseMovie {
	key: BrowseItemKey;
	source: 'radarr';
	integrationId: string;
	/** Radarr movie id. */
	id: number;
	title: string;
	sortTitle: string;
	year: number | null;
	status: MovieStatus;
	monitored: boolean;
	/** Radarr isAvailable: released inside the configured availability window. */
	isAvailable: boolean;
	hasFile: boolean;
	/** Human quality name from the structured quality object (§20), e.g. WEBDL-1080p. */
	quality: string | null;
	qualityResolution: number | null;
	sizeBytes: number | null;
	releaseGroup: string | null;
	dateAdded: number | null;
	edition: string | null;
	languages: string[];
	customFormats: string[];
	/** Upstream `movieFile.qualityCutoffNotMet` — never derived locally (§114). */
	upgradeAvailable: boolean;
	qualityProfile: string | null;
	runtime: number | null;
	certification: string | null;
	studio: string | null;
	genres: string[];
	collection: string | null;
	digitalRelease: number | null;
	inCinemas: number | null;
	physicalRelease: number | null;
	tmdbId: number | null;
	imdbId: string | null;
	path: string | null;
	posterVersion: string | null;
	addedAt: number | null;
	fetchedAt: number;
}

export type EpisodeState =
	| 'available' // has file
	| 'missing' // released (aired) monitored, no file
	| 'downloading' // queue entry for this episode
	| 'queued' // queue entry pre-download
	| 'importing' // queue entry in import phase
	| 'future' // unaired
	| 'unmonitored'
	| 'unknown';

export interface BrowseSubtitleFile {
	code2: string;
	name: string;
	forced: boolean;
	hearingImpaired: boolean;
	/** Present only when Bazarr exposes it (§52). */
	provider?: string | null;
}

export interface BrowseSubtitleState {
	/** Downloaded subtitle files (capped for display upstream of this model). */
	present: BrowseSubtitleFile[];
	/** Wanted-but-absent languages, from Bazarr's own missing_subtitles. */
	missing: { code2: string; name: string }[];
}

export interface BrowseEpisode {
	/** Sonarr episode id. */
	id: number;
	key: BrowseItemKey;
	seriesId: number;
	integrationId: string;
	seasonNumber: number;
	episodeNumber: number;
	title: string | null;
	/** Epoch ms (UTC air date); null when unaired/no date. */
	airDateUtc: number | null;
	monitored: boolean;
	hasFile: boolean;
	state: EpisodeState;
	quality: string | null;
	qualityResolution: number | null;
	sizeBytes: number | null;
	releaseGroup: string | null;
	dateAdded: number | null;
	languages: string[];
	customFormats: string[];
	releaseTitle: string | null;
	/** Upstream episodeFile.qualityCutoffNotMet (§22/§114). */
	upgradeAvailable: boolean;
	/** True when this episode is in the active queue (id-correlated, §115). */
	queue: { state: 'downloading' | 'queued' | 'importing'; progress: number | null } | null;
	subtitles: BrowseSubtitleState | null;
}

export interface BrowseLanguageProfile {
	id: number;
	name: string;
	cutoff: string | null;
	languages: string[];
}

/** Cache payload written by the Sonarr `browse` poller. */
export interface SonarrBrowseCache {
	series: BrowseSeries[];
	fetchedAt: number;
}

/** Cache payload written by the Radarr `browse` poller. */
export interface RadarrBrowseCache {
	movies: BrowseMovie[];
	fetchedAt: number;
}

/** Cache payload written by the Bazarr `browse` poller. */
export interface BazarrBrowseCache {
	/** Per-series subtitle aggregates keyed by Sonarr series id (§62). */
	seriesById: Record<
		number,
		{ title: string; monitored: boolean; episodeGaps: number; missingLanguages: number }
	>;
	/** Per-movie subtitle state keyed by Radarr movie id (§62). */
	moviesById: Record<
		number,
		{
			title: string;
			monitored: boolean;
			present: string[];
			missing: string[];
			profileId: number | null;
		}
	>;
	/** Languages the user actually configured in Bazarr (§24). */
	enabledLanguages: { code2: string; name: string }[];
	/** Full code2→name map so codes from profiles/items resolve to labels. */
	languageNames: Record<string, string>;
	profiles: BrowseLanguageProfile[];
	fetchedAt: number;
}

/** Recent history event normalized for item detail (§116/§117). */
export interface BrowseHistoryEvent {
	at: number;
	label: 'Grabbed' | 'Imported' | 'Download failed' | 'Deleted' | 'Renamed' | 'Other';
	detail: string | null;
	quality: string | null;
}

/** Human status strings — never raw API enums in the UI (§10/§18). */
export function seriesStatusLabel(status: SeriesStatus): string {
	if (status === 'continuing') return 'Continuing';
	if (status === 'ended') return 'Ended';
	return 'Upcoming';
}

export function episodeStatusLabel(state: EpisodeState): string {
	switch (state) {
		case 'available':
			return 'Available';
		case 'missing':
			return 'Missing';
		case 'downloading':
			return 'Downloading';
		case 'queued':
			return 'Queued';
		case 'importing':
			return 'Importing';
		case 'future':
			return 'Future';
		case 'unmonitored':
			return 'Not monitored';
		default:
			return 'Unknown';
	}
}

export function movieStatusLabel(
	movie: Pick<BrowseMovie, 'status' | 'hasFile' | 'isAvailable'>
): string {
	if (movie.hasFile) return 'Available';
	if (!movie.isAvailable) return 'Upcoming';
	return 'Missing';
}
