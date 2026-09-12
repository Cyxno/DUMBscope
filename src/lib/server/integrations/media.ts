/**
 * Media library pollers (read-only): normalize Sonarr/Radarr library state
 * and Bazarr subtitle coverage into the shared models. Frequencies follow
 * the brief (§50): library/missing in the 10–15 min band, Bazarr coverage
 * 10–30 min, on top of the existing 15s queue poller.
 */
import type { PollContext, PollerSpec } from './manager';
import type {
	MissingItem,
	MoviesLibrary,
	SubtitlesLibrary,
	TvLibrary
} from '$lib/server/library/models';
import { ageBucketFor, completionPct, subtitleCoverage } from '$lib/server/library/aggregate';
import { BazarrClient, type BazarrMovie, type BazarrSeries } from './bazarr';
import { ArrBaseClient } from './arr/base';
import {
	normalizeLanguageProfile,
	normalizeRadarrMovie,
	normalizeSonarrSeries,
	normalizeSubtitleState
} from '$lib/server/library/browse-normalize';
import type {
	BazarrBrowseCache,
	BrowseLanguageProfile,
	RadarrBrowseCache,
	SonarrBrowseCache
} from '$lib/server/library/browse-models';

const LIBRARY_TTL_MS = 10 * 60_000;
const COVERAGE_TTL_MS = 15 * 60_000;
const MISSING_FETCH_CAP = 500;

