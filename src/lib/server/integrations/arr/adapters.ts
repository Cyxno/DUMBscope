/**
 * Sonarr/Radarr adapters over the shared ArrBaseClient. Queue items may show
 * media titles (local UI, from the user's own instance) — never persisted to
 * SQLite (brief §6/§67); only counts and semantic events are stored.
 */
import { randomUUID } from 'node:crypto';
import type { ActivityEvent, IntegrationConfig } from '../types';
import type { PollContext, PollerSpec } from '../manager';
import { ArrAuthError, ArrBaseClient, type ArrQueueSnapshot } from './base';

interface ClientWithKind extends ArrBaseClient {
	kind: 'sonarr' | 'radarr';
}

function makeClient(config: IntegrationConfig, apiKey: string | null): ClientWithKind {
	if (!apiKey) throw new ArrAuthError('No API key configured for this integration');
	const kind = config.type as 'sonarr' | 'radarr';
	const client = new ArrBaseClient(config.url, apiKey) as ClientWithKind;
	client.kind = kind;
	return client;
}

function mapQueue(raw: {
	totalRecords: number;
	records: Record<string, unknown>[];
}): ArrQueueSnapshot {
	const records = raw.records ?? [];
	const items = records.slice(0, 200).map((r, i) => {
		const size = Number(r.size) || 0;
		const remaining = Number(r.sizeleft) || 0;
		// Arr records vary: direct title, series title or movie title.
		const seriesTitle = (r.series as { title?: string } | undefined)?.title;
		const movieTitle = (r.movie as { title?: string } | undefined)?.title;
		const isTitle = (t: unknown): t is string => typeof t === 'string' && t.length > 0;
		const title = [r.title, seriesTitle, movieTitle].find(isTitle) ?? 'Unknown';
		return {
			id: Number(r.id) || i,
			title,
			status: String(r.status ?? ''),
			trackedDownloadStatus: String(r.trackedDownloadStatus ?? ''),
			trackedDownloadState: String(r.trackedDownloadState ?? ''),
			progress: size > 0 ? Math.max(0, Math.min(100, (1 - remaining / size) * 100)) : 100,
			timeLeft: (r.timeleft as string | undefined) ?? null,
			errorMessage: (r.errorMessage as string | undefined) || null
		};
	});
	return {
		total: raw.totalRecords ?? records.length,
		items,
		warnings: items.filter((i) => i.trackedDownloadStatus === 'warning').length,
		failures: items.filter((i) => i.trackedDownloadStatus === 'failure').length,
		fetchedAt: Date.now()
	};
}

/** Diff the queue against the previous snapshot to emit semantic events. */
function queueEvents(
	integrationId: string,
	previous: ArrQueueSnapshot | null,
	current: ArrQueueSnapshot
): ActivityEvent[] {
	const events: ActivityEvent[] = [];
	const prevIds = new Set((previous?.items ?? []).map((i) => i.id));
	const now = Date.now();
	for (const item of current.items) {
		if (!prevIds.has(item.id) && current.fetchedAt - (previous?.fetchedAt ?? 0) < 120_000) {
			events.push({
				id: randomUUID(),
				at: now,
				source: integrationId,
				serviceKey: integrationId.split('-')[0] ?? null,
				category: 'grab',
				title: `Grabbed: ${item.title}`,
				detail: item.status || null,
				severity: null,
				observed: true,
				correlationId: null
			});
		}
		if (item.trackedDownloadStatus === 'failure') {
			events.push({
				id: randomUUID(),
				at: now,
				source: integrationId,
				serviceKey: integrationId.split('-')[0] ?? null,
				category: 'import',
				title: `Import failed: ${item.title}`,
				detail: item.errorMessage ?? item.trackedDownloadState,
				severity: 'warning',
				observed: true,
				correlationId: null
			});
		}
	}
	if (previous && previous.total > current.items.length) {
		const disappeared = previous.items.filter((i) => !current.items.some((c) => c.id === i.id));
		for (const item of disappeared.slice(0, 5)) {
			if (item.trackedDownloadStatus !== 'failure') {
				events.push({
					id: randomUUID(),
					at: now,
					source: integrationId,
					serviceKey: integrationId.split('-')[0] ?? null,
					category: 'import',
					title: `Import completed: ${item.title}`,
					detail: null,
					severity: null,
					observed: true,
					correlationId: null
				});
			}
		}
	}
	return events;
}

const QUEUE_TTL_MS = 20_000;
const WANTED_TTL_MS = 10 * 60_000;
const UPCOMING_TTL_MS = 30 * 60_000;
const HEALTH_TTL_MS = 5 * 60_000;

/** Previous queue snapshot per integration, for grab/import-completed diffs. */
const previousQueues = new Map<string, ArrQueueSnapshot>();

function arrPollers(integrationId: string): PollerSpec[] {
	return [
		{
			name: 'queue',
			intervalMs: 15_000,
			run: async (ctx: PollContext) => {
				const client = makeClient(ctx.config, ctx.apiKey);
				const started = Date.now();
				const raw = await client.rawQueue();
				const snapshot = mapQueue(raw);
				const previous = previousQueues.get(integrationId) ?? null;
				ctx.cache.set('queue', snapshot, QUEUE_TTL_MS);
				previousQueues.set(integrationId, snapshot);
				ctx.ok(undefined, Date.now() - started);
				ctx.emit(queueEvents(integrationId, previous, snapshot));
			}
		},
		{
			name: 'health',
			intervalMs: 5 * 60_000,
			run: async (ctx: PollContext) => {
				const client = makeClient(ctx.config, ctx.apiKey);
				const entries = await client.health();
				ctx.cache.set('health', entries, HEALTH_TTL_MS);
			}
		},
		{
			name: 'wanted',
			intervalMs: 15 * 60_000,
			run: async (ctx: PollContext) => {
				const client = makeClient(ctx.config, ctx.apiKey);
				const missing = await client.countTotal('/api/v3/wanted/missing');
				const cutoffUnmet = await client.countTotal('/api/v3/wanted/cutoff_unmet');
				ctx.cache.set('wanted', { missing, cutoffUnmet }, WANTED_TTL_MS);
			}
		},
		{
			name: 'upcoming',
			intervalMs: 30 * 60_000,
			run: async (ctx: PollContext) => {
				const client = makeClient(ctx.config, ctx.apiKey);
				const start = new Date().toISOString().slice(0, 10);
				const end = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
				const upcoming = await client.request<{ title?: string; series?: { title?: string } }[]>(
					'/api/v3/calendar',
					{ start, end }
				);
				ctx.cache.set(
					'upcoming',
					(upcoming ?? []).slice(0, 20).map((e) => ({
						title: e.series?.title ?? e.title ?? 'Unknown'
					})),
					UPCOMING_TTL_MS
				);
			}
		},
		{
			name: 'version',
			intervalMs: 60 * 60_000,
			run: async (ctx: PollContext) => {
				const client = makeClient(ctx.config, ctx.apiKey);
				const status = await client.status();
				ctx.cache.set('status', status, 2 * 60 * 60_000);
			}
		}
	];
}

export function createArrAdapter(kind: 'sonarr' | 'radarr') {
	return {
		type: kind,
		test: async (config: IntegrationConfig, apiKey: string | null) => {
			const status = await makeClient(config, apiKey).status();
			return { version: status.version };
		},
		pollers: (config: IntegrationConfig) => arrPollers(config.id)
	};
}
