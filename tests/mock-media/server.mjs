#!/usr/bin/env node
/**
 * Mock Sonarr/Radarr/Bazarr servers for library-intelligence e2e tests.
 * One process per role (MOCK_ROLE=sonarr|radarr|bazarr, MOCK_PORT=…).
 *
 * Data is coherent (brief §99): TV ~97% complete with 14 missing episodes in
 * mixed backlog-age buckets and 1 failed import; Movies ~92% complete with
 * 3 released missing + 2 upcoming; Bazarr with 19 episode + 4 movie subtitle
 * gaps (Dutch-heavy). Read-only GET surface only; requires the API key.
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 4211);
const ROLE = process.env.MOCK_ROLE || 'sonarr';
const API_KEY = process.env.MOCK_MEDIA_KEY || 'media-test-key';

const json = (res, body, code = 200) => {
	res.writeHead(code, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
};

const series = [
	{ id: 1, title: 'Anne of Avonlea', epCount: 40, fileCount: 40, missing: 0 },
	{ id: 2, title: 'Blue Harbor', epCount: 30, fileCount: 30, missing: 0 },
	{ id: 3, title: 'Coastline', epCount: 25, fileCount: 25, missing: 0 },
	{ id: 4, title: 'Dark Meadow', epCount: 45, fileCount: 42, missing: 3 },
	{ id: 5, title: 'Ember Lane', epCount: 20, fileCount: 20, missing: 0 },
	{ id: 6, title: 'Foxglove', epCount: 60, fileCount: 56, missing: 4 },
	{ id: 7, title: 'Granite Peak', epCount: 35, fileCount: 35, missing: 0 },
	{ id: 8, title: 'Hollow Ridge', epCount: 50, fileCount: 50, missing: 0 },
	{ id: 9, title: 'Ivory Tower', epCount: 28, fileCount: 28, missing: 0 },
	{ id: 10, title: 'Juniper Falls', epCount: 22, fileCount: 19, missing: 3 },
	{ id: 11, title: 'Kestrel Sky', epCount: 44, fileCount: 42, missing: 2 },
	{ id: 12, title: 'Lighthouse Bay', epCount: 36, fileCount: 36, missing: 2 }
];
// 14 missing episodes total across 5 series; ages spread across buckets.
const missingEpisodes = [
	{ id: 101, seriesId: 4, seriesTitle: 'Dark Meadow', season: 2, episode: 7, ageDays: 40 },
	{ id: 102, seriesId: 4, seriesTitle: 'Dark Meadow', season: 2, episode: 8, ageDays: 40 },
	{ id: 103, seriesId: 4, seriesTitle: 'Dark Meadow', season: 2, episode: 9, ageDays: 38 },
	{ id: 104, seriesId: 6, seriesTitle: 'Foxglove', season: 3, episode: 3, ageDays: 35 },
	{ id: 105, seriesId: 6, seriesTitle: 'Foxglove', season: 3, episode: 5, ageDays: 33 },
	{ id: 106, seriesId: 6, seriesTitle: 'Foxglove', season: 3, episode: 6, ageDays: 31 },
	{ id: 107, seriesId: 6, seriesTitle: 'Foxglove', season: 3, episode: 9, ageDays: 31 },
	{ id: 108, seriesId: 10, seriesTitle: 'Juniper Falls', season: 1, episode: 5, ageDays: 12 },
	{ id: 109, seriesId: 10, seriesTitle: 'Juniper Falls', season: 1, episode: 6, ageDays: 10 },
	{ id: 110, seriesId: 10, seriesTitle: 'Juniper Falls', season: 1, episode: 7, ageDays: 8 },
	{ id: 111, seriesId: 11, seriesTitle: 'Kestrel Sky', season: 4, episode: 2, ageDays: 5 },
	{ id: 112, seriesId: 11, seriesTitle: 'Kestrel Sky', season: 4, episode: 4, ageDays: 4 },
	{ id: 113, seriesId: 12, seriesTitle: 'Lighthouse Bay', season: 2, episode: 1, ageDays: 0.4 },
	{ id: 114, seriesId: 12, seriesTitle: 'Lighthouse Bay', season: 2, episode: 2, ageDays: 0.2 }
];

const movies = [
	{ id: 1, title: 'Aurora Protocol', year: 2019, hasFile: true, isAvailable: true },
	{ id: 2, title: 'Bright Horizon', year: 2021, hasFile: true, isAvailable: true },
	{ id: 3, title: 'Crimson Tide Rising', year: 2018, hasFile: true, isAvailable: true },
	{ id: 4, title: 'Distant Shores', year: 2020, hasFile: false, isAvailable: true, ageDays: 47 },
	{ id: 5, title: 'Electric Sky', year: 2022, hasFile: false, isAvailable: true, ageDays: 55 },
	{ id: 6, title: 'Falling Stars', year: 2023, hasFile: false, isAvailable: true, ageDays: 3 },
	{ id: 7, title: 'Gentle Rain', year: 2024, hasFile: true, isAvailable: true }
];
// Pad to 40 movies, all with files.
for (let i = 8; i <= 40; i++) {
	movies.push({
		id: i,
		title: `Library Movie ${i}`,
		year: 2000 + i,
		hasFile: true,
		isAvailable: true
	});
}
// 2 upcoming (not yet available), excluded from backlog.
movies.push({
	id: 41,
	title: 'Next Year Blockbuster',
	year: 2027,
	hasFile: false,
	isAvailable: false,
	digital: '2027-06-01'
});
movies.push({
	id: 42,
	title: 'Unreleased Sequel',
	year: 2027,
	hasFile: false,
	isAvailable: false,
	digital: '2027-08-15'
});

// Release-QA additions: XSS-shaped titles must render as plain text (§28).
series.push({
	id: 13,
	title: '<img src=x onerror=alert(1)>',
	epCount: 10,
	fileCount: 10,
	missing: 0
});
movies.push({
	id: 43,
	title: '<script>alert(1)</script>',
	year: 2024,
	hasFile: true,
	isAvailable: true
});

// Minimal valid 1x1 PNG served by the MediaCover endpoints (§60).
const POSTER_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64'
);

function servePoster(res, id) {
	if (id === 999) {
		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end('not found');
		return;
	}
	if (id === 998) {
		// Wrong MIME on purpose: the proxy must reject it (§60/§24).
		res.writeHead(200, { 'content-type': 'text/plain' });
		res.end('definitely not an image');
		return;
	}
	res.writeHead(200, { 'content-type': 'image/png' });
	res.end(POSTER_PNG);
}

/** Per-series episode records with embedded files, mirroring the real counts. */
function sonarrEpisodes(seriesId) {
	const s = series.find((x) => x.id === seriesId);
	if (!s) return [];
	const future = 2;
	const out = [];
	for (let n = 1; n <= s.epCount + future; n++) {
		const hasFile = n <= s.fileCount;
		const isFuture = n > s.epCount;
		out.push({
			id: seriesId * 1000 + n,
			seriesId,
			seasonNumber: 1,
			episodeNumber: n,
			title: `Episode ${n}`,
			monitored: true,
			hasFile,
			airDateUtc: new Date(
				Date.now() + (isFuture ? (n - s.epCount) * 7 * 86_400_000 : -n * 3 * 86_400_000)
			).toISOString(),
			...(hasFile
				? {
						episodeFile: {
							id: seriesId * 1000 + n,
							size: 2_300_000_000,
							quality: {
								quality: {
									id: 8,
									name: n % 4 === 0 ? 'WEBDL-2160p' : 'WEBDL-1080p',
									source: 'web',
									resolution: n % 4 === 0 ? 2160 : 1080
								},
								revision: { version: 1, real: 0, isRepack: false }
							},
							releaseGroup: seriesId === 13 ? '<b>MOCK</b>' : 'MOCK',
							dateAdded: new Date(Date.now() - n * 86_400_000).toISOString(),
							languages: [{ id: 1, name: 'English' }],
							customFormats: [],
							sceneName: `mock.s01e${String(n).padStart(2, '0')}.1080p`,
							qualityCutoffNotMet: n % 3 === 0
						}
					}
				: {})
		});
	}
	return out;
}

