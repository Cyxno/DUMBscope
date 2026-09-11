/**
 * Shared *Arr client (Sonarr/Radarr, both speak /api/v3 with X-Api-Key).
 *
 * Read-only surface only: no command endpoints, no queue removal (brief §36).
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
}
