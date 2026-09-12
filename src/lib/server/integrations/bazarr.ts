/**
 * Bazarr client (read-only). Endpoints verified against the real service
 * (Bazarr 1.x, /api with X-API-KEY header) during the source audit — see
 * docs/LIBRARY-INTELLIGENCE.md. No writes, no subtitle downloads.
 */
import { validateIntegrationUrl } from './url-validation';

export class BazarrError extends Error {
	constructor(
		message: string,
		readonly status: number | null
	) {
		super(message);
		this.name = 'BazarrError';
	}
}

export interface BazarrBadges {
	episodes: number;
	movies: number;
	providers: number;
	status: number;
}

export interface BazarrMissingLanguage {
	name?: string;
	code2?: string;
	code3?: string;
	forced?: boolean;
	hi?: boolean;
}

export interface BazarrMovie {
	title: string;
	year?: number;
	monitored?: boolean;
	radarrId?: number;
	subtitles?: BazarrMissingLanguage[] | null;
	missing_subtitles?: BazarrMissingLanguage[] | null;
}

export interface BazarrSeries {
	title: string;
	monitored?: boolean;
	episodeMissingCount?: number;
	episodeFileCount?: number;
	episodeCount?: number;
	sonarrSeriesId?: number;
	tvdbId?: number;
	profileId?: number;
}

export interface BazarrPaged<T> {
	data: T[];
	total: number;
}

export class BazarrClient {
	private readonly baseUrl: string;

	constructor(
		rawUrl: string,
		private readonly apiKey: string,
		private readonly timeoutMs = 8_000
	) {
		this.baseUrl = validateIntegrationUrl(rawUrl);
	}

	async request<T>(path: string, query?: Record<string, string>): Promise<T> {
		const url = new URL(this.baseUrl + path);
		for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await fetch(url, {
				headers: { 'X-API-KEY': this.apiKey, accept: 'application/json' },
				signal: controller.signal
			});
			if (response.status === 401 || response.status === 403)
				throw new BazarrError('Bazarr rejected the API key', response.status);
			if (!response.ok)
				throw new BazarrError(`Bazarr request failed (HTTP ${response.status})`, response.status);
			return (await response.json()) as T;
		} catch (err) {
			if (err instanceof BazarrError) throw err;
			if (err instanceof Error && err.name === 'AbortError') {
				throw new BazarrError('Bazarr request timed out', null);
			}
			throw new BazarrError('Could not reach Bazarr', null);
		} finally {
			clearTimeout(timer);
		}
	}

	async status(): Promise<{ version: string | null }> {
		const data = await this.request<{ data?: { bazarr_version?: string } }>('/api/system/status');
		return { version: data.data?.bazarr_version ?? null };
	}

	async badges(): Promise<BazarrBadges> {
		const raw = await this.request<Record<string, unknown>>('/api/badges');
		const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
		return {
			episodes: num(raw.episodes),
			movies: num(raw.movies),
			providers: num(raw.providers),
			status: num(raw.status)
		};
	}

	/** Movies with their subtitle state; `length = -1` returns everything. */
	async movies(length = -1, start = 0): Promise<BazarrPaged<BazarrMovie>> {
		const data = await this.request<BazarrPaged<BazarrMovie>>('/api/movies', {
			length: String(length),
			start: String(start)
		});
		return { data: data.data ?? [], total: data.total ?? data.data?.length ?? 0 };
	}

	/** Series with aggregate subtitle/episode counts (episode-level needs a
	 *  follow-up per series — done on demand only, brief §59). */
	async series(length = -1, start = 0): Promise<BazarrPaged<BazarrSeries>> {
		const data = await this.request<BazarrPaged<BazarrSeries>>('/api/series', {
			length: String(length),
			start: String(start)
		});
		return { data: data.data ?? [], total: data.total ?? data.data?.length ?? 0 };
	}

	/** Movies with wanted subtitles missing (ranked list source, §21). */
	async moviesWanted(length = 50, start = 0): Promise<BazarrPaged<BazarrMovie>> {
		const data = await this.request<BazarrPaged<BazarrMovie>>('/api/movies/wanted', {
			length: String(length),
			start: String(start)
		});
		return { data: data.data ?? [], total: data.total ?? data.data?.length ?? 0 };
	}

	async languages(): Promise<{ name?: string; code2?: string; enabled?: boolean }[]> {
		const data =
			await this.request<{ name?: string; code2?: string; enabled?: boolean }[]>(
				'/api/system/languages'
			);
		return Array.isArray(data) ? data : [];
	}

	// --- Library browser surface (read-only; see docs/LIBRARY-BROWSER.md)

	/** Episodes of one series with per-episode subtitle state. Bazarr keys
	 *  episodes by `sonarrEpisodeId` (verified against 1.6.0); the parameter
	 *  spelling is `seriesid[]`. */
	async episodesBySeries(seriesId: number): Promise<Record<string, unknown>[]> {
		const data = await this.request<BazarrPaged<Record<string, unknown>>>('/api/episodes', {
			'seriesid[]': String(seriesId),
			length: '-1'
		});
		return data.data ?? [];
	}

	/** Language profiles (id, name, cutoff, wanted languages) — §51. */
	async languageProfiles(): Promise<Record<string, unknown>[]> {
		const data = await this.request<Record<string, unknown>[]>('/api/system/languages/profiles');
		return Array.isArray(data) ? data : [];
	}

	/** Recent subtitle history for series episodes (bounded, §53/§116). */
	async episodesHistory(length = 10): Promise<Record<string, unknown>[]> {
		const data = await this.request<BazarrPaged<Record<string, unknown>>>('/api/episodes/history', {
			length: String(length)
		});
		return data.data ?? [];
	}

	/** Recent subtitle history for movies (bounded, §53/§116). */
	async moviesHistory(length = 10): Promise<Record<string, unknown>[]> {
		const data = await this.request<BazarrPaged<Record<string, unknown>>>('/api/movies/history', {
			length: String(length)
		});
		return data.data ?? [];
	}
}
