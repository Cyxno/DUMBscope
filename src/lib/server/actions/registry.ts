/**
 * Safe Actions registry (docs/ACTIONS.md). The complete set of control-plane
 * actions DUMBscope can execute — the allowlist IS the feature boundary.
 *
 * Hard non-goals (§42): no Docker socket, no shell, no arbitrary REST calls,
 * no generic command passthrough. Every entry targets exact upstream ids
 * resolved server-side from the integration store; the client can only name
 * a registered action id + a stable integration instance id.
 *
 * Execution paths are deliberately split:
 *  - media commands (search/refresh) → ActionsManager → Arr command API
 *  - `service.restart`               → the existing remediation layer
 *    (allowlist, preflight, 6 h cooldown, audit, verification — unchanged)
 *  - `service.open`                  → pure client navigation; the server
 *    never proxies it and no credentials travel in the URL (§2)
 */
import type { IntegrationType } from '../integrations/types';

/** Registry ids of the media commands executed through the Arr command API. */
export const MEDIA_ACTION_IDS = [
	'sonarr.searchEpisode',
	'sonarr.searchSeason',
	'sonarr.refreshSeries',
	'radarr.searchMovie',
	'radarr.refreshMovie'
] as const;

export type MediaActionId = (typeof MEDIA_ACTION_IDS)[number];

export type ActionCapability =
	| 'canSearchEpisode'
	| 'canSearchSeason'
	| 'canRefreshSeries'
	| 'canSearchMovie'
	| 'canRefreshMovie';

export interface MediaActionDefinition {
	id: MediaActionId;
	/** UI label, e.g. "Search again". */
	label: string;
	integrationType: Extract<IntegrationType, 'sonarr' | 'radarr'>;
	capability: ActionCapability;
	/** Short per-target cooldown — anti double-click/spam, not a safety gate. */
	cooldownMs: number;
	/** Honest one-line result message; "requested" ≠ "media found" (§11). */
	acceptedMessage: string;
}

/** Tuning: searches are cheap but shouldn't be spammed; refreshes touch more. */
export const ACTION_COOLDOWNS = {
	search: 60_000,
	refresh: 120_000
} as const;

export const MEDIA_ACTIONS: readonly MediaActionDefinition[] = [
	{
		id: 'sonarr.searchEpisode',
		label: 'Search again',
		integrationType: 'sonarr',
		capability: 'canSearchEpisode',
		cooldownMs: ACTION_COOLDOWNS.search,
		acceptedMessage: 'Search requested in Sonarr — watch the Library/Queue for a result'
	},
	{
		id: 'sonarr.searchSeason',
		label: 'Search season',
		integrationType: 'sonarr',
		capability: 'canSearchSeason',
		cooldownMs: ACTION_COOLDOWNS.search,
		acceptedMessage: 'Season search requested in Sonarr — watch the Library/Queue for results'
	},
	{
		id: 'sonarr.refreshSeries',
		label: 'Refresh series',
		integrationType: 'sonarr',
		capability: 'canRefreshSeries',
		cooldownMs: ACTION_COOLDOWNS.refresh,
		acceptedMessage: 'Series refresh requested in Sonarr'
	},
	{
		id: 'radarr.searchMovie',
		label: 'Search again',
		integrationType: 'radarr',
		capability: 'canSearchMovie',
		cooldownMs: ACTION_COOLDOWNS.search,
		acceptedMessage: 'Search requested in Radarr — watch the Library/Queue for a result'
	},
	{
		id: 'radarr.refreshMovie',
		label: 'Refresh movie',
		integrationType: 'radarr',
		capability: 'canRefreshMovie',
		cooldownMs: ACTION_COOLDOWNS.refresh,
		acceptedMessage: 'Movie refresh requested in Radarr'
	}
];

const MEDIA_ACTION_BY_ID = new Map(MEDIA_ACTIONS.map((a) => [a.id, a]));

export function getMediaAction(id: string): MediaActionDefinition | null {
	return MEDIA_ACTION_BY_ID.get(id as MediaActionId) ?? null;
}

/**
 * Structural validation of an action target. Ids must be positive integers
 * straight from browse keys (`sonarr-series-3`, `radarr-movie-9`) — no
 * titles, no free-form strings ever reach upstream (§4/§7).
 */
export interface MediaActionTarget {
	seriesId?: number;
	seasonNumber?: number;
	episodeIds?: number[];
	movieId?: number;
}

export type TargetValidation =
	{ ok: true; target: MediaActionTarget; targetKey: string } | { ok: false; error: string };

function isPositiveInt(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function validateMediaTarget(action: MediaActionDefinition, raw: unknown): TargetValidation {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, error: 'A target object is required' };
	}
	const t = raw as Record<string, unknown>;
	const seriesId = t.seriesId;
	const seasonNumber = t.seasonNumber;
	const episodeIds = t.episodeIds;
	const movieId = t.movieId;
	switch (action.id) {
		case 'sonarr.searchEpisode': {
			if (!Array.isArray(episodeIds) || episodeIds.length === 0) {
				return { ok: false, error: 'At least one episode id is required' };
			}
			if (episodeIds.length > 100) return { ok: false, error: 'Too many episode ids' };
			if (!episodeIds.every(isPositiveInt)) {
				return { ok: false, error: 'Episode ids must be positive integers' };
			}
			const ids = [...new Set(episodeIds as number[])].sort((a, b) => a - b);
			return {
				ok: true,
				target: { episodeIds: ids },
				targetKey: `episode:${ids.join(',')}`
			};
		}
		case 'sonarr.searchSeason': {
			if (!isPositiveInt(seriesId) || !isPositiveInt(seasonNumber)) {
				return { ok: false, error: 'A series id and season number are required' };
			}
			if ((seasonNumber as number) > 1000) return { ok: false, error: 'Invalid season number' };
			return {
				ok: true,
				target: { seriesId, seasonNumber },
				targetKey: `season:${seriesId}:${seasonNumber}`
			};
		}
		case 'sonarr.refreshSeries': {
			if (!isPositiveInt(seriesId)) return { ok: false, error: 'A series id is required' };
			return { ok: true, target: { seriesId }, targetKey: `series:${seriesId}` };
		}
		case 'radarr.searchMovie':
		case 'radarr.refreshMovie': {
			if (!isPositiveInt(movieId)) return { ok: false, error: 'A movie id is required' };
			return { ok: true, target: { movieId }, targetKey: `movie:${movieId}` };
		}
	}
}

/**
 * Static action capabilities per integration type (§19). The UI renders from
 * this — no name hardcoding. `service.open` needs only a URL, so it is
 * reported per config (url/publicUrl present), not per type.
 */
export interface IntegrationActionCapabilities {
	canSearchEpisode: boolean;
	canSearchSeason: boolean;
	canRefreshSeries: boolean;
	canSearchMovie: boolean;
	canRefreshMovie: boolean;
}

const EMPTY_CAPABILITIES: IntegrationActionCapabilities = {
	canSearchEpisode: false,
	canSearchSeason: false,
	canRefreshSeries: false,
	canSearchMovie: false,
	canRefreshMovie: false
};

export function capabilitiesForType(type: IntegrationType): IntegrationActionCapabilities {
	const caps: IntegrationActionCapabilities = { ...EMPTY_CAPABILITIES };
	for (const action of MEDIA_ACTIONS) {
		if (action.integrationType === type) caps[action.capability] = true;
	}
	return caps;
}
