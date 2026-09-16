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
	ReconcileFinding
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
	concurrency: 8
} as const;

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
}

export class ReconciliationRunner {
	private timer: NodeJS.Timeout | null = null;
	private startupTimer: NodeJS.Timeout | null = null;
	private running = false;
	private prober: WorkerLibraryProber | null = null;

	constructor(private readonly options: ReconciliationRunnerOptions) {}

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
		if (!settings.enabled) return;
		this.running = true;
		try {
			const { listIntegrations, getApiKey } = await import('../integrations/store');
			const arrFiles: ArrFileRecord[] = [];
			for (const config of listIntegrations()) {
				if (config.enabled === false) continue;
				if (config.type !== 'sonarr' && config.type !== 'radarr') continue;
				const apiKey = getApiKey(config.id);
				if (!apiKey) continue;
				const { files } = await fetchArrFiles(
					config as unknown as IntegrationLike,
					apiKey,
					config.type
				);
				arrFiles.push(...files);
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
					addedAt: null
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
						await refreshPlexSection(settings.plexUrl, settings.plexToken, id);
					}
				}
			}
		} finally {
			this.running = false;
		}
	}
}
