/**
 * Stable media identity (DEEL 2).
 *
 * Priority (brief §10): Arr-native ids first, TMDB/TVDB next, and only as a
 * last resort a normalized title/year — title matching is never the default.
 * Every key is namespaced by the integration *instance* so two Sonarr
 * instances that happen to use the same numeric episode id can never collide
 * (brief §11).
 */

export type MediaFlowSource = 'sonarr' | 'radarr';

export function episodeKey(integrationId: string, episodeId: number): string {
	return `sonarr:${integrationId}:episode:${episodeId}`;
}

export function seriesKey(integrationId: string, seriesId: number): string {
	return `sonarr:${integrationId}:series:${seriesId}`;
}

export function movieKey(integrationId: string, movieId: number): string {
	return `radarr:${integrationId}:movie:${movieId}`;
}

/** Which integration instance a media key belongs to. */
export function integrationOf(mediaKey: string): string | null {
	const parts = mediaKey.split(':');
	return parts.length >= 2 ? (parts[1] ?? null) : null;
}

/** Coarse bucket for the UI badge: 'episode' | 'movie' | null. */
export function kindOf(mediaKey: string): 'sonarr' | 'radarr' | null {
	return mediaKey.startsWith('sonarr:')
		? 'sonarr'
		: mediaKey.startsWith('radarr:')
			? 'radarr'
			: null;
}

/**
 * Derive the acquisition client name from the Arr's download-client label.
 * The real stack uses emulated clients: InfiniDysk presents a SABnzbd API,
 * Decypharr presents a qBittorrent API — so the client label at the Arr
 * boundary is exactly the acquisition-path signal (proven by the 2026-09-14
 * source audit; see docs/MEDIA-CORRELATION.md).
 */
export function acquisitionPath(
	client: string | null
): 'infinidysk' | 'decypharr' | 'other' | null {
	if (!client) return null;
	const c = client.toLowerCase();
	if (c.includes('sab')) return 'infinidysk';
	if (c.includes('qbittorrent') || c.includes('qbit')) return 'decypharr';
	return 'other';
}
