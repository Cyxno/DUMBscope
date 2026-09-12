/**
 * Unified library browser tests (§155-§159): normalization against real
 * upstream shapes (audited Sonarr 4 / Radarr 6 / Bazarr 1.6), filter/sort/
 * pagination boundaries, param validation, id-based queue correlation and
 * the lazy per-series client endpoints. No false missing/available/upgrade
 * semantics may ever regress (§112-§114/§189).
 */
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import {
	normalizeHistoryEvent,
	normalizeLanguageProfile,
	normalizeRadarrMovie,
	normalizeSonarrEpisode,
	normalizeSonarrSeries,
	normalizeSubtitleState,
	qualityLabel,
	queueIndexByEpisode,
	queueIndexByMovieId,
	queueStateOf
} from '../src/lib/server/library/browse-normalize';
import {
	filterSortMovies,
	filterSortSeries,
	movieListParams,
	pageOf,
	seriesListParams,
	isMovieMissing
} from '../src/lib/server/library/browse-filter';
import type { BrowseMovie, BrowseSeries } from '../src/lib/server/library/browse-models';
import { ArrBaseClient } from '../src/lib/server/integrations/arr/base';
import { BazarrClient } from '../src/lib/server/integrations/bazarr';

// ---------------------------------------------------------------------------
// Sonarr series normalization (§9/§14)
// ---------------------------------------------------------------------------