function authorize(req, res) {
	if (req.headers['x-api-key'] !== API_KEY) {
		res.writeHead(401, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized' }));
		return false;
	}
	return true;
}

const sonarrHandler = (req, res, url) => {
	if (!authorize(req, res)) return;
	if (url.pathname === '/api/v3/system/status')
		return json(res, { version: '4.0.0.1100', appName: 'Sonarr' });
	if (url.pathname === '/api/v3/series')
		return json(
			res,
			series.map((s) => ({
				id: s.id,
				title: s.title,
				sortTitle: s.title.toLowerCase(),
				monitored: true,
				status: 'continuing',
				network: 'MOCK TV',
				runtime: 42,
				genres: ['Drama'],
				seriesType: 'standard',
				qualityProfileId: 7,
				added: new Date(Date.now() - 30 * 86_400_000).toISOString(),
				path: `/media/series/mock-${s.id}`,
				images: [
					{
						coverType: 'poster',
						url: `/MediaCover/${s.id}/poster.jpg?lastWrite=1000`,
						remoteUrl: `https://mock.local/poster-${s.id}.jpg`
					}
				],
				seasons: [
					{
						seasonNumber: 1,
						monitored: true,
						statistics: {
							episodeFileCount: s.fileCount,
							episodeCount: s.epCount,
							totalEpisodeCount: s.epCount,
							sizeOnDisk: s.fileCount * 1_400_000_000
						}
					}
				],
				statistics: {
					seasonCount: 1,
					episodeFileCount: s.fileCount,
					episodeCount: s.epCount,
					totalEpisodeCount: s.epCount,
					sizeOnDisk: s.fileCount * 1_400_000_000,
					percentOfEpisodes: Math.round((s.fileCount / s.epCount) * 1000) / 10
				}
			}))
		);
	if (url.pathname === '/api/v3/wanted/missing') {
		const includeSeries = url.searchParams.get('includeSeries') === 'true';
		const page = Number(url.searchParams.get('page') ?? 1);
		const pageSize = Number(url.searchParams.get('pageSize') ?? 100);
		const start = (page - 1) * pageSize;
		const slice = missingEpisodes.slice(start, start + pageSize).map((e) => ({
			id: e.id,
			seriesId: e.seriesId,
			series: includeSeries ? { id: e.seriesId, title: e.seriesTitle } : undefined,
			seasonNumber: e.season,
			episodeNumber: e.episode,
			title: `${e.seriesTitle} S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`,
			airDateUtc: new Date(Date.now() - e.ageDays * 86_400_000).toISOString(),
			monitored: true,
			hasFile: false,
			lastSearchTime: null
		}));
		return json(res, { page, pageSize, totalRecords: missingEpisodes.length, records: slice });
	}
	if (url.pathname === '/api/v3/wanted/cutoff')
		return json(res, { page: 1, totalRecords: 21, records: [] });
	if (url.pathname === '/api/v3/queue')
		return json(res, {
			page: 1,
			totalRecords: 1,
			records: [
				{
					id: 9001,
					title: 'Dark Meadow S02E10',
					status: 'completed',
					trackedDownloadStatus: 'failure',
					trackedDownloadState: 'importBlocked',
					size: 1_200_000_000,
					sizeleft: 0,
					timeleft: null,
					errorMessage: 'Import failed: sample matches quality profile restrictions',
					series: { title: 'Dark Meadow' }
				}
			]
		});
	if (url.pathname === '/api/v3/health')
		return json(res, [
			{
				source: 'DownloadClient',
				type: 'DownloadClientUnavailable',
				message: 'Download client InfiniDysk places down'
			}
		]);
	if (url.pathname === '/api/v3/calendar') return json(res, []);
	if (url.pathname === '/api/v3/qualityprofile')
		return json(res, [
			{ id: 1, name: 'Any' },
			{ id: 7, name: 'Mock HD 1080p' }
		]);
	if (url.pathname === '/api/v3/episode') {
		const seriesId = Number(url.searchParams.get('seriesId') ?? 0);
		return json(res, sonarrEpisodes(seriesId));
	}
	if (url.pathname === '/api/v3/history') {
		const pageSize = Number(url.searchParams.get('pageSize') ?? 10);
		// One event per series; the Sonarr history endpoint ignores seriesId
		// filters (audited), so the caller must filter server-side.
		const records = series.map((s) => ({
			eventType: 'grabbed',
			date: new Date(Date.now() - 3_600_000).toISOString(),
			seriesId: s.id,
			episodeId: s.id * 1000 + 1,
			sourceTitle: 'Mock.Series.S01E01.1080p.MOCK',
			quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } }
		}));
		return json(res, {
			page: 1,
			pageSize,
			totalRecords: records.length,
			records: records.slice(0, pageSize)
		});
	}
	if (url.pathname.startsWith('/api/v3/MediaCover/')) {
		servePoster(res, Number(url.pathname.split('/')[4]));
		return;
	}
	res.writeHead(404).end();
};

