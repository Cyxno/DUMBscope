/**
 * Reconciliation cycle runner: composes Arr library reads, the Plex snapshot
 * and the filesystem prober into one `reconcileLibrary` run, then feeds the
 * findings to the incident engine through open/close deltas.
 *
 * Cadence: deliberately slow (default 30 min). This check is deterministic
 * and local — it must never approach AI/LLM cost or Arr API pressure. Each
 * cycle is capped: Sonarr file paths require per-series requests, so the
 * fetcher bounds series count and concurrency and reports truncation.
 */
import type {
	ArrFileRecord,
	MountTargetSpec,
	PathAliasSpec,
	PlexPartRecord,
	ReconcileFinding,
	ReconcileStats
} from './library';
import { WorkerLibraryProber } from './prober';
import { reconcileLibrary } from './library';

const TUNING = {
	/** Cadence between full reconciliation cycles. */
	cycleMs: 30 * 60_000,
	/** Delay after hub start before the first (post-restart) cycle. */
	startupDelayMs: 90_000,
	/** Grace before an unindexed-but-existing Arr file counts as Plex-stale. */
	staleGraceMs: 30 * 60_000,
	/** Max Sonarr series probed per cycle (truncation is reported, not hidden). */
	sonarrSeriesCap: 400,
	/** Concurrent Sonarr episodefile requests. */
	concurrency: 8,
	/** First backoff after an Arr fetch failure. */
	fetchBackoffBaseMs: 60_000,
	/** Backoff ceiling: an unreachable Arr is retried at most every 10 min. */
	fetchBackoffMaxMs: 10 * 60_000
} as const;

/** Observer-visible record of one reconciliation attempt (System panel). */
export interface ReconciliationRunInfo {
	/** Epoch ms the attempt started. */
	at: number;
	status: 'ok' | 'failed' | 'skipped-incomplete' | 'disabled';
	durationMs: number;
	/** Item verdict counts from the reconcile pass (null when it never ran). */
	stats: ReconcileStats | null;
	/** Human-readable failure detail (no credentials, no URLs). */
	error: string | null;
}

/**
 * Per-integration fetch bookkeeping. A failed integration never aborts the
 * cycle and never crashes the process: it degrades to its last-good data
 * (or, if it never succeeded, suspends the Arr-vs-Plex diff for the cycle)
 * and retries on an exponential, bounded backoff.
 */
interface IntegrationFetchState {
	/** Last successful fetch output; null until the first success. */
	files: ArrFileRecord[] | null;
	/** Timestamp of the last successful fetch. */
	lastGoodAt: number;
	/** Consecutive failures — drives the exponential backoff. */
	consecutiveFailures: number;
	/** Earliest wall-clock time the next fetch attempt is allowed. */
	nextAttemptAt: number;
}

interface IntegrationLike {
	id: string;
	type: string;
	enabled?: boolean;
	url: string;
}

export interface ReconcileSettings {
	enabled: boolean;
	mounts: MountTargetSpec[];
	aliases: PathAliasSpec[];
	plexDbPath: string | null;
	plexUrl: string | null;
	plexToken: string | null;
	plexAutoRefresh: boolean;
	/**
	 * Synthetic validation fixtures (production self-test). When set, these
	 * paths are classified each cycle as extra items — nothing in the real
	 * library is touched. Point `brokenPath` at a symlink whose target is
	 * missing to open a `broken-symlink` finding; point `ghostPath` at a
	 * missing path to open a `plex-ghost` finding. Remove the settings (or
	 * make the paths resolve) and the findings resolve automatically.
	 */
	selftestBrokenPath: string | null;
	selftestGhostPath: string | null;
}

export const DEFAULT_SETTINGS: ReconcileSettings = {
	enabled: true,
	mounts: [],
	aliases: [
		// DUMB default topology: Sonarr/Radarr roots vs Plex library roots,
		// chained through to the raw bind view so every deployment view
		// converges onto one canonical identity.
		{ from: '/media/', to: '/symlinks/TV Shows/' },
		{ from: '/media-movies/', to: '/symlinks/Movies/' },
		{ from: '/symlinks/TV Shows/', to: '/mnt/vm_storage/symlinks/TV Shows/' },
		{ from: '/symlinks/Movies/', to: '/mnt/vm_storage/symlinks/Movies/' }
	],
	plexDbPath: null,
	plexUrl: null,
	plexToken: null,
	plexAutoRefresh: false,
	selftestBrokenPath: null,
	selftestGhostPath: null
};

