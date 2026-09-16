/**
 * Shared *Arr client (Sonarr/Radarr, both speak /api/v3 with X-Api-Key).
 *
 * Monitoring surface is read-only. The only write path is the command API
 * (`/api/v3/command`), exposed through narrowly-typed command wrappers below —
 * never a generic POST passthrough (docs/ACTIONS.md). No queue removal.
 * Adapters map type-specific payloads onto one generic shape for the UI.
 */
import { validateIntegrationUrl } from '../url-validation';

export class ArrAuthError extends Error {
	constructor(message = 'Arr rejected the API key') {
		super(message);
		this.name = 'ArrAuthError';
	}
}

export class ArrError extends Error {
	constructor(
		message: string,
		readonly status: number | null
	) {
		super(message);
		this.name = 'ArrError';
	}
}

export interface ArrQueueItem {
	id: number;
	title: string;
	status: string;
	/** 'ok' | 'warning' | 'failure' from trackedDownloadStatus. */
	trackedDownloadStatus: string;
	trackedDownloadState: string;
	progress: number;
	timeLeft: string | null;
	errorMessage: string | null;
	/** Upstream correlation ids — browse views never match on titles (§115). */
	seriesId: number | null;
	episodeId: number | null;
	movieId: number | null;
}

export interface ArrQueueSnapshot {
	total: number;
	items: ArrQueueItem[];
	warnings: number;
	failures: number;
	fetchedAt: number;
}

export interface ArrHealthEntry {
	source: string;
	type: string;
	message: string;
}

export interface ArrStatus {
	version: string;
	appName: string;
}

const DEFAULT_TIMEOUT_MS = 8_000;

export class ArrBaseClient {
	protected readonly baseUrl: string;

	constructor(
		rawUrl: string,
		private readonly apiKey: string,
		private readonly timeoutMs = DEFAULT_TIMEOUT_MS
	) {
		this.baseUrl = validateIntegrationUrl(rawUrl);
	}