const radarrHandler = (req, res, url) => {
	if (!authorize(req, res)) return;
	if (url.pathname === '/api/v3/system/status')
		return json(res, { version: '5.14.0', appName: 'Radarr' });
	if (url.pathname === '/api/v3/movie')
		return json(
			res,
			movies.map((m) => ({
				id: m.id,
				title: m.title,
				sortTitle: m.title.toLowerCase(),
				year: m.year,
				monitored: true,
				status: 'released',
				hasFile: !!m.hasFile,
				isAvailable: !!m.isAvailable,
				digitalRelease: m.isAvailable
					? new Date(Date.now() - (m.ageDays ?? 400) * 86_400_000).toISOString()
					: (m.digital ?? null),
				inCinemas: null,
				sizeOnDisk: m.hasFile ? 6_000_000_000 : 0,
				runtime: 110,
				studio: 'Mock Studios',
				certification: 'PG-13',
				qualityProfileId: 7,
				images: [
					{
						coverType: 'poster',
						url: `/MediaCover/${m.id}/poster.jpg?lastWrite=1000`,
						remoteUrl: `https://mock.local/poster-${m.id}.jpg`
					}
				],
				...(m.hasFile
					? {
							movieFile: {
								id: m.id,
								size: 3_400_000_000,
								quality: {
									quality: { id: 8, name: 'WEBDL-1080p', source: 'web', resolution: 1080 },
									revision: { version: 1, real: 0, isRepack: false }
								},
								releaseGroup: m.id === 43 ? '<i>MOCK</i>' : 'MOCK',
								dateAdded: new Date(Date.now() - 5 * 86_400_000).toISOString(),
								languages: [{ id: 1, name: 'English' }],
								customFormats: [],
								qualityCutoffNotMet: m.id % 5 === 0
							}
						}
					: {})
			}))
		);
	if (url.pathname === '/api/v3/wanted/missing') {
		const releasedMissing = movies.filter(
			(m) => m.monitored !== false && !m.hasFile && m.isAvailable
		);
		const records = releasedMissing.map((m) => ({
			id: m.id,
			title: m.title,
			year: m.year,
			monitored: true,
			hasFile: false,
			isAvailable: true,
			digitalRelease: new Date(Date.now() - (m.ageDays ?? 400) * 86_400_000).toISOString(),
			inCinemas: null
		}));
		return json(res, { page: 1, totalRecords: records.length, records });
	}
	if (url.pathname === '/api/v3/wanted/cutoff')
		return json(res, { page: 1, totalRecords: 9, records: [] });
	if (url.pathname === '/api/v3/queue') return json(res, { page: 1, totalRecords: 0, records: [] });
	if (url.pathname === '/api/v3/health') return json(res, []);
	if (url.pathname === '/api/v3/qualityprofile')
		return json(res, [
			{ id: 1, name: 'Any' },
			{ id: 7, name: 'Mock HD 1080p' }
		]);
	if (url.pathname === '/api/v3/history') {
		// Mixed movieIds in one page, deliberately ignoring any movieId query —
		// mirrors Radarr 6.3.0 (§58): the caller must filter server-side and
		// events for movie B must never surface under movie A.
		const mk = (movieId, eventType, offsetHours) => ({
			eventType,
			date: new Date(Date.now() - offsetHours * 3_600_000).toISOString(),
			movieId,
			sourceTitle: `Mock.Movie.${movieId}.1080p.MOCK`,
			quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } }
		});
		return json(res, {
			page: 1,
			pageSize: 10,
			totalRecords: 4,
			records: [
				mk(2, 'grabbed', 1),
				mk(1, 'downloadFolderImported', 2),
				mk(2, 'grabbed', 3),
				mk(1, 'grabbed', 4)
			]
		});
	}
	if (url.pathname.startsWith('/api/v3/MediaCover/')) {
		servePoster(res, Number(url.pathname.split('/')[4]));
		return;
	}
	res.writeHead(404).end();
};

