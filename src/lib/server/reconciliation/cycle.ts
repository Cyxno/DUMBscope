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
}

export const DEFAULT_SETTINGS: ReconcileSettings = {
	enabled: true,
	mounts: [],
	aliases: [
		// DUMB default topology: Sonarr/Radarr root folders vs Plex library root.
		{ from: '/media/', to: '/symlinks/TV Shows/' },
		{ from: '/media-movies/', to: '/symlinks/Movies/' }
	],
	plexDbPath: null,
	plexUrl: null,
	plexToken: null,
	plexAutoRefresh: false
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
	onStats?: (stats: Awaited<ReturnType<typeof reconcileLibrary>>['stats']) => void;
	now?: () => number;
}

export class ReconciliationRunner {
	private activeFingerprints = new Set<string>();
	private timer: NodeJS.Timeout | null = null;
	private startupTimer: NodeJS.Timeout | null = null;
	private running = false;

	constructor(private readonly options: ReconciliationRunnerOptions) {}

	start(): void {
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

			let plexParts: PlexPartRecord[] = [];
			if (settings.plexDbPath) {
				const { readPlexLibrarySnapshot } = await import('./plex');
				try {
					plexParts = readPlexLibrarySnapshot(settings.plexDbPath).parts;
				} catch {
					plexParts = []; // snapshot unreadable: Plex dimension skipped this cycle
				}
			}

			const result = await reconcileLibrary({
				mounts: settings.mounts,
				aliases: settings.aliases,
				arrFiles,
				plexParts,
				prober: new (await import('./prober')).WorkerLibraryProber(),
				staleGraceMs: TUNING.staleGraceMs,
				now: this.options.now
			});

			const seen = new Set<string>();
			for (const finding of result.findings) {
				seen.add(finding.fingerprint);
				if (!this.activeFingerprints.has(finding.fingerprint)) {
					this.options.reportFinding(finding);
				}
			}
			for (const fp of this.activeFingerprints) {
				if (!seen.has(fp)) this.options.resolveFinding(fp);
			}
			this.activeFingerprints = seen;
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
