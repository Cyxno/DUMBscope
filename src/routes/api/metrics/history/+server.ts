import { jsonOk } from '$lib/server/security/validation';
import { getHub } from '$lib/server/telemetry/hub';
import type { MetricsHistoryPoint } from '$lib/types';
import type { RequestHandler } from './$types';

/**
 * Metrics history for charts: the in-memory ring for recent data, optionally
 * extended with DUMB's own history series for longer ranges.
 */
export const GET: RequestHandler = async ({ url }) => {
	const hub = getHub();
	const hours = Math.min(24, Math.max(0.25, Number(url.searchParams.get('hours') ?? 1)));
	const maxPoints = Math.min(1440, Math.max(60, Number(url.searchParams.get('points') ?? 600)));

	if (hours <= 1) {
		return jsonOk({ source: 'local', points: hub.getMetricsHistory(maxPoints) });
	}

	const client = hub.getClient();
	if (!client) return jsonOk({ source: 'local', points: hub.getMetricsHistory(maxPoints) });

	try {
		const since = Date.now() / 1000 - hours * 3600;
		const series = (await client.metricsHistorySeries({
			since,
			maxPoints
		})) as {
			items?: {
				timestamp?: unknown;
				cpu?: { percent?: number };
				memory?: { percent?: number };
				disk?: { percent?: number };
			}[];
			timestamps?: unknown[];
		};

		let points: MetricsHistoryPoint[] = [];
		if (Array.isArray(series.items)) {
			points = series.items.map((item) => ({
				t:
					(typeof item.timestamp === 'number'
						? item.timestamp
						: Date.parse(String(item.timestamp ?? '')) / 1000) * 1000,
				cpu: item.cpu?.percent ?? null,
				mem: item.memory?.percent ?? null,
				disk: item.disk?.percent ?? null
			}));
		}
		return jsonOk({ source: 'dumb', points });
	} catch (err) {
		// Degrade to the local ring instead of failing the chart.
		void err;
		return jsonOk({ source: 'local', points: hub.getMetricsHistory(maxPoints) });
	}
};