describe('sonarr series normalization', () => {
	const profileNames = new Map<number, string>([[7, 'Debrid 1080p-4K']]);

	it('maps statistics, seasons and profile names', () => {
		const series = normalizeSonarrSeries(
			{
				id: 3,
				title: 'A Knight of the Seven Kingdoms',
				sortTitle: 'knight of the seven kingdoms',
				year: 2026,
				status: 'continuing',
				monitored: true,
				network: 'HBO',
				runtime: 55,
				genres: ['Fantasy'],
				seriesType: 'standard',
				qualityProfileId: 7,
				path: '/media/series/a-knight',
				added: '2026-01-02T03:04:05Z',
				statistics: {
					episodeFileCount: 4,
					episodeCount: 6,
					totalEpisodeCount: 8,
					sizeOnDisk: 12_345,
					percentOfEpisodes: 66.7
				},
				seasons: [
					{
						seasonNumber: 0,
						monitored: false,
						statistics: {
							episodeFileCount: 0,
							episodeCount: 1,
							totalEpisodeCount: 1,
							sizeOnDisk: 0
						}
					},
					{
						seasonNumber: 1,
						monitored: true,
						statistics: {
							episodeFileCount: 4,
							episodeCount: 5,
							totalEpisodeCount: 7,
							sizeOnDisk: 12_345
						}
					}
				],
				images: [{ coverType: 'poster', url: '/MediaCover/3/poster.jpg?lastWrite=12345' }]
			},
			'sonarr-main',
			profileNames
		);
		expect(series.key).toBe('sonarr-series-3');
		expect(series.missingCount).toBe(2);
		expect(series.episodeFutureCount).toBe(2);
		expect(series.qualityProfile).toBe('Debrid 1080p-4K');
		expect(series.posterVersion).toBe('12345');
		expect(series.seasons).toHaveLength(2);
		expect(series.seasons[1]).toEqual({
			seasonNumber: 1,
			monitored: true,
			fileCount: 4,
			airedCount: 5,
			totalCount: 7,
			sizeOnDiskBytes: 12_345
		});
		expect(series.status).toBe('continuing');
	});

	it('maps ended and upcoming statuses', () => {
		expect(
			normalizeSonarrSeries({ id: 1, title: 'x', status: 'ended' }, 's', profileNames).status
		).toBe('ended');
		expect(
			normalizeSonarrSeries({ id: 1, title: 'x', status: 'upcoming' }, 's', profileNames).status
		).toBe('upcoming');
		expect(normalizeSonarrSeries({ id: 1, title: 'x' }, 's', profileNames).status).toBe(
			'continuing'
		);
	});

	it('never derives negative missing counts', () => {
		const series = normalizeSonarrSeries(
			{
				id: 1,
				title: 'x',
				statistics: { episodeFileCount: 10, episodeCount: 8, totalEpisodeCount: 8 }
			},
			's',
			profileNames
		);
		expect(series.missingCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Episode states (§18/§19/§112-§114)
// ---------------------------------------------------------------------------

describe('episode state derivation', () => {
	const integrationId = 'sonarr-main';
	const past = new Date(Date.now() - 12 * 86_400_000).toISOString();
	const future = new Date(Date.now() + 3 * 86_400_000).toISOString();

	it('available when a file exists (upstream hasFile)', () => {
		const e = normalizeSonarrEpisode(
			{
				id: 1,
				seriesId: 3,
				seasonNumber: 1,
				episodeNumber: 4,
				title: 'Crossroads',
				monitored: true,
				hasFile: true,
				airDateUtc: past,
				episodeFile: {
					size: 2_300_000_000,
					quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } },
					releaseGroup: 'ETHEL',
					dateAdded: '2026-09-01T00:00:00Z',
					qualityCutoffNotMet: false
				}
			},
			integrationId,
			new Map()
		);
		expect(e.state).toBe('available');
		expect(e.quality).toBe('WEBDL-1080p');
		expect(e.upgradeAvailable).toBe(false);
		expect(e.sizeBytes).toBe(2_300_000_000);
	});

	it('missing only when released, monitored, no file (§19/§112)', () => {
		const e = normalizeSonarrEpisode(
			{
				id: 2,
				seriesId: 3,
				seasonNumber: 1,
				episodeNumber: 3,
				monitored: true,
				hasFile: false,
				airDateUtc: past
			},
			integrationId,
			new Map()
		);
		expect(e.state).toBe('missing');
	});

	it('future never falls into missing (§19/§189)', () => {
		const e = normalizeSonarrEpisode(
			{
				id: 3,
				seriesId: 3,
				seasonNumber: 1,
				episodeNumber: 5,
				monitored: true,
				hasFile: false,
				airDateUtc: future
			},
			integrationId,
			new Map()
		);
		expect(e.state).toBe('future');
	});

	it('unmonitored aired episode without file is not missing', () => {
		const e = normalizeSonarrEpisode(
			{
				id: 4,
				seriesId: 3,
				seasonNumber: 1,
				episodeNumber: 2,
				monitored: false,
				hasFile: false,
				airDateUtc: past
			},
			integrationId,
			new Map()
		);
		expect(e.state).toBe('unmonitored');
	});

	it('upgrade flag mirrors upstream qualityCutoffNotMet only (§114)', () => {
		const e = normalizeSonarrEpisode(
			{
				id: 5,
				seriesId: 3,
				seasonNumber: 1,
				episodeNumber: 6,
				monitored: true,
				hasFile: true,
				airDateUtc: past,
				episodeFile: {
					size: 1,
					quality: { quality: { name: 'HDTV-720p', resolution: 720 } },
					qualityCutoffNotMet: true
				}
			},
			integrationId,
			new Map()
		);
		expect(e.upgradeAvailable).toBe(true);
	});

	it('queue entries win over file-less states (§115/§118)', () => {
		const queueIdx = queueIndexByEpisode([
			{ episodeId: 2, status: 'downloading', trackedDownloadState: 'downloading', progress: 68.4 }
		]);
		const e = normalizeSonarrEpisode(
			{
				id: 2,
				seriesId: 3,
				seasonNumber: 1,
				episodeNumber: 3,
				monitored: true,
				hasFile: false,
				airDateUtc: past
			},
			integrationId,
			queueIdx
		);
		expect(e.state).toBe('downloading');
		expect(e.queue).toEqual({ state: 'downloading', progress: 68 });
	});

	it('unaired queued episode shows queued, not missing', () => {
		const queueIdx = queueIndexByEpisode([
			{ episodeId: 3, status: 'queued', trackedDownloadState: 'queued', progress: 0 }
		]);
		const e = normalizeSonarrEpisode(
			{
				id: 3,
				seriesId: 3,
				seasonNumber: 1,
				episodeNumber: 5,
				monitored: true,
				hasFile: false,
				airDateUtc: future
			},
			integrationId,
			queueIdx
		);
		expect(e.state).toBe('queued');
	});
});

// ---------------------------------------------------------------------------
// Radarr movie normalization (§34/§42/§114)
// ---------------------------------------------------------------------------

describe('radarr movie normalization', () => {
	it('maps the embedded file and cutoff flag', () => {
		const m = normalizeRadarrMovie(
			{
				id: 9,
				title: 'Dune: Part Two',
				sortTitle: 'dune part two',
				year: 2024,
				status: 'released',
				monitored: true,
				isAvailable: true,
				hasFile: true,
				digitalRelease: '2024-03-26T00:00:00Z',
				inCinemas: '2024-03-01T00:00:00Z',
				qualityProfileId: 7,
				runtime: 166,
				certification: 'PG-13',
				studio: 'Legendary',
				genres: ['Sci-Fi'],
				tmdbId: 693134,
				imdbId: 'tt15239678',
				movieFile: {
					size: 18_400_000_000,
					quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } },
					releaseGroup: 'DRUNK',
					dateAdded: '2026-07-01T00:00:00Z',
					edition: 'Extended',
					languages: [{ name: 'English' }],
					customFormats: [{ name: 'DV HDR10' }],
					qualityCutoffNotMet: true
				}
			},
			'radarr-main',
			new Map([[7, 'Debrid 1080p-4K']])
		);
		expect(m.key).toBe('radarr-movie-9');
		expect(m.quality).toBe('WEBDL-1080p');
		expect(m.upgradeAvailable).toBe(true);
		expect(m.qualityProfile).toBe('Debrid 1080p-4K');
		expect(m.customFormats).toEqual(['DV HDR10']);
		expect(isMovieMissing(m)).toBe(false);
	});

	it('missing = upstream available without file; upcoming = not available (§113)', () => {
		const missing = normalizeRadarrMovie(
			{ id: 1, title: 'A', status: 'released', monitored: true, isAvailable: true, hasFile: false },
			'r',
			new Map()
		);
		const upcoming = normalizeRadarrMovie(
			{
				id: 2,
				title: 'B',
				status: 'announced',
				monitored: true,
				isAvailable: false,
				hasFile: false
			},
			'r',
			new Map()
		);
		expect(isMovieMissing(missing)).toBe(true);
		expect(isMovieMissing(upcoming)).toBe(false);
		expect(upcoming.isAvailable).toBe(false);
	});

	it('treats missing isAvailable as released (radarr emits true when present)', () => {
		const m = normalizeRadarrMovie(
			{ id: 1, title: 'A', status: 'released', monitored: true, hasFile: false },
			'r',
			new Map()
		);
		// isAvailable !== false → true. Radarr only emits false for unreleased.
		expect(m.isAvailable).toBe(true);
	});

	it('qualityLabel handles odd shapes without throwing', () => {
		expect(qualityLabel(null).name).toBeNull();
		expect(qualityLabel({ quality: { name: 'Bluray-2160p', resolution: 2160 } }).name).toBe(
			'Bluray-2160p'
		);
	});
});

// ---------------------------------------------------------------------------
// Bazarr correlation (§24-§26/§62)
// ---------------------------------------------------------------------------

describe('bazarr subtitle state + profiles', () => {
	it('normalizes present/missing subtitles with forced/hi flags', () => {
		const state = normalizeSubtitleState(
			[
				{ code2: 'nl', name: 'Dutch', forced: false, hi: false, provider: 'opensubtitlescom' },
				{ code2: 'en', name: 'English', forced: false, hi: true }
			],
			[{ code2: 'pl', name: 'Polish' }]
		);
		expect(state.present).toEqual([
			{
				code2: 'nl',
				name: 'Dutch',
				forced: false,
				hearingImpaired: false,
				provider: 'opensubtitlescom'
			},
			{ code2: 'en', name: 'English', forced: false, hearingImpaired: true, provider: null }
		]);
		expect(state.missing).toEqual([{ code2: 'pl', name: 'Polish' }]);
	});

	it('drops subtitle entries without codes', () => {
		const state = normalizeSubtitleState(
			[{ name: 'Broken' }],
			[{ code2: '', name: 'Also broken' }]
		);
		expect(state.present).toEqual([]);
		expect(state.missing).toEqual([]);
	});

	it('normalizes language profiles with cutoff resolution', () => {
		const profile = normalizeLanguageProfile({
			profileId: 1,
			name: 'English + Dutch',
			cutoff: 2,
			items: [
				{ id: 1, language: 'en' },
				{ id: 2, language: 'nl' }
			]
		});
		expect(profile).toEqual({
			id: 1,
			name: 'English + Dutch',
			cutoff: 'nl',
			languages: ['en', 'nl']
		});
		expect(normalizeLanguageProfile({ name: 'x' })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// History normalization (§117)
// ---------------------------------------------------------------------------

describe('history normalization', () => {
	it('maps upstream event types onto human labels', () => {
		expect(
			normalizeHistoryEvent({ eventType: 'grabbed', date: '2026-09-10T00:00:00Z' })?.label
		).toBe('Grabbed');
		expect(
			normalizeHistoryEvent({ eventType: 'downloadFolderImported', date: '2026-09-10T00:00:00Z' })
				?.label
		).toBe('Imported');
		expect(
			normalizeHistoryEvent({ eventType: 'downloadFailed', date: '2026-09-10T00:00:00Z' })?.label
		).toBe('Download failed');
		expect(
			normalizeHistoryEvent({ eventType: 'movieFileDeleted', date: '2026-09-10T00:00:00Z' })?.label
		).toBe('Deleted');
		expect(
			normalizeHistoryEvent({
				eventType: 'grabbed',
				date: '2026-09-10T00:00:00Z',
				quality: { quality: { name: 'WEBDL-1080p' } }
			})?.quality
		).toBe('WEBDL-1080p');
		expect(normalizeHistoryEvent({ date: '2026-09-10T00:00:00Z' })).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Queue correlation by ids only (§115)
// ---------------------------------------------------------------------------

describe('queue id correlation', () => {
	it('indexes episodes and movies strictly by upstream id', () => {
		const episodes = queueIndexByEpisode([
			{ episodeId: 11, status: 'downloading', trackedDownloadState: 'downloading', progress: 12.6 },
			{ episodeId: 12, status: 'queued', trackedDownloadState: 'queued', progress: 0 },
			{ status: 'downloading', trackedDownloadState: 'downloading', progress: 40 }
		]);
		const movies = queueIndexByMovieId([
			{ movieId: 7, status: 'importing', trackedDownloadState: 'importPending', progress: 100 }
		]);
		expect(episodes.get(11)).toEqual({ state: 'downloading', progress: 13 });
		expect(episodes.get(12)?.state).toBe('queued');
		expect(movies.get(7)?.state).toBe('importing');
	});

	it('classifies queue states (§18)', () => {
		expect(queueStateOf('queued', 'queued')).toBe('queued');
		expect(queueStateOf('completed', 'importPending')).toBe('importing');
		expect(queueStateOf('downloading', 'downloading')).toBe('downloading');
		expect(queueStateOf('', '')).toBe('downloading');
	});
});

// ---------------------------------------------------------------------------
// Params, filters, sorts, pagination (§28/§29/§58/§59/§128/§156/§157)
// ---------------------------------------------------------------------------

function makeSeries(partial: Partial<BrowseSeries>): BrowseSeries {
	return {
		key: `sonarr-series-${partial.id ?? 0}`,
		source: 'sonarr',
		integrationId: 'sonarr-main',
		id: partial.id ?? 0,
		title: partial.title ?? 'Series',
		sortTitle: partial.sortTitle ?? (partial.title ?? 'Series').toLowerCase(),
		year: partial.year ?? null,
		status: partial.status ?? 'continuing',
		monitored: partial.monitored ?? true,
		network: partial.network ?? null,
		runtime: null,
		genres: [],
		seriesType: 'standard',
		qualityProfile: null,
		seasons: [],
		episodeFileCount: 0,
		episodeCount: 0,
		episodeFutureCount: 0,
		missingCount: 0,
		completionPct: null,
		sizeOnDiskBytes: 0,
		addedAt: null,
		path: null,
		posterVersion: null,
		fetchedAt: 0,
		...partial
	};
}

function makeMovie(partial: Partial<BrowseMovie>): BrowseMovie {
	return {
		key: `radarr-movie-${partial.id ?? 0}`,
		source: 'radarr',
		integrationId: 'radarr-main',
		id: partial.id ?? 0,
		title: partial.title ?? 'Movie',
		sortTitle: partial.sortTitle ?? (partial.title ?? 'Movie').toLowerCase(),
		year: partial.year ?? null,
		status: 'released',
		monitored: partial.monitored ?? true,
		isAvailable: partial.isAvailable ?? true,
		hasFile: partial.hasFile ?? false,
		quality: partial.quality ?? null,
		qualityResolution: partial.qualityResolution ?? null,
		sizeBytes: null,
		releaseGroup: null,
		dateAdded: partial.addedAt ?? null,
		edition: null,
		languages: [],
		customFormats: [],
		upgradeAvailable: partial.upgradeAvailable ?? false,
		qualityProfile: null,
		runtime: null,
		certification: null,
		studio: partial.studio ?? null,
		genres: [],
		collection: null,
		digitalRelease: partial.digitalRelease ?? null,
		inCinemas: null,
		physicalRelease: null,
		tmdbId: null,
		imdbId: null,
		path: null,
		posterVersion: null,
		addedAt: partial.addedAt ?? null,
		fetchedAt: 0,
		...partial
	};
}

describe('browse param validation (§59/§60/§128)', () => {
	it('falls back on unknown filter/sort', () => {
		const url = new URL('http://x/api/library/tv?filter=evil&sort=drop');
		const params = seriesListParams(url);
		expect(params.filter).toBe('all');
		expect(params.sort).toBe('name');
	});

	it('clamps limit/offset and sanitizes q', () => {
		const url = new URL('http://x/api/library/tv?limit=500&offset=-5&q=  pilot%20');
		const params = seriesListParams(url);
		expect(params.limit).toBe(100);
		expect(params.offset).toBe(0);
		expect(params.q).toBe('pilot');
		const nan = seriesListParams(new URL('http://x/api/library/tv?limit=abc&offset=abc'));
		expect(nan.limit).toBe(50);
		expect(nan.offset).toBe(0);
		const long = seriesListParams(new URL(`http://x/api/library/tv?q=${'a'.repeat(200)}`));
		expect(long.q).toHaveLength(80);
	});

	it('movie params allow the full movie filter/sort set', () => {
		const params = movieListParams(
			new URL('http://x/api/library/movies?filter=missing&sort=missing-oldest')
		);
		expect(params.filter).toBe('missing');
		expect(params.sort).toBe('missing-oldest');
	});
});

describe('series filters and sorts (§28/§156)', () => {
	const items = [
		makeSeries({
			id: 1,
			title: 'Aegean',
			year: 2021,
			status: 'ended',
			monitored: true,
			missingCount: 0,
			completionPct: 100,
			addedAt: 5
		}),
		makeSeries({
			id: 2,
			title: 'Bromley',
			year: 2024,
			status: 'continuing',
			monitored: true,
			missingCount: 6,
			completionPct: 94,
			addedAt: 99
		}),
		makeSeries({
			id: 3,
			title: 'Cyprus',
			year: 2020,
			status: 'continuing',
			monitored: false,
			missingCount: 2,
			completionPct: 80,
			addedAt: 50
		})
	];

	it('filters', () => {
		expect(filterSortSeries(items, 'incomplete', 'name', '').map((s) => s.id)).toEqual([2, 3]);
		expect(filterSortSeries(items, 'continuing', 'name', '').map((s) => s.id)).toEqual([2, 3]);
		expect(filterSortSeries(items, 'ended', 'name', '').map((s) => s.id)).toEqual([1]);
		expect(filterSortSeries(items, 'monitored', 'name', '').map((s) => s.id)).toEqual([1, 2]);
		expect(filterSortSeries(items, 'unmonitored', 'name', '').map((s) => s.id)).toEqual([3]);
	});

	it('sorts by completion, missing, added, year, name', () => {
		expect(filterSortSeries(items, 'all', 'completion', '').map((s) => s.id)).toEqual([3, 2, 1]);
		expect(filterSortSeries(items, 'all', 'missing', '').map((s) => s.id)).toEqual([2, 3, 1]);
		expect(filterSortSeries(items, 'all', 'added', '').map((s) => s.id)).toEqual([2, 3, 1]);
		expect(filterSortSeries(items, 'all', 'year', '').map((s) => s.id)).toEqual([2, 1, 3]);
		expect(filterSortSeries(items, 'all', 'name', '').map((s) => s.id)).toEqual([1, 2, 3]);
	});

	it('searches title and network case-insensitively (§27/§85)', () => {
		expect(filterSortSeries(items, 'all', 'name', 'brom').map((s) => s.id)).toEqual([2]);
		const withNetwork = [...items, makeSeries({ id: 4, title: 'Zebra', network: 'HBO Max' })];
		expect(filterSortSeries(withNetwork, 'all', 'name', 'hbo').map((s) => s.id)).toEqual([4]);
	});
});

describe('movie filters and sorts (§36/§156)', () => {
	const items = [
		makeMovie({
			id: 1,
			title: 'Alpha',
			year: 2020,
			hasFile: true,
			quality: 'WEBDL-1080p',
			qualityResolution: 1080
		}),
		makeMovie({
			id: 2,
			title: 'Bravo',
			year: 2024,
			hasFile: false,
			isAvailable: true,
			digitalRelease: Date.now() - 47 * 86_400_000
		}),
		makeMovie({
			id: 3,
			title: 'Charlie',
			year: 2022,
			hasFile: false,
			isAvailable: true,
			digitalRelease: Date.now() - 2 * 86_400_000
		}),
		makeMovie({
			id: 4,
			title: 'Delta',
			year: 2027,
			hasFile: false,
			isAvailable: false,
			monitored: true
		}),
		makeMovie({
			id: 5,
			title: 'Echo',
			year: 2019,
			hasFile: true,
			quality: 'Bluray-2160p',
			qualityResolution: 2160,
			upgradeAvailable: true,
			monitored: false
		})
	];

	it('filters', () => {
		expect(filterSortMovies(items, 'available', 'name', '').map((m) => m.id)).toEqual([1, 5]);
		expect(filterSortMovies(items, 'missing', 'name', '').map((m) => m.id)).toEqual([2, 3]);
		expect(filterSortMovies(items, 'upgrades', 'name', '').map((m) => m.id)).toEqual([5]);
		expect(filterSortMovies(items, 'upcoming', 'name', '').map((m) => m.id)).toEqual([4]);
		expect(filterSortMovies(items, 'monitored', 'name', '').map((m) => m.id)).toEqual([1, 2, 3, 4]);
		expect(filterSortMovies(items, 'unmonitored', 'name', '').map((m) => m.id)).toEqual([5]);
	});

	it('sorts missing by release date both ways (§36)', () => {
		expect(filterSortMovies(items, 'all', 'missing-oldest', '').map((m) => m.id)).toEqual([
			2, 3, 1, 4, 5
		]);
		expect(
			filterSortMovies(
				items.filter((m) => isMovieMissing(m)),
				'all',
				'missing-newest',
				''
			).map((m) => m.id)
		).toEqual([3, 2]);
	});

	it('sorts by quality resolution (§92)', () => {
		const withFiles = items.filter((m) => m.hasFile);
		expect(filterSortMovies(withFiles, 'all', 'quality', '').map((m) => m.id)).toEqual([5, 1]);
	});
});

describe('pagination boundaries (§157/§158)', () => {
	const items = Array.from({ length: 120 }, (_, i) =>
		makeSeries({ id: i + 1, title: `S${i + 1}` })
	);
	it('pages of 0, 1, 50, 100', () => {
		expect(pageOf(items, 50, 0).items).toHaveLength(50);
		expect(pageOf(items, 50, 0).total).toBe(120);
		expect(pageOf(items, 1, 119).items).toHaveLength(1);
		expect(pageOf(items, 100, 100).items).toHaveLength(20);
		expect(pageOf(items, 50, 120).items).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Lazy client endpoints (§75/§80) — request-shape contract tests
// ---------------------------------------------------------------------------

describe('lazy client endpoints', () => {
	it('sonarr episodesBySeries requests the series with files embedded', async () => {
		let seen: URL | null = null;
		const server = http.createServer((req, res) => {
			seen = new URL(req.url ?? '/', 'http://localhost');
			res.setHeader('x-api-key-check', req.headers['x-api-key'] === 'k1' ? 'ok' : 'bad');
			res.end(JSON.stringify([{ id: 1, seriesId: 21, seasonNumber: 3, episodeNumber: 4 }]));
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		const port = typeof address === 'object' && address ? address.port : 0;
		const client = new ArrBaseClient(`http://127.0.0.1:${port}`, 'k1');
		const episodes = await client.episodesBySeries(21);
		expect(episodes).toHaveLength(1);
		expect(seen!.searchParams.get('seriesId')).toBe('21');
		expect(seen!.searchParams.get('includeEpisodeFile')).toBe('true');
		server.close();
	});

	it('bazarr episodesBySeries uses the seriesid[] spelling (audited 1.6.0)', async () => {
		let seen: URL | null = null;
		const server = http.createServer((req, res) => {
			seen = new URL(req.url ?? '/', 'http://localhost');
			res.end(JSON.stringify({ data: [{ sonarrEpisodeId: 51 }], total: 1 }));
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		const port = typeof address === 'object' && address ? address.port : 0;
		const client = new BazarrClient(`http://127.0.0.1:${port}`, 'k2');
		const episodes = await client.episodesBySeries(3);
		expect(episodes).toHaveLength(1);
		expect(seen!.searchParams.get('seriesid[]')).toBe('3');
		expect(seen!.searchParams.get('length')).toBe('-1');
		server.close();
	});

	it('arr history requests a bounded descending page', async () => {
		let seen: URL | null = null;
		const server = http.createServer((req, res) => {
			seen = new URL(req.url ?? '/', 'http://localhost');
			res.end(
				JSON.stringify({ records: [{ eventType: 'grabbed', date: '2026-09-10T00:00:00Z' }] })
			);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const address = server.address();
		const port = typeof address === 'object' && address ? address.port : 0;
		const client = new ArrBaseClient(`http://127.0.0.1:${port}`, 'k3');
		const records = await client.history(20, { movieId: '196' });
		expect(records).toHaveLength(1);
		expect(seen!.searchParams.get('pageSize')).toBe('20');
		expect(seen!.searchParams.get('movieId')).toBe('196');
		expect(seen!.searchParams.get('sortDirection')).toBe('descending');
		server.close();
	});
});
