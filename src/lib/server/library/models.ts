/**
 * Normalized media-library models (brief §52). The UI never sees raw Sonarr/
 * Radarr/Bazarr JSON — adapters/pollers map onto these shapes, and the
 * library service derives the higher-level aggregates on top.
 *
 * Provenance (brief §53): `exact` = straight from the source API,
 * `derived` = computed from exact data, `inferred` = correlated across
 * services. Every user-facing derived number carries its provenance.
 */

export type MediaKind = 'tv' | 'movies' | 'subtitles';

export type MissingStatus =
	| 'missing' // released, monitored, no file — the real backlog
	| 'downloading' // active queue entry exists
	| 'queued' // queued/download client state
	| 'searching' // recent search/grab activity exists
	| 'waiting' // no evidence of activity (correlated, conservative)
	| 'upcoming' // not released yet — never part of the backlog
	| 'unmonitored'
	| 'unknown';

export interface MissingItem {
	/** Stable source id (episode id / movie id). */
	id: string;
	kind: 'episode' | 'movie';
	title: string;
	/** "S03E08" for episodes, year for movies. */
	detail: string | null;
	/** Release/air date (epoch ms) when known. */
	releasedAt: number | null;
	monitored: boolean;
	status: MissingStatus;
	/** Backlog-age bucket over RELEASED items only (brief §13). */
	ageBucket: 'new' | '1-7d' | '7-30d' | '30d+' | null;
	/** Epoch ms of the last search/grab when the source knows it. */
	lastSearchAt: number | null;
	seriesId?: number | null;
	/** radarrId/sonarrSeriesId for subtitle correlation. */
	sourceRefs?: { radarrId?: number; sonarrSeriesId?: number } | null;
}

export interface LibraryTotals {
	/** Exact counts straight from the source API. */
	monitoredMissing: number;
	upgradesAvailable: number;
	queue: number;
	failedImports: number;
	/** Derived completion ratio (0–100) — see docs/LIBRARY-INTELLIGENCE.md. */
	completionPct: number | null;
	/** Derived from release dates; released items only, future excluded. */
	backlogAges: { new: number; '1-7d': number; '7-30d': number; '30d+': number } | null;
	/** Items behind the release window that are not released yet. */
	upcoming: number;
	/** Units of the library, for context (episodes / movies). */
	totalUnits: number | null;
	availableUnits: number | null;
	/** Library size on disk in bytes, when the source reports it. */
	sizeOnDiskBytes: number | null;
	/** Epoch ms the underlying data was fetched. */
	fetchedAt: number | null;
}

export interface TvLibrary extends LibraryTotals {
	seriesTotal: number;
	seriesMonitored: number;
	/** Per-series missing aggregates for the ranked list (bounded). */
	series: { id: number; title: string; missing: number; ended: boolean | null }[];
}

export interface MoviesLibrary extends LibraryTotals {
	moviesTotal: number;
	moviesMonitored: number;
}

export interface SubtitleLanguageRow {
	code2: string;
	name: string;
	/** Monitored items where this language is wanted. */
	required: number;
	missing: number;
	/** Derived: (required - missing) / required * 100. */
	coveragePct: number | null;
}

export interface SubtitlesLibrary {
	/** Exact from Bazarr badges. */
	episodeGaps: number;
	movieGaps: number;
	totalGaps: number;
	coveragePct: number | null;
	languages: SubtitleLanguageRow[];
	/** Titles with the most missing subtitle languages (bounded). */
	worst: { id: string; title: string; kind: 'episode' | 'movie'; missing: string[] }[];
	fetchedAt: number | null;
}

export interface QueueGroup {
	kind: 'downloading' | 'queued' | 'importing' | 'failed' | 'warning';
	count: number;
	sources: { type: string; integrationId: string; count: number }[];
}

export interface QueueIssue {
	integrationId: string;
	type: string;
	title: string;
	reason: string;
	severity: 'issue' | 'attention';
}

export interface AttentionItem {
	id: string;
	/** Issue = operational failure; Attention = needs a human decision;
	 *  Backlog = normal library debt (never an alarm). */
	severity: 'issue' | 'attention' | 'backlog' | 'informational';
	title: string;
	detail: string;
	href: string;
}

export interface LibrarySnapshotPoint {
	at: number;
	kind: MediaKind;
	/** Missing backlog count. */
	missing: number;
	upgrades: number;
	/** Subtitle gaps (subtitles kind only). */
	gaps: number | null;
}
