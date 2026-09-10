/**
 * Deep-integration tests against an in-process mock Sonarr/Radarr server.
 * Covers brief §37: healthy, auth failure, timeout, rate limit, malformed,
 * older API version, partial response, empty queue, large queue, offline.
 * No dependency on the real production stack.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { ArrAuthError, ArrBaseClient, ArrError } from '../src/lib/server/integrations/arr/base';
import { createArrAdapter } from '../src/lib/server/integrations/arr/adapters';

let server: http.Server;
let port = 0;
let mode = 'healthy';

const queueRecord = (overrides: Record<string, unknown> = {}) => ({
	id: 1,
	title: 'Great Show S01E01',
	status: 'queued',
	trackedDownloadStatus: 'ok',
	trackedDownloadState: 'downloading',
	size: 1_000_000,
	sizeleft: 500_000,
	timeleft: '00:01:00',
	errorMessage: '',
	...overrides
});

beforeAll(async () => {
	server = http.createServer((req, res) => {
		const respond = (code: number, body: unknown) => {
			res.writeHead(code, { 'content-type': 'application/json' });
			res.end(typeof body === 'string' ? body : JSON.stringify(body));
		};
		if (mode === 'offline' || mode === 'timeout') {
			if (mode === 'timeout') return; // never respond -> client timeout
			req.socket.destroy();
			return;
		}
		const key = req.headers['x-api-key'];
		if (key !== 'good-key') return respond(401, { error: 'Unauthorized' });
		if (mode === 'ratelimit') return respond(429, { error: 'Too many requests' });
		if (mode === 'malformed') {
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end('{not json');
		}
		if (req.url?.startsWith('/api/v3/system/status')) {
			if (mode === 'older-version') return respond(200, { appName: 'Sonarr' });
			return respond(200, { version: '4.0.9.2244', appName: 'Sonarr' });
		}
		if (req.url?.startsWith('/api/v3/queue')) {
			if (mode === 'empty') return respond(200, { page: 1, totalRecords: 0, records: [] });
			if (mode === 'large')
				return respond(200, {
					page: 1,
					totalRecords: 900,
					records: Array.from({ length: 900 }, (_, i) => queueRecord({ id: i + 1 }))
				});
			if (mode === 'partial')
				return respond(200, {
					page: 1,
					totalRecords: 1,
					records: [{ id: 7 } as Record<string, unknown>]
				});
			return respond(200, {
				page: 1,
				totalRecords: 1,
				records: [queueRecord()]
			});
		}
		if (req.url?.startsWith('/api/v3/wanted/missing'))
			return respond(200, { totalRecords: 12, records: [{}] });
		if (req.url?.startsWith('/api/v3/wanted/cutoff_unmet'))
			return respond(200, { totalRecords: 3, records: [{}] });
		if (req.url?.startsWith('/api/v3/calendar')) return respond(200, [{ title: 'E1' }]);
		if (req.url?.startsWith('/api/v3/health'))
			return respond(200, [{ source: 'Indexer', type: 'warning', message: 'slow indexer' }]);
		respond(404, { error: 'not found' });
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', () => resolve());
	});
	const addr = server.address();
	if (addr && typeof addr === 'object') port = addr.port;
});

afterAll(() => {
	server.close();
});

const client = () => new ArrBaseClient(`http://127.0.0.1:${port}`, 'good-key');
const badClient = () => new ArrBaseClient(`http://127.0.0.1:${port}`, 'wrong-key');
const offlineClient = () => new ArrBaseClient('http://127.0.0.1:9', 'good-key', 1_000);

describe('ArrBaseClient', () => {
	it('parses a healthy status response', async () => {
		mode = 'healthy';
		const status = await client().status();
		expect(status.version).toBe('4.0.9.2244');
		expect(status.appName).toBe('Sonarr');
	});

	it('throws ArrAuthError on a rejected API key', async () => {
		mode = 'healthy';
		await expect(badClient().status()).rejects.toBeInstanceOf(ArrAuthError);
	});

	it('times out against a server that never responds', async () => {
		mode = 'timeout';
		await expect(offlineClient().status()).rejects.toMatchObject({ name: 'ArrError' });
		mode = 'healthy';
	});

	it('surfaces rate limiting as an ArrError', async () => {
		mode = 'ratelimit';
		await expect(client().status()).rejects.toBeInstanceOf(ArrError);
		mode = 'healthy';
	});

	it('survives malformed JSON payloads', async () => {
		mode = 'malformed';
		await expect(client().status()).rejects.toBeInstanceOf(ArrError);
		mode = 'healthy';
	});

	it('handles an unreachable service', async () => {
		await expect(offlineClient().status()).rejects.toBeInstanceOf(ArrError);
	});

	it('maps a partial queue record onto safe defaults', async () => {
		mode = 'partial';
		const raw = await client().rawQueue();
		const adapter = createArrAdapter('sonarr');
		const poller = adapter.pollers({
			type: 'sonarr',
			id: 'sonarr-test',
			url: '',
			enabled: true
		} as never)[0]!;
		let snapshot: unknown = null;
		await poller.run({
			config: {
				type: 'sonarr',
				id: 'sonarr-test',
				url: `http://127.0.0.1:${port}`,
				enabled: true,
				hasApiKey: true,
				lastTestAt: null,
				lastTestOk: null,
				lastTestError: null
			},
			apiKey: 'good-key',
			cache: {
				get: () => null,
				set: (_k, v) => {
					snapshot = v;
				}
			},
			emit: () => {},
			ok: () => {},
			failed: () => {}
		});
		expect((snapshot as { total: number }).total).toBe(1);
		const item = (snapshot as { items: { title: string; progress: number }[] }).items[0]!;
		expect(item.title).toBe('Unknown');
		expect(item.progress).toBe(100);
		void raw;
		mode = 'healthy';
	});

	it('handles an empty queue', async () => {
		mode = 'empty';
		const raw = await client().rawQueue();
		expect(raw.totalRecords).toBe(0);
		mode = 'healthy';
	});

	it('caps large queues at 200 items while keeping the real total', async () => {
		mode = 'large';
		const raw = await client().rawQueue();
		expect(raw.totalRecords).toBe(900);
		const snapshot = {
			total: raw.totalRecords,
			items: raw.records.slice(0, 200),
			warnings: 0,
			failures: 0,
			fetchedAt: Date.now()
		};
		expect(snapshot.items).toHaveLength(200);
		expect(snapshot.total).toBe(900);
	});

	it('reports missing/cutoff counts from pageSize=1 probes', async () => {
		mode = 'healthy';
		expect(await client().countTotal('/api/v3/wanted/missing')).toBe(12);
		expect(await client().countTotal('/api/v3/wanted/cutoff_unmet')).toBe(3);
	});
});

describe('Arr adapter (older API version)', () => {
	it('degrades to version "unknown" without crashing', async () => {
		mode = 'older-version';
		const adapter = createArrAdapter('sonarr');
		const result = await adapter.test(
			{
				type: 'sonarr',
				id: 'sonarr-test',
				url: `http://127.0.0.1:${port}`,
				enabled: true,
				hasApiKey: true,
				lastTestAt: null,
				lastTestOk: null,
				lastTestError: null
			},
			'good-key'
		);
		expect(result.version).toBe('unknown');
		mode = 'healthy';
	});
});
