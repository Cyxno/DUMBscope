import { jsonOk } from '$lib/server/security/validation';
import { getIntegrationCache, listIntegrationTypes } from '$lib/server/integrations/manager';
import { ensureIntegrationsUp } from '$lib/server/integrations/register';
import type { RequestHandler } from './$types';

interface QueueItem {
	id: number;
	title: string;
	status: string;
	trackedDownloadStatus: string;
	trackedDownloadState: string;
	progress: number;
	timeLeft: string | null;
	errorMessage: string | null;
}

const FILTERS = ['all', 'tv', 'movies', 'issues'];

/** GET /api/library/queue — combined Sonarr/Radarr queue (§26/§38). */
export const GET: RequestHandler = async ({ url }) => {
	ensureIntegrationsUp();
	const filterRaw = url.searchParams.get('filter') ?? 'all';
	const filter = FILTERS.includes(filterRaw) ? filterRaw : 'all';
	const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 50) || 50));

	type Source = {
		type: string;
		integrationId: string;
		items: QueueItem[];
		failures: number;
		warnings: number;
		total: number;
	};
	const sources: Source[] = [];
	for (const info of listIntegrationTypes()) {
		if (info.type !== 'sonarr' && info.type !== 'radarr') continue;
		if (!info.enabled) continue;
		const cache = getIntegrationCache(info.id) as {
			queue?: { total: number; items: QueueItem[]; failures: number; warnings: number };
		};
		if (!cache.queue) continue;
		sources.push({
			type: info.type,
			integrationId: info.id,
			items: cache.queue.items ?? [],
			failures: cache.queue.failures ?? 0,
			warnings: cache.queue.warnings ?? 0,
			total: cache.queue.total ?? 0
		});
	}

	let items: (QueueItem & { source: string; integrationId: string })[] = [];
	for (const source of sources) {
		let mapped = source.items.map((item) => ({
			...item,
			source: source.type,
			integrationId: source.integrationId
		}));
		if (filter === 'issues')
			mapped = mapped.filter(
				(i) => i.trackedDownloadStatus === 'failure' || i.trackedDownloadStatus === 'warning'
			);
		else if (filter === 'tv') mapped = mapped.filter((i) => i.integrationId.startsWith('sonarr'));
		else if (filter === 'movies')
			mapped = mapped.filter((i) => i.integrationId.startsWith('radarr'));
		items.push(...mapped);
	}
	const total = items.length;
	items = items.slice(0, limit);

	return jsonOk({
		filter,
		total,
		limit,
		items,
		sources: sources.map((s) => ({
			type: s.type,
			integrationId: s.integrationId,
			total: s.total,
			failures: s.failures,
			warnings: s.warnings
		}))
	});
};