async function fetchArrFiles(
	integration: IntegrationLike,
	apiKey: string,
	kind: 'sonarr' | 'radarr'
): Promise<{ files: ArrFileRecord[]; truncated: boolean }> {
	const { ArrBaseClient } = await import('../integrations/arr/base');
	const client = new ArrBaseClient(integration.url, apiKey);
	const files: ArrFileRecord[] = [];

	if (kind === 'radarr') {
		const movies = (await client.moviesRaw()) as Array<{
			id: number;
			title?: string;
			hasFile?: boolean;
			movieFile?: { path?: string; size?: number } | null;
			movieFileId?: number;
		}>;
		for (const m of movies) {
			if (!m.hasFile || !m.movieFile?.path) continue;
			files.push({
				source: 'radarr',
				key: `radarr:${integration.id}:movie:${m.id}`,
				label: m.title ?? `movie ${m.id}`,
				path: m.movieFile.path,
				size: m.movieFile.size ?? null,
				addedAt: null
			});
		}
		return { files, truncated: false };
	}

	// Sonarr: the episodefile endpoint is per-series by design; walk series
	// with bounded concurrency. Two requests per series total: the episode
	// list (episode → episodeFileId) and the file list (episodeFileId → path).
	const series = (await client.seriesRaw()) as Array<{ id: number; title?: string }>;
	let truncated = false;
	const targets = series.slice(0, TUNING.sonarrSeriesCap);
	if (series.length > targets.length) truncated = true;

	let cursor = 0;
	const worker = async () => {
		for (;;) {
			const index = cursor++;
			const s = targets[index];
			if (!s) return;
			try {
				const [episodes, filesForSeries] = await Promise.all([
					client.request('episode', { seriesId: String(s.id) }) as Promise<
						Array<{
							id: number;
							hasFile?: boolean;
							seasonNumber?: number;
							episodeNumber?: number;
							episodeFileId?: number;
						}>
					>,
					client.request('episodefile', { seriesId: String(s.id) }) as Promise<
						Array<{ id: number; path?: string; size?: number }>
					>
				]);
				const pathById = new Map<number, { path: string; size?: number }>();
				for (const f of filesForSeries) {
					if (f.path) pathById.set(f.id, { path: f.path, size: f.size });
				}
				for (const e of episodes) {
					if (!e.hasFile || !e.episodeFileId) continue;
					const file = pathById.get(e.episodeFileId);
					if (!file) continue;
					files.push({
						source: 'sonarr',
						key: `sonarr:${integration.id}:episode:${e.id}`,
						label:
							`${s.title ?? 'series'} S${String(e.seasonNumber ?? 0).padStart(2, '0')}` +
							`E${String(e.episodeNumber ?? 0).padStart(2, '0')}`,
						path: file.path,
						size: file.size ?? undefined,
						addedAt: null
					});
				}
			} catch {
				// one sick series must not stall the cycle
			}
		}
	};
	await Promise.all(Array.from({ length: TUNING.concurrency }, worker));
	return { files, truncated };
}

/** Settings-based defaults the hub passes in (kept out of the engine). */
export interface ReconciliationRunnerOptions {
	getSettings: () => ReconcileSettings;
	reportFinding: (finding: ReconcileFinding) => void;
	resolveFinding: (fingerprint: string) => void;
	/**
	 * Currently active reconciliation fingerprints according to the incident
	 * store. Seeding the delta from here (instead of process memory) makes
	 * resolution survive container restarts — without it, incidents opened by
	 * a previous incarnation can never resolve (production lesson 2026-09-16).
	 */
	getActiveFingerprints?: () => Iterable<string>;
	onStats?: (stats: Awaited<ReturnType<typeof reconcileLibrary>>['stats']) => void;
	now?: () => number;
	/**
	 * Test seam: resolve the Arr poll targets without touching the integrations
	 * store (which drags the database into unit tests). Defaults to the store.
	 */
	resolveArrTargets?: () => Promise<ArrTarget[]> | ArrTarget[];
}