	/** Public: adapters use type-specific endpoints (e.g. calendar). */
	async request<T>(path: string, query?: Record<string, string>): Promise<T> {
		const url = new URL(this.baseUrl + path);
		for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await fetch(url, {
				headers: { 'X-Api-Key': this.apiKey, accept: 'application/json' },
				signal: controller.signal
			});
			if (response.status === 401 || response.status === 403) throw new ArrAuthError();
			if (!response.ok) {
				throw new ArrError(`Arr request failed (HTTP ${response.status})`, response.status);
			}
			return (await response.json()) as T;
		} catch (err) {
			if (err instanceof ArrAuthError || err instanceof ArrError) throw err;
			if (err instanceof Error && err.name === 'AbortError') {
				throw new ArrError('Arr request timed out', null);
			}
			throw new ArrError('Could not reach Arr service', null);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * POST JSON to the API. Server-side use only, same transport rules as
	 * {@link request}: fixed base URL (validated at construction), X-Api-Key
	 * auth, bounded timeout, typed errors. Not exposed to the browser —
	 * command routes must go through the actions allowlist (§17).
	 */
	async post<T>(path: string, body: unknown): Promise<T> {
		const url = new URL(this.baseUrl + path);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'X-Api-Key': this.apiKey,
					accept: 'application/json',
					'content-type': 'application/json'
				},
				body: JSON.stringify(body),
				signal: controller.signal
			});
			if (response.status === 401 || response.status === 403) throw new ArrAuthError();
			if (!response.ok) {
				throw new ArrError(`Arr request failed (HTTP ${response.status})`, response.status);
			}
			return (await response.json()) as T;
		} catch (err) {
			if (err instanceof ArrAuthError || err instanceof ArrError) throw err;
			if (err instanceof Error && err.name === 'AbortError') {
				throw new ArrError('Arr request timed out', null);
			}
			throw new ArrError('Could not reach Arr service', null);
		} finally {
			clearTimeout(timer);
		}
	}

	async status(): Promise<ArrStatus> {
		const data = await this.request<{ version?: string; appName?: string }>(
			'/api/v3/system/status'
		);
		return { version: data.version ?? 'unknown', appName: data.appName ?? 'Arr' };
	}

	async health(): Promise<ArrHealthEntry[]> {
		const data =
			await this.request<{ source?: string; type?: string; message?: string }[]>('/api/v3/health');
		return (data ?? []).map((h) => ({
			source: h.source ?? 'unknown',
			type: h.type ?? 'unknown',
			message: h.message ?? ''
		}));
	}

	async rawQueue(): Promise<{
		totalRecords: number;
		records: Record<string, unknown>[];
	}> {
		return this.request('/api/v3/queue', { page: '1', pageSize: '500' });
	}

	/** Count endpoint used with pageSize=1 to avoid pulling full collections. */
	async countTotal(path: string): Promise<number> {
		const data = await this.request<{ totalRecords?: number }>(path, {
			page: '1',
			pageSize: '1'
		});
		return data.totalRecords ?? 0;
	}

	// --- Library intelligence surface (read-only; see docs/LIBRARY-INTELLIGENCE.md)

	/** Sonarr: series list with per-series statistics (missing = counts math). */
	async series(): Promise<
		{
			id: number;
			title: string;
			monitored: boolean;
			ended?: boolean;
			statistics?: {
				seasonCount?: number;
				episodeFileCount?: number;
				episodeCount?: number;
				totalEpisodeCount?: number;
				sizeOnDisk?: number;
				percentOfEpisodes?: number;
			};
		}[]
	> {
		return this.request('/api/v3/series');
	}

	/** Full series records (images, seasons, profiles) for the browse poller. */
	async seriesRaw(): Promise<Record<string, unknown>[]> {
		const data = await this.request<Record<string, unknown>[]>('/api/v3/series');
		return Array.isArray(data) ? data : [];
	}

	/** Radarr: movie list with availability + file state. */
	async movies(): Promise<
		{
			id: number;
			title: string;
			year?: number;
			monitored: boolean;
			hasFile: boolean;
			isAvailable?: boolean;
			digitalRelease?: string | null;
			inCinemas?: string | null;
			sizeOnDisk?: number;
		}[]
	> {
		return this.request('/api/v3/movie');
	}

	/** Full movie records (embedded file, images) for the browse poller. */
	async moviesRaw(): Promise<Record<string, unknown>[]> {
		const data = await this.request<Record<string, unknown>[]>('/api/v3/movie');
		return Array.isArray(data) ? data : [];
	}

	/** Wanted/missing page (monitored, released, no file). includeSeries gives
	 *  episode records their series title on Sonarr — Sonarr-only param,
	 *  Radarr rejects it (400). */
	async wantedMissing(
		page = 1,
		pageSize = 100,
		opts: { includeSeries?: boolean } = {}
	): Promise<{
		totalRecords: number;
		records: Record<string, unknown>[];
	}> {
		return this.request('/api/v3/wanted/missing', {
			page: String(page),
			pageSize: String(pageSize),
			sortKey: 'airDateUtc',
			sortDirection: 'ascending',
			...(opts.includeSeries ? { includeSeries: 'true' } : {})
		});
	}

	// --- Library browser surface (read-only; see docs/LIBRARY-BROWSER.md)

	/** Quality profile id→name map (read-only display, no edits, §120). */
	async qualityProfiles(): Promise<Map<number, string>> {
		const data = await this.request<{ id?: number; name?: string }[]>('/api/v3/qualityprofile');
		const map = new Map<number, string>();
		for (const profile of data ?? []) {
			if (typeof profile.id === 'number')
				map.set(profile.id, profile.name ?? `Profile ${profile.id}`);
		}
		return map;
	}

	/** Sonarr: all episodes of one series, files embedded. Lazy per-series
	 *  detail endpoint — never called for the list view (§75/§80). */
	async episodesBySeries(seriesId: number): Promise<Record<string, unknown>[]> {
		const data = await this.request<Record<string, unknown>[]>('/api/v3/episode', {
			seriesId: String(seriesId),
			includeEpisodeFile: 'true'
		});
		return Array.isArray(data) ? data : [];
	}

	/** Bounded recent history. Neither Sonarr nor Radarr honors an item filter
	 *  here reliably (Sonarr ignores seriesId; Radarr 6.3.0 returns unrelated
	 *  movieIds) — callers fetch one bounded page and filter by the upstream
	 *  id themselves (§115/§116). */
	async history(
		pageSize = 10,
		extra: Record<string, string> = {}
	): Promise<Record<string, unknown>[]> {
		const data = await this.request<{ records?: Record<string, unknown>[] }>('/api/v3/history', {
			page: '1',
			pageSize: String(pageSize),
			sortKey: 'date',
			sortDirection: 'descending',
			...extra
		});
		return data.records ?? [];
	}

	// --- Safe Actions command surface (docs/ACTIONS.md) ---
	// Only these shapes are sent upstream; there is no generic command escape
	// hatch. Every wrapper targets exact upstream ids — never title matching.

	/** Look up a previously posted command (bounded follow-up polling). */
	async commandStatus(
		commandId: number
	): Promise<{ id?: number; status?: string; commandName?: string }> {
		return this.request(`/api/v3/command/${commandId}`);
	}

	/** Sonarr: targeted search for specific episode ids. */
	async commandEpisodeSearch(episodeIds: number[]): Promise<ArrCommandAccepted> {
		return this.post('/api/v3/command', { name: 'EpisodeSearch', episodeIds });
	}

	/** Sonarr: search every monitored, missing episode of one season. */
	async commandSeasonSearch(seriesId: number, seasonNumber: number): Promise<ArrCommandAccepted> {
		return this.post('/api/v3/command', {
			name: 'SeasonSearch',
			seriesId,
			seasonNumber
		});
	}

	/** Sonarr: rescan/search a whole series (Sonarr's own semantics). */
	async commandSeriesSearch(seriesId: number): Promise<ArrCommandAccepted> {
		return this.post('/api/v3/command', { name: 'SeriesSearch', seriesId });
	}

	/** Sonarr: refresh series metadata/files (no search implied). */
	async commandRefreshSeries(seriesId: number): Promise<ArrCommandAccepted> {
		return this.post('/api/v3/command', { name: 'RefreshSeries', seriesId });
	}

	/** Radarr: targeted search for specific movie ids. */
	async commandMoviesSearch(movieIds: number[]): Promise<ArrCommandAccepted> {
		return this.post('/api/v3/command', { name: 'MoviesSearch', movieIds });
	}

	/** Radarr: refresh one movie (metadata/files, no search implied). */
	async commandRefreshMovie(movieId: number): Promise<ArrCommandAccepted> {
		return this.post('/api/v3/command', { name: 'RefreshMovie', movieId });
	}
}

/** 201 response body of a successful POST /api/v3/command. */
export interface ArrCommandAccepted {
	id?: number;
	status?: string;
	commandName?: string;
	[key: string]: unknown;
}
