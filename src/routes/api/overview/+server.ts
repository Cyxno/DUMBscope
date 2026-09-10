import { jsonOk } from '$lib/server/security/validation';
import { getHub } from '$lib/server/telemetry/hub';
import { getIntegrationCache, getIntegrationStatuses } from '$lib/server/integrations/manager';
import { listActivity } from '$lib/server/integrations/activity';
import type { RequestHandler } from './$types';

interface ArrQueueSnapshot {
	total: number;
	items: { trackedDownloadStatus: string; status: string }[];
	warnings: number;
	failures: number;
}

/**
 * One aggregation endpoint for the Overview bento (brief §4/§24/§54): the
 * browser reads DUMBscope state; cards for unconfigured integrations are
 * simply absent from the response instead of rendering as errors.
 */
export const GET: RequestHandler = async () => {
	const hub = getHub();
	const services = hub.getServices();

	const statuses = getIntegrationStatuses();
	const cache = new Map(
		statuses.map((s) => [s.id, getIntegrationCache(s.id) as Record<string, unknown>])
	);
	const byType = (type: string) =>
		statuses
			.filter((s) => s.type === type)
			.map((s) => ({ id: s.id, state: s.state, data: cache.get(s.id) ?? {} }));

	// Acquisition: combined Sonarr + Radarr queue/wanted.
	const arrs = [...byType('sonarr'), ...byType('radarr')];
	let acquisition: object | null = null;
	if (arrs.some((a) => a.state === 'connected' && (a.data as { queue?: unknown }).queue)) {
		let active = 0;
		let queued = 0;
		let importIssues = 0;
		let wanted = 0;
		let cutoff = 0;
		for (const arr of arrs) {
			const queue = (arr.data as { queue?: ArrQueueSnapshot }).queue;
			if (queue) {
				active += queue.items.filter((i) => i.status === 'downloading').length;
				queued += Math.max(0, queue.total - queue.items.length);
				importIssues += queue.failures + queue.warnings;
			}
			const wantedData = (arr.data as { wanted?: { missing?: number; cutoffUnmet?: number } })
				.wanted;
			if (wantedData) {
				wanted += wantedData.missing ?? 0;
				cutoff += wantedData.cutoffUnmet ?? 0;
			}
		}
		acquisition = { active, queued, importIssues, wanted, cutoffUnmet: cutoff };
	}

	// Indexers: Prowlarr.
	let indexers: object | null = null;
	for (const p of byType('prowlarr')) {
		const data = (
			p.data as { indexers?: { indexers?: number; testFailures?: number; warnings?: number } }
		).indexers;
		if (p.state === 'connected' && data) {
			indexers = {
				healthy: (data.indexers ?? 0) - (data.testFailures ?? 0),
				failed: data.testFailures ?? 0,
				warnings: data.warnings ?? 0
			};
		}
	}

	// Media sessions: Plex (or Tautulli enrichment when Plex is absent).
	let media: object | null = null;
	for (const p of byType('plex')) {
		const sessions = (
			p.data as {
				sessions?: { active?: number; directPlay?: number; transcode?: number };
			}
		).sessions;
		if (sessions) {
			media = {
				active: sessions.active ?? 0,
				directPlay: sessions.directPlay ?? 0,
				transcode: sessions.transcode ?? 0
			};
		}
	}
	if (!media) {
		for (const t of byType('tautulli')) {
			const activity = (
				t.data as {
					tautulli_activity?: { active?: number; directPlay?: number; transcode?: number };
				}
			).tautulli_activity;
			if (activity) {
				media = {
					active: activity.active ?? 0,
					directPlay: activity.directPlay ?? 0,
					transcode: activity.transcode ?? 0
				};
			}
		}
	}

	// Requests: Seerr.
	let requests: object | null = null;
	for (const s of byType('seerr')) {
		const data = (
			s.data as {
				requests?: { total?: number; pending?: number; approved?: number };
			}
		).requests;
		if (data) {
			requests = {
				pending: data.pending ?? 0,
				approved: data.approved ?? 0,
				total: data.total ?? 0
			};
		}
	}

	return jsonOk({
		services: {
			online: services.filter((s) => s.runState === 'running').length,
			total: services.length,
			unhealthy: services.filter((s) => s.health === 'unhealthy').length
		},
		incidents: { active: hub.getActiveIncidents().length },
		cards: {
			acquisition,
			indexers,
			requests,
			media
		},
		recent: listActivity({ limit: 5 })
	});
};