function toEpoch(value: unknown): number | null {
	if (typeof value !== 'string' || value.length === 0) return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

function bucketFrom(releasedAt: number | null): MissingItem['ageBucket'] {
	return ageBucketFor(releasedAt);
}

// ---------------------------------------------------------------------------
// Sonarr / Radarr
// ---------------------------------------------------------------------------

export interface ArrLibraryData {
	tv?: TvLibrary;
	movies?: MoviesLibrary;
	missing: MissingItem[];
}

export async function fetchArrLibrary(
	kind: 'sonarr' | 'radarr',
	client: ArrBaseClient
): Promise<ArrLibraryData> {
	const missing: MissingItem[] = [];

	// Wanted/missing: monitored + released + no file. Paged with a hard cap —
	// a huge backlog must never explode the poll (brief §66/§67).
	const first = await client.wantedMissing(1, 100, { includeSeries: kind === 'sonarr' });
	const totalRecords = first.totalRecords ?? 0;
	const pages = Math.min(Math.ceil(totalRecords / 100) || 1, Math.ceil(MISSING_FETCH_CAP / 100));
	missing.push(...first.records.map((r) => normalizeMissing(kind, r)));
	for (let page = 2; page <= pages; page++) {
		const next = await client.wantedMissing(page, 100, { includeSeries: kind === 'sonarr' });
		missing.push(...next.records.map((r) => normalizeMissing(kind, r)));
	}

	if (kind === 'sonarr') {
		const series = await client.series();
		const monitoredSeries = series.filter((s) => s.monitored);
		const episodeTotal = monitoredSeries.reduce(
			(sum, s) => sum + (s.statistics?.episodeCount ?? 0),
			0
		);
		const episodeAvailable = monitoredSeries.reduce(
			(sum, s) => sum + (s.statistics?.episodeFileCount ?? 0),
			0
		);
		const sizeOnDisk = series.reduce((sum, s) => sum + (s.statistics?.sizeOnDisk ?? 0), 0);
		// Ranked "most missing" list: episodes missing per series, exact from
		// the missing fetch grouped by seriesId (bounded to 200 entries).
		const bySeries = new Map<number, { title: string; missing: number }>();
		for (const item of missing) {
			const id = item.seriesId;
			if (id === undefined || id === null) continue;
			const entry = bySeries.get(id) ?? { title: item.title, missing: 0 };
			entry.missing += 1;
			bySeries.set(id, entry);
		}
		const tv: TvLibrary = {
			seriesTotal: series.length,
			seriesMonitored: monitoredSeries.length,
			monitoredMissing: totalRecords,
			upgradesAvailable: 0,
			queue: 0,
			failedImports: 0,
			completionPct: completionPct(episodeTotal, totalRecords),
			backlogAges: null,
			upcoming: 0,
			totalUnits: episodeTotal,
			availableUnits: episodeAvailable,
			sizeOnDiskBytes: sizeOnDisk,
			fetchedAt: Date.now(),
			series: [...bySeries.entries()]
				.map(([id, agg]) => ({ id, title: agg.title, missing: agg.missing, ended: null }))
				.sort((a, b) => b.missing - a.missing || a.title.localeCompare(b.title))
				.slice(0, 200)
		};
		return { tv, missing };
	}

	// Radarr
	const movies = await client.movies();
	const monitored = movies.filter((m) => m.monitored);
	const released = monitored.filter((m) => m.isAvailable !== false);
	const upcoming = monitored.filter((m) => m.isAvailable === false).length;
	const sizeOnDisk = movies.reduce((sum, m) => sum + (m.sizeOnDisk ?? 0), 0);
	const moviesLibrary: MoviesLibrary = {
		moviesTotal: movies.length,
		moviesMonitored: monitored.length,
		monitoredMissing: released.length,
		upgradesAvailable: 0,
		queue: 0,
		failedImports: 0,
		completionPct: completionPct(released.length, released.length),
		backlogAges: null,
		upcoming,
		totalUnits: movies.length,
		availableUnits: monitored.filter((m) => m.hasFile).length,
		sizeOnDiskBytes: sizeOnDisk,
		fetchedAt: Date.now()
	};
	// Exact missing = monitored + released + no file (from the wanted list,
	// which carries release dates for backlog aging).
	const exactMissing = missing.filter((m) => m.status === 'missing');
	moviesLibrary.monitoredMissing = exactMissing.length;
	moviesLibrary.completionPct = completionPct(released.length, exactMissing.length);
	return { movies: moviesLibrary, missing };
}

function normalizeMissing(kind: 'sonarr' | 'radarr', raw: Record<string, unknown>): MissingItem {
	if (kind === 'sonarr') {
		const series = raw.series as { title?: string; id?: number } | undefined;
		const releasedAt = toEpoch(raw.airDateUtc);
		const monitored = raw.monitored !== false;
		const season = Number(raw.seasonNumber);
		const episode = Number(raw.episodeNumber);
		const detail =
			Number.isFinite(season) && Number.isFinite(episode)
				? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
				: null;
		return {
			id: `sonarr-${String(raw.id)}`,
			kind: 'episode',
			title: series?.title ?? 'Unknown series',
			detail,
			releasedAt,
			monitored,
			status: monitored ? 'missing' : 'unmonitored',
			ageBucket: monitored ? bucketFrom(releasedAt) : null,
			lastSearchAt: toEpoch(raw.lastSearchTime),
			seriesId: series?.id ?? null
		};
	}
	const releasedAt =
		toEpoch(raw.digitalRelease) ?? toEpoch(raw.inCinemas) ?? toEpoch(raw.physicalRelease);
	const available = raw.isAvailable !== false;
	const monitored = raw.monitored !== false;
	return {
		id: `radarr-${String(raw.id)}`,
		kind: 'movie',
		title: String(raw.title ?? 'Unknown movie'),
		detail: raw.year ? String(raw.year) : null,
		releasedAt,
		monitored,
		status: !monitored ? 'unmonitored' : available ? 'missing' : 'upcoming',
		ageBucket: monitored && available ? bucketFrom(releasedAt) : null,
		lastSearchAt: null,
		seriesId: null
	};
}

/** Library + missing pollers added to the existing Sonarr/Radarr set. */
export function arrLibraryPollers(kind: 'sonarr' | 'radarr'): PollerSpec[] {
	const makeClient = (ctx: PollContext) => new ArrBaseClient(ctx.config.url, ctx.apiKey ?? '');
	return [
		{
			name: 'library',
			intervalMs: 10 * 60_000,
			run: async (ctx: PollContext) => {
				const started = Date.now();
				const data = await fetchArrLibrary(kind, makeClient(ctx));
				// Merge with the wanted cache written below (same integration).
				ctx.cache.set('library', data, LIBRARY_TTL_MS);
				ctx.ok(undefined, Date.now() - started);
			}
		}
	];
}

// ---------------------------------------------------------------------------
// Library browser pollers (§54/§56): item-level inventory in one bulk request
// per service, normalized server-side. Read-only, bounded by the upstream
// payloads themselves (Sonarr /series ≈ 230 KB, Radarr /movie ≈ 1.5 MB,
// Bazarr /movies+/series ≈ 550 KB at audit time).
// ---------------------------------------------------------------------------

const BROWSE_TTL_MS = 10 * 60_000;
const BAZARR_BROWSE_TTL_MS = 15 * 60_000;

/** `browse` poller: one bulk inventory request for the TV/movie browsers. */
export function arrBrowsePollers(kind: 'sonarr' | 'radarr'): PollerSpec[] {
	return [
		{
			name: 'browse',
			intervalMs: BROWSE_TTL_MS,
			run: async (ctx: PollContext) => {
				const started = Date.now();
				const client = new ArrBaseClient(ctx.config.url, ctx.apiKey ?? '');
				const profiles = await client.qualityProfiles();
				if (kind === 'sonarr') {
					const raw = await client.seriesRaw();
					const series = raw.map((r) =>
						normalizeSonarrSeries(r, ctx.config.id, profiles, Date.now())
					);
					const payload: SonarrBrowseCache = { series, fetchedAt: Date.now() };
					ctx.cache.set('browse', payload, BROWSE_TTL_MS);
				} else {
					const raw = await client.moviesRaw();
					const movies = raw.map((r) =>
						normalizeRadarrMovie(r, ctx.config.id, profiles, Date.now())
					);
					const payload: RadarrBrowseCache = { movies, fetchedAt: Date.now() };
					ctx.cache.set('browse', payload, BROWSE_TTL_MS);
				}
				ctx.ok(undefined, Date.now() - started);
			}
		}
	];
}

/** `browse` poller for Bazarr: subtitle state keyed by Sonarr/Radarr ids. */
export function bazarrBrowsePollers(): PollerSpec[] {
	return [
		{
			name: 'browse',
			intervalMs: BAZARR_BROWSE_TTL_MS,
			run: async (ctx: PollContext) => {
				const started = Date.now();
				const client = new BazarrClient(ctx.config.url, ctx.apiKey ?? '');
				const [seriesPage, moviesPage, languages, profileRaw] = await Promise.all([
					client.series(-1),
					client.movies(-1),
					client.languages(),
					client.languageProfiles()
				]);

				const seriesById: BazarrBrowseCache['seriesById'] = {};
				for (const s of seriesPage.data) {
					const key = typeof s.sonarrSeriesId === 'number' ? s.sonarrSeriesId : null;
					if (key === null) continue;
					seriesById[key] = {
						title: s.title,
						monitored: s.monitored !== false,
						episodeGaps: s.episodeMissingCount ?? 0,
						missingLanguages: 0
					};
				}

				const moviesById: BazarrBrowseCache['moviesById'] = {};
				for (const m of moviesPage.data) {
					const key = typeof m.radarrId === 'number' ? m.radarrId : null;
					if (key === null) continue;
					const state = normalizeSubtitleState(m.subtitles, m.missing_subtitles);
					moviesById[key] = {
						title: m.title,
						monitored: m.monitored !== false,
						present: [...new Set(state.present.map((p) => p.code2))],
						missing: [...new Set(state.missing.map((p) => p.code2))],
						profileId: null
					};
				}

				const enabledLanguages = languages
					.filter((l) => l.enabled === true && l.code2)
					.map((l) => ({ code2: l.code2 as string, name: l.name ?? (l.code2 as string) }));

				const languageNames: Record<string, string> = {};
				for (const l of languages) {
					if (l.code2) languageNames[l.code2] = l.name ?? l.code2;
				}

				const profiles: BrowseLanguageProfile[] = profileRaw
					.map(normalizeLanguageProfile)
					.filter((p): p is BrowseLanguageProfile => p !== null);

				const payload: BazarrBrowseCache = {
					seriesById,
					moviesById,
					enabledLanguages,
					languageNames,
					profiles,
					fetchedAt: Date.now()
				};
				ctx.cache.set('browse', payload, BAZARR_BROWSE_TTL_MS);
				ctx.ok(undefined, Date.now() - started);
			}
		}
	];
}

// ---------------------------------------------------------------------------
// Bazarr
// ---------------------------------------------------------------------------

export async function fetchBazarrCoverage(
	client: BazarrClient
): Promise<{ subtitles: SubtitlesLibrary; wanted: MissingItem[] }> {
	const badges = await client.badges();
	const movies = await client.movies(1000);
	const series = await client.series(1000);
	const wantedMovies = await client.moviesWanted(100);

	const languageNames = new Map<string, string>();
	for (const lang of await client.languages()) {
		if (lang.code2 && lang.name) languageNames.set(lang.code2, lang.name);
	}

	// Movie-level wanted/missing per language over monitored movies.
	const wantedPerLanguage = new Map<string, number>();
	const missingPerLanguage = new Map<string, number>();
	const monitor = (movie: BazarrMovie) => {
		for (const sub of movie.subtitles ?? []) {
			if (sub.code2) wantedPerLanguage.set(sub.code2, (wantedPerLanguage.get(sub.code2) ?? 0) + 1);
		}
		for (const sub of movie.missing_subtitles ?? []) {
			if (sub.code2) {
				missingPerLanguage.set(sub.code2, (missingPerLanguage.get(sub.code2) ?? 0) + 1);
				wantedPerLanguage.set(sub.code2, (wantedPerLanguage.get(sub.code2) ?? 0) + 1);
			}
		}
	};
	const monitoredMovies = movies.data.filter((m) => m.monitored !== false);
	for (const movie of monitoredMovies) monitor(movie);

	const languages = subtitleCoverage(
		monitoredMovies.length,
		wantedPerLanguage,
		missingPerLanguage,
		languageNames
	);

	const worst: SubtitlesLibrary['worst'] = [];
	for (const movie of wantedMovies.data.slice(0, 25)) {
		const codes = (movie.missing_subtitles ?? []).map((m) => m.name ?? m.code2 ?? '?');
		if (codes.length > 0)
			worst.push({
				id: `bazarr-movie-${String(movie.radarrId ?? movie.title)}`,
				title: movie.title,
				kind: 'movie',
				missing: codes
			});
	}
	const worstSeries = series.data
		.filter((s: BazarrSeries) => (s.episodeMissingCount ?? 0) > 0)
		.sort((a, b) => (b.episodeMissingCount ?? 0) - (a.episodeMissingCount ?? 0))
		.slice(0, 25)
		.map((s) => ({
			id: `bazarr-series-${String(s.sonarrSeriesId ?? s.title)}`,
			title: s.title,
			kind: 'episode' as const,
			missing: [`${s.episodeMissingCount} episodes missing subtitles`]
		}));
	worst.push(...worstSeries);

	const movieGaps = badges.movies;
	const episodeGaps = badges.episodes;
	const totalGaps = movieGaps + episodeGaps;
	const subtitles: SubtitlesLibrary = {
		episodeGaps,
		movieGaps,
		totalGaps,
		// Overall coverage is derived at the service layer against Sonarr/Radarr
		// library units (Bazarr alone has no reliable episode totals).
		coveragePct: null,
		languages,
		worst,
		fetchedAt: Date.now()
	};

	const wanted: MissingItem[] = wantedMovies.data.map((movie) => ({
		id: `bazarr-movie-${String(movie.radarrId ?? movie.title)}`,
		kind: 'movie',
		title: movie.title,
		detail: (movie.missing_subtitles ?? []).map((m) => m.name ?? m.code2).join(', ') || null,
		releasedAt: null,
		monitored: movie.monitored !== false,
		status: 'missing',
		ageBucket: null,
		lastSearchAt: null,
		sourceRefs: { radarrId: movie.radarrId }
	}));

	return { subtitles, wanted };
}

export function bazarrPollers(): PollerSpec[] {
	const makeClient = (ctx: PollContext) => new BazarrClient(ctx.config.url, ctx.apiKey ?? '');
	return [
		{
			name: 'coverage',
			intervalMs: 15 * 60_000,
			run: async (ctx: PollContext) => {
				const started = Date.now();
				const data = await fetchBazarrCoverage(makeClient(ctx));
				ctx.cache.set(
					'library',
					{ subtitles: data.subtitles, wanted: data.wanted },
					COVERAGE_TTL_MS
				);
				ctx.ok(undefined, Date.now() - started);
			}
		},
		...bazarrBrowsePollers(),
		{
			name: 'version',
			intervalMs: 60 * 60_000,
			run: async (ctx: PollContext) => {
				const status = await makeClient(ctx).status();
				ctx.ok(status.version, undefined);
			}
		}
	];
}
