/**
 * Poller helpers for the remaining deep integrations (brief §8–§14).
 * All read-only GET requests with per-integration timeouts. API keys are
 * read per-run from the context (never stale-captured at creation time);
 * adapters degrade to unreachable/auth_error states without ever throwing
 * outward (failure isolation lives in the manager).
 */
import type { PollContext } from './manager';

const TIMEOUT_MS = 8_000;

async function getJson<T>(
	ctx: PollContext,
	path: string,
	extraHeaders: Record<string, string> = {},
	query?: Record<string, string>
): Promise<T> {
	const full = new URL(ctx.config.url.replace(/\/+$/, '') + path);
	for (const [k, v] of Object.entries(query ?? {})) full.searchParams.set(k, v);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(full, {
			headers: { accept: 'application/json', ...extraHeaders },
			signal: controller.signal
		});
		if (response.status === 401 || response.status === 403) {
			throw new Error(`${response.status}: rejected credentials`);
		}
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		return (await response.json()) as T;
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') {
			throw new Error('timeout: request aborted');
		}
		if (err instanceof Error && /fetch failed|econnrefused|enotfound/i.test(err.message)) {
			throw new Error(`could not reach service (${err.message.slice(0, 60)})`);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

type Spec = { name: string; intervalMs: number; run: (ctx: PollContext) => Promise<void> };

// ---------------------------------------------------------------------------
// Prowlarr: indexer inventory + health via /api/v1
// ---------------------------------------------------------------------------
export function prowlarrPollers(): Spec[] {
	return [
		{
			name: 'indexers',
			intervalMs: 5 * 60_000,
			run: async (ctx: PollContext) => {
				const started = Date.now();
				const h = { 'X-Api-Key': ctx.apiKey ?? '' };
				const status = await getJson<{ version?: string }>(ctx, '/api/v1/system/status', h);
				const indexers = await getJson<{ name?: string; enable?: boolean; status?: string }[]>(
					ctx,
					'/api/v1/indexer',
					h
				);
				const health = await getJson<{ message?: string }[]>(ctx, '/api/v1/health', h).catch(
					() => [] as { message?: string }[]
				);
				const enabled = indexers.filter((i) => i.enable !== false);
				const payload = {
					version: status.version ?? 'unknown',
					indexers: enabled.length,
					testFailures: enabled.filter((i) => i.status && i.status !== 'ok').length,
					warnings: health.length,
					warningsDetail: health.slice(0, 5).map((w) => w.message ?? ''),
					fetchedAt: Date.now()
				};
				ctx.cache.set('indexers', payload, 10 * 60_000);
				ctx.ok(payload.version, Date.now() - started);
			}
		}
	];
}

// ---------------------------------------------------------------------------
// Seerr: request pipeline via /api/v1/request
// ---------------------------------------------------------------------------
export function seerrPollers(): Spec[] {
	return [
		{
			name: 'requests',
			intervalMs: 60_000,
			run: async (ctx: PollContext) => {
				const started = Date.now();
				const data = await getJson<{
					pageInfo?: { total?: number };
					results?: { id?: number; status?: number; title?: string }[];
				}>(
					ctx,
					'/api/v1/request',
					{ 'X-Api-Key': ctx.apiKey ?? '' },
					{
						take: '20',
						skip: '0',
						filter: 'all'
					}
				);
				const results = data.results ?? [];
				const payload = {
					total: data.pageInfo?.total ?? 0,
					pending: results.filter((r) => r.status === 1).length,
					approved: results.filter((r) => r.status === 2).length,
					declined: results.filter((r) => r.status === 3).length,
					recent: results.slice(0, 8).map((r) => ({
						title: r.title ?? 'Unknown',
						status: r.status ?? 0
					})),
					fetchedAt: Date.now()
				};
				ctx.cache.set('requests', payload, 60_000);
				ctx.ok(undefined, Date.now() - started);
			}
		}
	];
}

// ---------------------------------------------------------------------------
// Plex: live sessions + identity
// ---------------------------------------------------------------------------
export function plexPollers(): Spec[] {
	return [
		{
			name: 'sessions',
			intervalMs: 10_000,
			run: async (ctx: PollContext) => {
				const started = Date.now();
				const container = await getJson<{
					MediaContainer?: {
						size?: number;
						Metadata?: {
							title?: string;
							Media?: { videoDecision?: string; audioDecision?: string }[];
							Player?: { state?: string }[];
						}[];
					};
				}>(ctx, '/status/sessions', { 'X-Plex-Token': ctx.apiKey ?? '' });
				const metadata = container.MediaContainer?.Metadata ?? [];
				let direct = 0;
				let transcode = 0;
				for (const item of metadata) {
					const media = item.Media?.[0];
					const decision = media?.videoDecision ?? media?.audioDecision;
					if (decision === 'transcode') transcode += 1;
					else direct += 1;
				}
				ctx.cache.set(
					'sessions',
					{
						active: metadata.length,
						directPlay: direct,
						transcode,
						sessions: metadata.slice(0, 10).map((m) => ({
							title: m.title ?? 'Unknown',
							state: m.Player?.[0]?.state ?? 'unknown'
						})),
						fetchedAt: Date.now()
					},
					15_000
				);
				ctx.ok(undefined, Date.now() - started);
			}
		},
		{
			name: 'identity',
			intervalMs: 60 * 60_000,
			run: async (ctx: PollContext) => {
				const container = await getJson<{
					MediaContainer?: { version?: string };
				}>(ctx, '/identity', { 'X-Plex-Token': ctx.apiKey ?? '' });
				ctx.ok(container.MediaContainer?.version ?? null);
			}
		}
	];
}

// ---------------------------------------------------------------------------
// Tautulli: richer Plex session data via /api/v2?cmd=get_activity
// ---------------------------------------------------------------------------
export function tautulliPollers(): Spec[] {
	return [
		{
			name: 'activity',
			intervalMs: 15_000,
			run: async (ctx: PollContext) => {
				const started = Date.now();
				const data = await getJson<{
					response?: {
						result?: string;
						data?: {
							sessions?: {
								title?: string;
								decision?: string;
								quality?: string;
							}[];
							stream_count?: string | number;
							direct_play_count?: string | number;
							transcode_count?: string | number;
						};
					};
				}>(ctx, '/api/v2', {}, { apikey: ctx.apiKey ?? '', cmd: 'get_activity' });
				if (data.response?.result !== 'success') throw new Error('Tautulli returned an error');
				const activity = data.response.data;
				const sessions = activity?.sessions ?? [];
				ctx.cache.set(
					'tautulli-activity',
					{
						active: activity?.stream_count ?? sessions.length,
						directPlay:
							activity?.direct_play_count ??
							sessions.filter((s) => s.decision === 'direct play').length,
						transcode:
							activity?.transcode_count ??
							sessions.filter((s) => (s.decision ?? '').includes('transcode')).length,
						streams: sessions.slice(0, 10).map((s) => ({
							title: s.title ?? 'Unknown',
							decision: s.decision ?? null,
							quality: s.quality ?? null
						})),
						fetchedAt: Date.now()
					},
					20_000
				);
				ctx.ok(undefined, Date.now() - started);
			}
		}
	];
}
