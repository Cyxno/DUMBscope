/**
 * Library poller normalization tests against an in-process mock Radarr/
 * Sonarr surface (brief §75: queue normalization, upgrade semantics).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { ArrBaseClient } from '../src/lib/server/integrations/arr/base';
import { fetchArrLibrary } from '../src/lib/server/integrations/media';

let server: http.Server;
let port = 0;

const moviesFixture = [
	{
		id: 1,
		title: 'Released Present',
		year: 2024,
		monitored: true,
		hasFile: true,
		isAvailable: true,
		digitalRelease: '2024-06-01T00:00:00Z'
	},
	{
		id: 2,
		title: 'Released Missing Old',
		year: 2019,
		monitored: true,
		hasFile: false,
		isAvailable: true,
		digitalRelease: new Date(Date.now() - 47 * 86_400_000).toISOString()
	},
	{
		id: 3,
		title: 'Released Missing Recent',
		year: 2025,
		monitored: true,
		hasFile: false,
		isAvailable: true,
		digitalRelease: new Date(Date.now() - 2 * 86_400_000).toISOString()
	},
	{
		id: 4,
		title: 'Upcoming Blockbuster',
		year: 2027,
		monitored: true,
		hasFile: false,
		isAvailable: false,
		digitalRelease: '2027-06-01T00:00:00Z'
	}
];

const seriesFixture = [
	{
		id: 1,
		title: 'Show A',
		monitored: true,
		statistics: { episodeFileCount: 20, episodeCount: 22, totalEpisodeCount: 24, sizeOnDisk: 5e9 }
	},
	{
		id: 2,
		title: 'Show B',
		monitored: true,
		statistics: { episodeFileCount: 10, episodeCount: 12, totalEpisodeCount: 12, sizeOnDisk: 3e9 }
	}
];

const OLD = Date.now() - 47 * 86_400_000;
const RECENT = Date.now() - 2 * 86_400_000;

function sonarrWantedMissing() {
	// Sonarr view: episode records with series expansion (includeSeries=true).
	return {
		totalRecords: 3,
		records: [
			{
				id: 101,
				seriesId: 1,
				series: { id: 1, title: 'Show A' },
				seasonNumber: 2,
				episodeNumber: 4,
				airDateUtc: new Date(OLD).toISOString(),
				monitored: true,
				hasFile: false,
				lastSearchTime: null
			},
			{
				id: 102,
				seriesId: 2,
				series: { id: 2, title: 'Show B' },
				seasonNumber: 1,
				episodeNumber: 9,
				airDateUtc: new Date(RECENT).toISOString(),
				monitored: true,
				hasFile: false,
				lastSearchTime: null
			},
			{
				id: 103,
				seriesId: 1,
				series: { id: 1, title: 'Show A' },
				seasonNumber: 2,
				episodeNumber: 5,
				airDateUtc: new Date(OLD).toISOString(),
				monitored: true,
				hasFile: false,
				lastSearchTime: null
			}
		]
	};
}

function radarrWantedMissing() {
	// Radarr view: movie records, title-first, with availability flags.
	return {
		totalRecords: 3,
		records: [
			{
				id: 2,
				title: 'Released Missing Old',
				year: 2019,
				monitored: true,
				hasFile: false,
				isAvailable: true,
				digitalRelease: new Date(OLD).toISOString()
			},
			{
				id: 3,
				title: 'Released Missing Recent',
				year: 2025,
				monitored: true,
				hasFile: false,
				isAvailable: true,
				digitalRelease: new Date(RECENT).toISOString()
			},
			{
				id: 4,
				title: 'Upcoming Blockbuster',
				year: 2027,
				monitored: true,
				hasFile: false,
				isAvailable: false,
				digitalRelease: '2027-06-01T00:00:00Z'
			}
		]
	};
}

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		if (req.headers['x-api-key'] !== 'k') {
			res.writeHead(401).end();
			return;
		}
		if (url.pathname === '/api/v3/movie') return json(res, moviesFixture);
		if (url.pathname === '/api/v3/series') return json(res, seriesFixture);
		if (url.pathname === '/api/v3/wanted/missing') {
			const includeSeries = url.searchParams.get('includeSeries');
			// Radarr must never receive the Sonarr-only includeSeries param.
			if (includeSeries !== null && process.env.FAIL_ON_INCLUDE_SERIES === '1') {
				res.writeHead(400).end();
				return;
			}
			return json(res, includeSeries !== null ? sonarrWantedMissing() : radarrWantedMissing());
		}
		if (url.pathname === '/api/v3/wanted/cutoff')
			return json(res, { totalRecords: 9, records: [] });
		res.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const addr = server.address();
	if (addr && typeof addr === 'object') port = addr.port;
});

afterAll(() => server.close());

const json = (res: http.ServerResponse, body: unknown) => {
	res.writeHead(200, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
};

describe('radarr library fetch', () => {
	it('normalizes totals, exact missing, upcoming exclusion and backlog ages', async () => {
		const client = new ArrBaseClient(`http://127.0.0.1:${port}`, 'k');
		const data = await fetchArrLibrary('radarr', client);

		expect(data.movies).toBeTruthy();
		expect(data.movies!.moviesTotal).toBe(4);
		expect(data.movies!.moviesMonitored).toBe(4);
		// Exact released monitored missing: 2 (upcoming excluded, §8/§13).
		expect(data.movies!.monitoredMissing).toBe(2);
		expect(data.movies!.completionPct).toBe(33.3);

		const statuses = data.missing.map((m) => m.status);
		expect(statuses).toContain('missing');
		expect(statuses).toContain('upcoming');

		// Backlog ages (derived here via the aggregate helper on the normalized
		// missing items — the service layer performs the same computation).
		const releasedMissing = data.missing.filter(
			(m) => m.kind === 'movie' && m.status === 'missing'
		);
		const buckets = releasedMissing.map((m) => m.ageBucket).sort();
		expect(buckets).toEqual(['1-7d', '30d+']);
	});
});

describe('sonarr library fetch', () => {
	it('computes per-series missing aggregates and completion', async () => {
		const client = new ArrBaseClient(`http://127.0.0.1:${port}`, 'k');
		const data = await fetchArrLibrary('sonarr', client);

		expect(data.tv).toBeTruthy();
		expect(data.tv!.seriesTotal).toBe(2);
		// wanted/missing totalRecords drives the exact missing count: the
		// fixture returns 3 records for both kinds.
		expect(data.tv!.monitoredMissing).toBe(3);
		// released monitored = 22 + 12 = 34 → completion = (34-3)/34 = 91.2%
		expect(data.tv!.completionPct).toBe(91.2);
		expect(data.tv!.series!.map((s) => [s.title, s.missing])).toEqual([
			['Show A', 2],
			['Show B', 1]
		]);
	});
});
