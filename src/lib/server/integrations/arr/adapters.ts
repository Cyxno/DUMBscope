/**
 * Sonarr/Radarr adapters over the shared ArrBaseClient. Queue items may show
 * media titles (local UI, from the user's own instance) — never persisted to
 * SQLite (brief §6/§67); only counts and semantic events are stored.
 */
import { randomUUID } from 'node:crypto';
import type { ActivityEvent, IntegrationConfig } from '../types';
import type { PollContext, PollerSpec } from '../manager';
import { ArrAuthError, ArrBaseClient, type ArrQueueSnapshot } from './base';
import { arrLibraryPollers, arrBrowsePollers } from '../media';
import {
	ARR_OBS_TUNING,
	buildRoutingObservability,
	isDownloadFailure,
	parseDownloadClients,
	parsePreferredProtocol,
	type ArrHistoryRecord
} from './routing';
import { recordTimelineThrottled } from '../../reliability/timeline';

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
		const num = (v: unknown): number | null =>
			typeof v === 'number' && Number.isFinite(v) ? v : null;
		return {
			id: Number(r.id) || i,
			title,
			status: String(r.status ?? ''),
			trackedDownloadStatus: String(r.trackedDownloadStatus ?? ''),
			trackedDownloadState: String(r.trackedDownloadState ?? ''),
			progress: size > 0 ? Math.max(0, Math.min(100, (1 - remaining / size) * 100)) : 100,
			timeLeft: (r.timeleft as string | undefined) ?? null,
			errorMessage: (r.errorMessage as string | undefined) || null,
			seriesId: num(r.seriesId),
			episodeId: num(r.episodeId),
			movieId: num(r.movieId)
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

const QUEUE_TTL_MS = 45_000;
const WANTED_TTL_MS = 45 * 60_000;
const UPCOMING_TTL_MS = 90 * 60_000;
const HEALTH_TTL_MS = 15 * 60_000;

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
				// Both Sonarr and Radarr v4 expose the cutoff-unmet list here.
				const cutoffUnmet = await client.countTotal('/api/v3/wanted/cutoff');
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
				const upcoming = await client.request<
					{
						title?: string;
						seasonNumber?: number;
						episodeNumber?: number;
						airDateUtc?: string;
						hasFile?: boolean;
						seriesId?: number;
						series?: { title?: string };
					}[]
				>('/api/v3/calendar', { start, end });
				ctx.cache.set(
					'upcoming',
					(upcoming ?? []).slice(0, 30).map((e) => ({
						// `title` is the series title — kept for the integration panel.
						title: e.series?.title ?? e.title ?? 'Unknown',
						episodeTitle: e.title ?? null,
						seriesId: typeof e.seriesId === 'number' ? e.seriesId : null,
						seasonNumber: typeof e.seasonNumber === 'number' ? e.seasonNumber : null,
						episodeNumber: typeof e.episodeNumber === 'number' ? e.episodeNumber : null,
						airDateUtc: e.airDateUtc ? Date.parse(e.airDateUtc) || null : null,
						hasFile: e.hasFile === true
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
		},
		{
			name: 'stack-observability',
			intervalMs: 5 * 60_000,
			run: async (ctx: PollContext) => {
				const client = makeClient(ctx.config, ctx.apiKey);
				const started = Date.now();
				// Blocklist + history totals via pageSize=1 counts.
				const blocklistSize = await client.countTotal('/api/v3/blocklist').catch(() => null);
				const historyEvents = await client.countTotal('/api/v3/history').catch(() => null);
				// DB size proxy: the instance's own scheduled backups carry the
				// compressed DB size — good enough for a trend, honest as a proxy.
				let dbBytes: number | null = null;
				try {
					const backups = await client.request<{ size?: number }[]>('/api/v3/system/backup');
					dbBytes = Array.isArray(backups) && backups[0]?.size ? Number(backups[0]!.size) : null;
				} catch {
					dbBytes = null;
				}
				// Uptime: system/status startime (ms epoch) when the instance exposes it.
				let uptimeSeconds: number | null = null;
				let version: string | null = null;
				try {
					const st = await client.request<{ version?: string; starttime?: string }>(
						'/api/v3/system/status'
					);
					version = st.version ?? null;
					const startedAt = st.starttime ? Date.parse(st.starttime) : NaN;
					uptimeSeconds = Number.isFinite(startedAt)
						? Math.max(0, Math.round((Date.now() - startedAt) / 1000))
						: null;
				} catch {
					version = null;
				}
				// Recent history window for the 24h counts + failure timeline.
				const recent = (await client
					.request<{ records?: Record<string, unknown>[] }>('/api/v3/history', {
						page: '1',
						pageSize: String(ARR_OBS_TUNING.maxHistoryRecords),
						sortKey: 'date',
						sortDirection: 'descending'
					})
					.catch(() => ({ records: [] as Record<string, unknown>[] }))) as {
					records?: Record<string, unknown>[];
				};
				const records = (recent.records ?? []) as ArrHistoryRecord[];
				const cutoff = Date.now() - 24 * 3_600_000;
				const inWindow = records.filter((r) => {
					const at = r.date ? Date.parse(r.date) : NaN;
					return Number.isFinite(at) && at >= cutoff;
				});
				// RSS-sync + search activity from the command journal.
				let rssLastAt: number | null = null;
				let rssCount24h = 0;
				const searchNames: string[] = [];
				try {
					const commands = await client.request<
						{ commandName?: string; lastExecutionTime?: string; status?: string }[]
					>('/api/v3/command', {
						page: '1',
						pageSize: '100',
						sortKey: 'lastExecutionTime',
						sortDirection: 'descending'
					});
					const dayCutoff = Date.now() - 24 * 3_600_000;
					for (const c of commands ?? []) {
						const name = c.commandName ?? '';
						const at = c.lastExecutionTime ? Date.parse(c.lastExecutionTime) : NaN;
						if (/rss/i.test(name) && Number.isFinite(at)) {
							rssCount24h++;
							if (rssLastAt === null || at > rssLastAt) rssLastAt = at;
						}
						if (
							/search/i.test(name) &&
							Number.isFinite(at) &&
							at >= dayCutoff &&
							searchNames.length < 8
						) {
							searchNames.push(name);
						}
					}
				} catch {
					// command journal optional
				}
				// Queue counts come from the existing queue poller's cache.
				const cachedQueue = ctx.cache.get<{ total: number; warnings: number; failures: number }>(
					'queue'
				);
				const payload = {
					type: ctx.config.type as 'sonarr' | 'radarr',
					integrationId: ctx.config.id,
					connected: true,
					unavailableReason: null,
					version,
					uptimeSeconds,
					dbBytes,
					queue: cachedQueue?.total ?? null,
					queueWarnings: cachedQueue?.warnings ?? null,
					queueFailures: cachedQueue?.failures ?? null,
					blocklistSize,
					historyEvents,
					imports24h: inWindow.filter((r) =>
						[
							'downloadFolderImported',
							'episodeImported',
							'movieImported',
							'trackImported'
						].includes(r.eventType ?? '')
					).length,
					failures24h: inWindow.filter((r) => isDownloadFailure(r)).length,
					grabs24h: inWindow.filter((r) => r.eventType === 'grabbed').length,
					rssSync: { lastAt: rssLastAt, count24h: rssCount24h },
					searches: { count24h: searchNames.length, recent: searchNames },
					fetchedAt: Date.now()
				};
				ctx.cache.set('stack-observability', payload, 10 * 60_000);
				ctx.ok(version ?? undefined, Date.now() - started);
				// Download failures are timeline facts (Observability page).
				for (const r of inWindow.slice(0, 20)) {
					if (!isDownloadFailure(r)) continue;
					recordTimelineThrottled({
						at: r.date ? Date.parse(r.date) : Date.now(),
						kind: 'download-failure',
						service: ctx.config.type,
						severity: 'warning',
						title: `Download failed: ${r.data?.downloadClient ?? 'unknown client'}`,
						detail: typeof r.data?.reason === 'string' ? r.data.reason : null
					});
				}
			}
		},
		{
			name: 'routing',
			intervalMs: 10 * 60_000,
			run: async (ctx: PollContext) => {
				const client = makeClient(ctx.config, ctx.apiKey);
				const started = Date.now();
				const rawClients = await client
					.request<unknown[]>('/api/v3/downloadclient')
					.catch(() => [] as unknown[]);
				const rawProfiles = await client.request<unknown>('/api/v3/delayprofile').catch(() => null);
				const history = await client
					.request<{ records?: Record<string, unknown>[] }>('/api/v3/history', {
						page: '1',
						pageSize: String(ARR_OBS_TUNING.maxHistoryRecords),
						sortKey: 'date',
						sortDirection: 'descending'
					})
					.catch(() => ({ records: [] as Record<string, unknown>[] }));
				const view = buildRoutingObservability(
					parseDownloadClients(Array.isArray(rawClients) ? rawClients : []),
					(history.records ?? []) as ArrHistoryRecord[],
					parsePreferredProtocol(rawProfiles),
					ARR_OBS_TUNING.windowHours
				);
				ctx.cache.set('routing', view, 15 * 60_000);
				ctx.ok(undefined, Date.now() - started);
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
		pollers: (config: IntegrationConfig) => [
			...arrPollers(config.id),
			...arrLibraryPollers(kind),
			...arrBrowsePollers(kind)
		]
	};
}
