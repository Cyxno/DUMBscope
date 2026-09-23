/**
 * Download routing statistics tests (observability spec §6): windowed
 * grab/import/failure aggregation per client, primary detection from
 * priorities, and preferred-protocol parsing.
 */
import { describe, expect, it } from 'vitest';
import {
	aggregateRoutingByClient,
	buildRoutingObservability,
	parseDownloadClients,
	parsePreferredProtocol,
	isDownloadFailure
} from '../src/lib/server/integrations/arr/routing';

const HOUR = 3_600_000;

function rec(
	eventType: string,
	client: string,
	hoursAgo: number,
	date = new Date(1_800_000_000_000 - hoursAgo * HOUR)
): {
	eventType: string;
	date: string;
	data: Record<string, string>;
} {
	return {
		eventType,
		date: date.toISOString(),
		data: { downloadClient: client }
	};
}

describe('window aggregation', () => {
	it('counts grabs, imports and failures per client inside the window', () => {
		const now = 1_800_000_000_000;
		const records = [
			rec('grabbed', 'decypharr', 2),
			rec('grabbed', 'decypharr', 3),
			rec('downloadFolderImported', 'decypharr', 1),
			rec('grabbed', 'InfiniDysk', 5),
			rec('downloadFailed', 'InfiniDysk', 6),
			// Outside the 24h window: must be ignored.
			rec('grabbed', 'decypharr', 30)
		];
		const agg = aggregateRoutingByClient(records, 24, now);
		expect(agg.get('decypharr')).toEqual({ grabs: 2, imports: 1, failures: 0 });
		expect(agg.get('InfiniDysk')).toEqual({ grabs: 1, imports: 0, failures: 1 });
	});
});

describe('routing view', () => {
	it('marks the lowest-priority enabled client as primary and computes success rates', () => {
		const now = 1_800_000_000_000;
		const clients = [
			{ name: 'decypharr', protocol: 'torrent', priority: 1, enabled: true },
			{ name: 'InfiniDysk', protocol: 'usenet', priority: 2, enabled: true },
			{ name: 'qBittorrent', protocol: 'torrent', priority: 1, enabled: false }
		];
		const history = [
			rec('grabbed', 'decypharr', 2),
			rec('downloadFolderImported', 'decypharr', 1),
			rec('grabbed', 'InfiniDysk', 5),
			rec('downloadFailed', 'InfiniDysk', 6),
			rec('downloadFolderImported', 'InfiniDysk', 7)
		];
		const view = buildRoutingObservability(clients, history, 'usenet', 24, now);
		expect(view.preferredProtocol).toBe('usenet');
		const decy = view.clients.find((c) => c.client === 'decypharr')!;
		expect(decy.primary).toBe(true); // lowest priority among ENABLED clients
		expect(decy.successRate).toBe(1);
		const infini = view.clients.find((c) => c.client === 'InfiniDysk')!;
		expect(infini.primary).toBe(false);
		expect(infini.successRate).toBeCloseTo(0.5);
	});
});

describe('payload parsing', () => {
	it('parses download clients from the Arr payload', () => {
		const parsed = parseDownloadClients([
			{ name: 'decypharr', protocol: 'torrent', priority: 1, enable: true },
			{ name: 'InfiniDysk', protocol: 'usenet', priority: 2, enable: true },
			{ name: 'broken' }
		]);
		expect(parsed).toHaveLength(3);
		expect(parsed[0]).toEqual({
			name: 'decypharr',
			protocol: 'torrent',
			priority: 1,
			enabled: true
		});
		expect(parsed[2]!.enabled).toBe(false);
		expect(parsed[2]!.protocol).toBeNull();
	});

	it('parses the preferred protocol from delay profiles', () => {
		expect(parsePreferredProtocol([{ preferredProtocol: 'usenet', enableUsenet: true }])).toBe(
			'usenet'
		);
		expect(parsePreferredProtocol({ preferredProtocol: 'torrent' })).toBe('torrent');
		expect(parsePreferredProtocol([{ nope: true }])).toBeNull();
		expect(parsePreferredProtocol(null)).toBeNull();
	});

	it('recognises download failures for the timeline', () => {
		expect(isDownloadFailure({ eventType: 'downloadFailed', data: {} })).toBe(true);
		expect(isDownloadFailure({ eventType: 'grabbed', data: {} })).toBe(false);
	});
});