/** One enabled Sonarr/Radarr the runner should poll. */
export interface ArrTarget {
	id: string;
	type: 'sonarr' | 'radarr';
	url: string;
	apiKey: string;
}

export class ReconciliationRunner {
	private timer: NodeJS.Timeout | null = null;
	private startupTimer: NodeJS.Timeout | null = null;
	private running = false;
	private prober: WorkerLibraryProber | null = null;
	/** Per-integration fetch state, keyed by integration id. */
	private fetchStates = new Map<string, IntegrationFetchState>();
	/** Last attempted / last successful run, for the observability panel. */
	private lastAttempt: ReconciliationRunInfo | null = null;
	private lastSuccess: ReconciliationRunInfo | null = null;
	/** Bounded history of recent attempts (newest last). */
	private history: ReconciliationRunInfo[] = [];
	/** Epoch ms the in-flight cycle started (null when idle) — stuck-run watchdog. */
	private currentRunStartedAt: number | null = null;

	constructor(private readonly options: ReconciliationRunnerOptions) {}

	/** Observability snapshot: last attempt, last success, next scheduled run. */
	observability(): {
		lastAttempt: ReconciliationRunInfo | null;
		lastSuccess: ReconciliationRunInfo | null;
		nextRunAt: number | null;
		running: boolean;
		/** Epoch ms the in-flight cycle started (null when idle). */
		currentRunStartedAt: number | null;
		recent: ReconciliationRunInfo[];
	} {
		const timer = this.timer;
		// Best-effort next-fire estimate from the live interval timer.
		let nextRunAt: number | null = null;
		if (timer && typeof timer.unref === 'function') {
			nextRunAt = Date.now() + TUNING.cycleMs; // interval is fixed-cadence
		}
		return {
			lastAttempt: this.lastAttempt,
			lastSuccess: this.lastSuccess,
			nextRunAt,
			running: this.running,
			currentRunStartedAt: this.currentRunStartedAt,
			recent: this.history.slice(-10)
		};
	}

	start(): void {
		if (this.timer || this.startupTimer) return; // idempotent: reloads must not stack timers
		// Scenario G: after a hub/container restart, verify the whole chain
		// again — a restart is exactly when mounts and library state drift.
		this.startupTimer = setTimeout(() => {
			void this.run();
		}, TUNING.startupDelayMs);
		this.timer = setInterval(() => {
			void this.run();
		}, TUNING.cycleMs);
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		if (this.startupTimer) clearTimeout(this.startupTimer);
		this.timer = null;
		this.startupTimer = null;
		this.prober?.dispose();
		this.prober = null;
	}