const bazarrHandler = (req, res, url) => {
	if (!authorize(req, res)) return;
	if (url.pathname === '/api/system/status')
		return json(res, {
			data: { bazarr_version: '1.5.0', sonarr_version: '4.0.0', radarr_version: '5.14.0' }
		});
	if (url.pathname === '/api/badges')
		return json(res, {
			episodes: 19,
			movies: 4,
			providers: 2,
			status: 0,
			sonarr_signalr: 'LIVE',
			radarr_signalr: 'LIVE'
		});
	if (url.pathname === '/api/system/languages')
		return json(res, [
			{ name: 'Dutch', code2: 'nl', code3: 'nld', enabled: true },
			{ name: 'English', code2: 'en', code3: 'eng', enabled: true },
			{ name: 'French', code2: 'fr', code3: 'fra', enabled: false }
		]);
	if (url.pathname === '/api/system/languages/profiles')
		return json(res, [
			{
				profileId: 1,
				name: 'English + Dutch',
				cutoff: 2,
				items: [
					{ id: 1, language: 'en', audio_exclude: 'False', hi: 'False', forced: 'False' },
					{ id: 2, language: 'nl', audio_exclude: 'False', hi: 'False', forced: 'False' }
				],
				mustContain: []
			}
		]);
	if (url.pathname === '/api/episodes') {
		const ids = url.searchParams.getAll('seriesid[]').map(Number);
		const now = Date.now();
		const data = [];
		for (const sid of ids) {
			for (const ep of sonarrEpisodes(sid)) {
				const isFuture = Date.parse(ep.airDateUtc) > now;
				data.push({
					sonarrSeriesId: sid,
					sonarrEpisodeId: ep.id,
					season: ep.seasonNumber,
					episode: ep.episodeNumber,
					title: ep.title,
					monitored: true,
					subtitles: ep.hasFile
						? [
								{
									code2: 'nl',
									name: 'Dutch',
									forced: false,
									hi: false,
									provider: 'opensubtitlescom'
								},
								{
									code2: 'en',
									name: 'English',
									forced: false,
									hi: true,
									provider: sid === 13 ? '"><script>' : 'opensubtitlescom'
								}
							]
						: [],
					missing_subtitles:
						ep.hasFile || isFuture ? [] : [{ code2: 'nl', name: 'Dutch', forced: false, hi: false }]
				});
			}
		}
		return json(res, { data, total: data.length });
	}
	if (url.pathname === '/api/episodes/history')
		return json(res, {
			total: 1,
			data: [
				{
					action: 1,
					description: 'Dutch subtitles downloaded from opensubtitlescom with a score of 93.61%.',
					sonarrSeriesId: 4,
					sonarrEpisodeId: 4001,
					timestamp: '2 hours ago'
				}
			]
		});
	if (url.pathname === '/api/movies/history')
		return json(res, {
			total: 1,
			data: [
				{
					action: 3,
					description: 'English subtitles upgraded from embeddedsubtitles with a score of 100.0%.',
					radarrId: 4,
					title: 'Distant Shores',
					timestamp: '3 days ago'
				}
			]
		});
	if (url.pathname === '/api/movies') {
		const start = Number(url.searchParams.get('start') ?? 0);
		const length = Number(url.searchParams.get('length') ?? -1);
		const data = movies.map((m) => {
			const isGap = [4, 5, 6, 7].includes(m.id);
			return {
				title: m.title,
				year: m.year,
				monitored: true,
				radarrId: m.id,
				subtitles: isGap
					? [{ name: 'English', code2: 'en', code3: 'eng' }]
					: [
							{ name: 'English', code2: 'en', code3: 'eng' },
							{ name: 'Dutch', code2: 'nl', code3: 'nld' }
						],
				missing_subtitles: isGap
					? [{ name: 'Dutch', code2: 'nl', code3: 'nld', forced: false, hi: false }]
					: []
			};
		});
		return json(res, {
			data: length === -1 ? data : data.slice(start, start + length),
			total: data.length
		});
	}
	if (url.pathname === '/api/series') {
		const start = Number(url.searchParams.get('start') ?? 0);
		const length = Number(url.searchParams.get('length') ?? -1);
		const data = series.map((s) => ({
			title: s.title,
			monitored: true,
			episodeMissingCount: s.missing > 0 ? Math.max(1, Math.round(s.missing / 2)) : 0,
			episodeFileCount: s.fileCount,
			episodeCount: s.epCount,
			sonarrSeriesId: s.id,
			tvdbId: 1000 + s.id
		}));
		return json(res, {
			data: length === -1 ? data : data.slice(start, start + length),
			total: data.length
		});
	}
	if (url.pathname === '/api/movies/wanted') {
		const gaps = movies.filter((m) => [4, 5, 6, 7].includes(m.id));
		return json(res, {
			data: gaps.map((m) => ({
				title: m.title,
				year: m.year,
				radarrId: m.id,
				missing_subtitles: [{ name: 'Dutch', code2: 'nl', code3: 'nld', forced: false, hi: false }]
			})),
			total: gaps.length
		});
	}
	res.writeHead(404).end();
};

const handlers = { sonarr: sonarrHandler, radarr: radarrHandler, bazarr: bazarrHandler };
const handler = handlers[ROLE];
if (!handler) {
	console.error(`[mock-media] unknown role ${ROLE}`);
	process.exit(1);
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
	if (url.pathname === '/health') return json(res, { ok: true });
	console.error(`[mock-media ${ROLE}] ${req.method} ${url.pathname}${url.search}`);
	handler(req, res, url);
});
server.listen(PORT, () =>
	console.log(`[mock-media] ${ROLE} listening on http://127.0.0.1:${PORT}`)
);
