/**
 * "Open service" link building (docs/ACTIONS.md §2/§24/§26).
 *
 * Links are pure navigation: the browser opens the service's own web UI in a
 * new tab — DUMBscope never proxies them and no credentials/token are ever
 * embedded. Base URLs come from the integration config (validated http(s) on
 * write); this module only picks between internal and public and appends a
 * deep-link path built from stable upstream ids.
 */

export type LinkOpenPreference = 'auto' | 'internal' | 'public';

export interface LinkUrlConfig {
	/** Server-side API URL (internal). */
	url: string;
	/** Optional browser-facing URL; null/empty = fall back to `url`. */
	publicUrl: string | null;
}

function httpUrl(raw: string): URL | null {
	try {
		const url = new URL(raw);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
	} catch {
		return null;
	}
}

/**
 * Pick the base URL for opening a service. `auto`: when the browser is not
 * talking to the internal host (e.g. via reverse proxy), prefer the public
 * URL; otherwise use the internal one. Explicit settings always win.
 */
export function resolveWebUrl(
	config: LinkUrlConfig,
	preference: LinkOpenPreference,
	browserHost: string
): string | null {
	const internal = httpUrl(config.url);
	if (!internal) return null;
	const internalHost = internal.host;
	const publicParsed = config.publicUrl ? httpUrl(config.publicUrl) : null;

	if (preference === 'internal' || !publicParsed) return stripTrailingSlash(internal);
	if (preference === 'public') return stripTrailingSlash(publicParsed);
	// auto: off-host browser → public URL, otherwise internal.
	return browserHost && browserHost !== internalHost
		? stripTrailingSlash(publicParsed)
		: stripTrailingSlash(internal);
}

function stripTrailingSlash(url: URL): string {
	return url.toString().replace(/\/+$/, '');
}

/** Sonarr series page — only when a slug is known (§26: IDs only, else root). */
export function sonarrSeriesUrl(baseUrl: string | null, titleSlug: string | null): string | null {
	if (!baseUrl || !titleSlug || !/^[a-z0-9-]+$/i.test(titleSlug)) return baseUrl ?? null;
	return `${baseUrl}/series/${encodeURIComponent(titleSlug)}`;
}

/** Radarr movie page — only when a TMDB id is known, else the service root. */
export function radarrMovieUrl(baseUrl: string | null, tmdbId: number | null): string | null {
	if (!baseUrl) return null;
	if (tmdbId === null || !Number.isInteger(tmdbId) || tmdbId <= 0) return baseUrl;
	return `${baseUrl}/movie/${tmdbId}`;
}