	async run(): Promise<void> {
		if (this.running) return;
		const settings = this.options.getSettings();
		if (!settings.enabled) {
			this.recordRun({
				at: Date.now(),
				status: 'disabled',
				durationMs: 0,
				stats: null,
				error: null
			});
			return;
		}
		this.running = true;
		this.currentRunStartedAt = Date.now();
		const startedAt = Date.now();
		try {
			let targets: ArrTarget[];
			if (this.options.resolveArrTargets) {
				targets = await this.options.resolveArrTargets();
			} else {
				const { listIntegrations, getApiKey } = await import('../integrations/store');
				targets = listIntegrations()
					.filter((c) => c.enabled !== false && (c.type === 'sonarr' || c.type === 'radarr'))
					.flatMap((c) => {
						const apiKey = getApiKey(c.id);
						return apiKey
							? [{ id: c.id, type: c.type as 'sonarr' | 'radarr', url: c.url, apiKey }]
							: [];
					});
			}
			const now = this.options.now?.() ?? Date.now();
			const arrFiles: ArrFileRecord[] = [];
			let arrIncomplete = false; // an enabled Arr contributed no data at all

			for (const config of targets) {
				// Error isolation (production lesson 2026-09-17): one unreachable
				// Arr must never crash the process (unhandled rejection → exit →
				// restart → full library resnapshot storm). A failure marks the
				// integration degraded, backs off, and the cycle degrades with it.
				let state = this.fetchStates.get(config.id);
				if (!state) {
					state = { files: null, lastGoodAt: 0, consecutiveFailures: 0, nextAttemptAt: 0 };
					this.fetchStates.set(config.id, state);
				}

				if (now < state.nextAttemptAt) {
					// Backoff gate: keep serving last-good (stale) data, no request.
					if (state.files) arrFiles.push(...state.files);
					else arrIncomplete = true;
					continue;
				}

				try {
					const { files } = await fetchArrFiles(
						{ id: config.id, type: config.type, url: config.url },
						config.apiKey,
						config.type
					);
					const wasDown = state.consecutiveFailures > 0;
					state.files = files;
					state.lastGoodAt = now;
					state.consecutiveFailures = 0;
					state.nextAttemptAt = 0;
					arrFiles.push(...files);
					// Sustained recovery: clear the degraded incident. It resolves
					// either here (dedupe fingerprint below) or via the active-set
					// sweep when a diff cycle runs.
					if (wasDown) {
						console.log(`[reconciliation] ${config.type} "${config.id}" recovered (backoff reset)`);
						this.options.resolveFinding(arrUnavailableFingerprint(config.id));
					}
				} catch (err) {
					state.consecutiveFailures += 1;
					const attempt = state.consecutiveFailures;
					const backoff = Math.min(
						TUNING.fetchBackoffBaseMs * 2 ** (attempt - 1),
						TUNING.fetchBackoffMaxMs
					);
					state.nextAttemptAt = now + backoff;
					const errorClass = err instanceof Error ? err.name : typeof err;
					const detail = err instanceof Error ? err.message : String(err);
					// Compact one-liner: no stack trace spam, no secrets (API key
					// never enters the message; URL is deliberately omitted).
					console.warn(
						`[reconciliation] ${config.type} "${config.id}" fetch failed (${errorClass}: ${detail}); attempt ${attempt}, retrying in ${Math.round(backoff / 1000)}s`
					);
					if (state.files) {
						// Degrade to last-good data rather than presenting an empty
						// library as ground truth (which would mass-report false
						// plex-file-not-in-sonarr findings).
						arrFiles.push(...state.files);
					} else {
						arrIncomplete = true;
						// Deduped by the incident engine on fingerprint: repeated
						// failures refresh the summary, they never open new incidents.
						this.options.reportFinding({
							kind: 'backend-unavailable',
							fingerprint: arrUnavailableFingerprint(config.id),
							severity: 'warning',
							title: `${config.id} unreachable (${config.type})`,
							summary: `Reconciliation cannot read ${config.type}; Arr-vs-Plex checks are suspended for this integration. Retry in ${Math.round(backoff / 1000)}s.`,
							evidence: [`${errorClass}: ${detail}`],
							resolvable: true
						});
					}
				}
			}

			// Safety valve: without data from every enabled Arr, the Arr-vs-Plex
			// diff would compare Plex against a partial library and mass-report
			// false positives. Skip the diff this cycle (findings stay untouched,
			// nothing is resolved on stale evidence); the backoff gate retries.
			if (arrIncomplete) {
				this.recordRun({
					at: startedAt,
					status: 'skipped-incomplete',
					durationMs: Date.now() - startedAt,
					stats: null,
					error: 'an enabled Arr contributed no data; Arr-vs-Plex diff skipped'
				});
				return;
			}

			// Synthetic production self-test fixtures: classified like any
			// other item, but never sourced from (or written to) the real
			// libraries. See ReconcileSettings.selftest* docs.
			if (settings.selftestBrokenPath) {
				arrFiles.push({
					source: 'sonarr',
					key: 'recon-selftest:broken-symlink',
					label: 'Reconciliation selftest (broken symlink)',
					path: settings.selftestBrokenPath,
					// Always within the plex-stale grace: the selftest fixture has
					// no Plex counterpart by design and must not trip plex-stale.
					addedAt: this.options.now?.() ?? Date.now()
				});
			}

			let plexParts: PlexPartRecord[] = [];
			if (settings.plexDbPath) {
				const { readPlexLibrarySnapshot } = await import('./plex');
				try {
					plexParts = readPlexLibrarySnapshot(settings.plexDbPath).parts;
				} catch {
					plexParts = []; // snapshot unreadable: Plex dimension skipped this cycle
				}
			}
			if (settings.selftestGhostPath) {
				plexParts.push({
					key: 'recon-selftest:ghost',
					label: 'Reconciliation selftest (plex ghost)',
					path: settings.selftestGhostPath,
					sectionId: null,
					size: null
				});
			}

			if (!this.prober) {
				this.prober = new WorkerLibraryProber();
			}

			const result = await reconcileLibrary({
				mounts: settings.mounts,
				aliases: settings.aliases.length ? settings.aliases : DEFAULT_SETTINGS.aliases,
				arrFiles,
				plexParts,
				prober: this.prober,
				staleGraceMs: TUNING.staleGraceMs,
				now: this.options.now
			});

			// Stateless open/close against the incident store: the currently
			// active recon fingerprints come from the engine every cycle, so
			// findings opened by a previous incarnation resolve too.
			const active = new Set(this.options.getActiveFingerprints?.() ?? []);
			const seen = new Set<string>();
			for (const finding of result.findings) {
				seen.add(finding.fingerprint);
				if (!active.has(finding.fingerprint)) {
					this.options.reportFinding(finding);
				}
			}
			for (const fp of active) {
				if (!seen.has(fp)) this.options.resolveFinding(fp);
			}
			this.options.onStats?.(result.stats);
			this.recordRun({
				at: startedAt,
				status: 'ok',
				durationMs: Date.now() - startedAt,
				stats: result.stats,
				error: null
			});

			// Opt-in remediation: when Plex shows ghosts or lags behind the
			// Arrs, ask Plex to rescan the affected sections. Never default:
			// without explicit opt-in DUMBscope stays observe-only.
			if (settings.plexAutoRefresh && settings.plexUrl && settings.plexToken) {
				const needsRefresh = result.stats.plexGhosts > 0 || result.stats.plexStale > 0;
				if (needsRefresh && plexParts.length > 0) {
					const { refreshPlexSection } = await import('./plex');
					const sectionIds = new Set<number>();
					for (const finding of result.findings) {
						if (finding.kind !== 'plex-ghost' && finding.kind !== 'plex-stale') continue;
						const part = plexParts.find((p) => finding.fingerprint.endsWith(p.key));
						if (part?.sectionId) sectionIds.add(part.sectionId);
					}
					for (const id of sectionIds) {
						try {
							await refreshPlexSection(settings.plexUrl, settings.plexToken, id);
						} catch (err) {
							// Remediation is best-effort; never let it kill the cycle.
							console.warn(
								`[reconciliation] Plex section ${id} refresh failed: ${err instanceof Error ? err.message : String(err)}`
							);
						}
					}
				}
			}
		} catch (err) {
			// Last-resort guard: a reconciliation bug must degrade the feature,
			// never the process (an escaped rejection exits Node ≥15).
			const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
			console.error('[reconciliation] cycle failed unexpectedly:', detail);
			this.recordRun({
				at: startedAt,
				status: 'failed',
				durationMs: Date.now() - startedAt,
				stats: null,
				error: detail
			});
		} finally {
			this.running = false;
			this.currentRunStartedAt = null;
		}
	}

	/** Keep the bounded run history and the last-attempt/last-success pointers. */
	private recordRun(info: ReconciliationRunInfo): void {
		this.lastAttempt = info;
		if (info.status === 'ok') this.lastSuccess = info;
		this.history.push(info);
		if (this.history.length > 10) this.history.shift();
	}
}

/** Stable incident fingerprint: one deduped incident per integration. */
function arrUnavailableFingerprint(integrationId: string): string {
	return `recon:arr-unavailable:${integrationId}`;
}
