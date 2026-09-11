/**
 * Service catalog: metadata for services commonly managed by DUMB.
 *
 * This is *additive* knowledge — DUMB remains the source of truth for what is
 * installed and how it is doing. Unknown services are handled by the generic
 * adapter and still appear everywhere with full generic monitoring.
 */
import type { PipelineCategory } from '$lib/types';

export interface CatalogEntry {
	/** Match pattern against the process name / key (case-insensitive). */
	match: RegExp;
	/** Canonical key used for icons/links. */
	id: string;
	displayName: string;
	category: PipelineCategory;
	/** Short user-facing description ("TV automation"). Central copy. */
	descriptor?: string;
	/** Dependencies by catalog id, resolved only when those services exist. */
	dependsOn?: string[];
	/** Dependency by category: edge to the first (or all) services in it. */
	dependsOnCategory?: PipelineCategory[];
	homeUrl?: string;
}

export const CATALOG: CatalogEntry[] = [
	{
		id: 'dumb-frontend',
		match: /^dumb frontend/i,
		displayName: 'DUMB Frontend',
		category: 'core',
		descriptor: 'Web interface',
		dependsOn: []
	},
	{
		id: 'dumb-api',
		match: /^dumb api/i,
		displayName: 'DUMB API',
		category: 'core',
		descriptor: 'Gateway API',
		dependsOn: []
	},

	{
		id: 'sonarr',
		match: /sonarr/i,
		displayName: 'Sonarr',
		category: 'manager',
		descriptor: 'TV automation',
		dependsOn: ['prowlarr'],
		dependsOnCategory: ['indexer', 'debrid', 'usenet', 'acquisition', 'database']
	},
	{
		id: 'radarr',
		match: /radarr/i,
		displayName: 'Radarr',
		category: 'manager',
		descriptor: 'Movie automation',
		dependsOn: ['prowlarr'],
		dependsOnCategory: ['indexer', 'debrid', 'usenet', 'acquisition', 'database']
	},
	{
		id: 'lidarr',
		match: /lidarr/i,
		displayName: 'Lidarr',
		category: 'manager',
		descriptor: 'Music automation',
		dependsOn: ['prowlarr'],
		dependsOnCategory: ['indexer', 'debrid', 'usenet', 'acquisition']
	},
	{
		id: 'readarr',
		match: /readarr/i,
		displayName: 'Readarr',
		category: 'manager',
		descriptor: 'Book automation',
		dependsOn: ['prowlarr'],
		dependsOnCategory: ['indexer', 'acquisition']
	},
	{
		id: 'whisparr',
		match: /whisparr/i,
		displayName: 'Whisparr',
		category: 'manager',
		descriptor: 'Adult media automation',
		dependsOn: ['prowlarr'],
		dependsOnCategory: ['indexer', 'acquisition']
	},
	{
		id: 'bazarr',
		match: /bazarr/i,
		displayName: 'Bazarr',
		category: 'subtitles',
		descriptor: 'Subtitles',
		dependsOnCategory: ['manager', 'media-server']
	},

	{
		id: 'prowlarr',
		match: /prowlarr/i,
		displayName: 'Prowlarr',
		category: 'indexer',
		descriptor: 'Indexer management',
		dependsOn: []
	},
	{
		id: 'jackett',
		match: /jackett/i,
		displayName: 'Jackett',
		category: 'indexer',
		descriptor: 'Indexer proxy',
		dependsOn: []
	},

	{
		id: 'decypharr',
		match: /decypharr/i,
		displayName: 'Decypharr',
		category: 'debrid',
		descriptor: 'Debrid acquisition',
		dependsOn: ['infinidysk'],
		dependsOnCategory: ['bridge']
	},
	{
		id: 'nzbdav',
		match: /nzbdav/i,
		displayName: 'NZB Dav',
		category: 'debrid',
		descriptor: 'Usenet downloads',
		dependsOnCategory: ['bridge', 'mount']
	},
	{
		id: 'altmount',
		match: /altmount/i,
		displayName: 'AltMount',
		category: 'debrid',
		descriptor: 'Debrid mounting',
		dependsOnCategory: ['bridge']
	},
	{
		id: 'sabnzbd',
		match: /sabnzbd|sab nzbd/i,
		displayName: 'SABnzbd',
		category: 'usenet',
		descriptor: 'Usenet downloads',
		dependsOn: []
	},
	{
		id: 'nzbget',
		match: /nzbget/i,
		displayName: 'NZBGet',
		category: 'usenet',
		descriptor: 'Usenet downloads',
		dependsOn: []
	},

	{
		id: 'rclone',
		match: /rclone/i,
		displayName: 'rclone',
		category: 'mount',
		descriptor: 'Cloud mount',
		dependsOnCategory: ['bridge']
	},
	{
		id: 'infinidysk',
		match: /infini\s?dysk/i,
		displayName: 'InfiniDysk',
		category: 'bridge',
		descriptor: 'Storage bridge',
		dependsOn: ['postgres'],
		dependsOnCategory: ['database']
	},
	{
		id: 'zurg',
		match: /zurg/i,
		displayName: 'Zurg',
		category: 'bridge',
		descriptor: 'Debrid bridge',
		dependsOn: []
	},
	{
		id: 'postgres',
		match: /postgres/i,
		displayName: 'PostgreSQL',
		category: 'database',
		descriptor: 'Database',
		dependsOn: []
	},
	{
		id: 'mysql',
		match: /mysql|mariadb/i,
		displayName: 'MySQL',
		category: 'database',
		descriptor: 'Database',
		dependsOn: []
	},

	{
		id: 'plex',
		match: /\bplex\b(?!.*status)/i,
		displayName: 'Plex',
		category: 'media-server',
		descriptor: 'Media playback',
		dependsOnCategory: ['mount', 'bridge', 'storage']
	},
	{
		id: 'jellyfin',
		match: /jellyfin/i,
		displayName: 'Jellyfin',
		category: 'media-server',
		descriptor: 'Media playback',
		dependsOnCategory: ['mount', 'bridge', 'storage']
	},
	{
		id: 'emby',
		match: /emby/i,
		displayName: 'Emby',
		category: 'media-server',
		descriptor: 'Media playback',
		dependsOnCategory: ['mount', 'bridge', 'storage']
	},

	{
		id: 'seerr',
		match: /(jelly|over)?seerr/i,
		displayName: 'Seerr',
		category: 'request',
		descriptor: 'Media requests',
		dependsOnCategory: ['manager']
	},
	{
		id: 'pulsarr',
		match: /pulsarr/i,
		displayName: 'Pulsarr',
		category: 'request',
		descriptor: 'Requests relay',
		dependsOnCategory: ['manager']
	},
	{
		id: 'tautulli',
		match: /tautulli/i,
		displayName: 'Tautulli',
		category: 'analytics',
		descriptor: 'Playback analytics',
		dependsOn: ['plex'],
		dependsOnCategory: ['media-server']
	},
	{
		id: 'kometa',
		match: /kometa/i,
		displayName: 'Kometa',
		category: 'analytics',
		descriptor: 'Library management',
		dependsOn: ['plex'],
		dependsOnCategory: ['media-server']
	},
	{
		id: 'riven',
		match: /riven/i,
		displayName: 'Riven',
		category: 'import',
		descriptor: 'Import pipeline',
		dependsOnCategory: ['debrid', 'bridge']
	},
	{
		id: 'neutarr',
		match: /neutarr/i,
		displayName: 'Neutarr',
		category: 'discovery',
		descriptor: 'Discovery automation',
		dependsOnCategory: ['manager']
	},
	{
		id: 'profilarr',
		match: /profilarr/i,
		displayName: 'Profilarr',
		category: 'manager',
		descriptor: 'Config sync',
		dependsOnCategory: ['manager']
	},
	{
		id: 'zilean',
		match: /zilean/i,
		displayName: 'Zilean',
		category: 'discovery',
		descriptor: 'Debrid search cache',
		dependsOn: []
	},
	{
		id: 'cli-debrid',
		match: /cli ?debrid/i,
		displayName: 'CLI Debrid',
		category: 'debrid',
		descriptor: 'Debrid acquisition',
		dependsOnCategory: ['bridge', 'mount']
	},
	{
		id: 'symlink',
		match: /symlink/i,
		displayName: 'Symlink Manager',
		category: 'storage',
		descriptor: 'Library links',
		dependsOnCategory: ['bridge']
	}
];

/**
 * Catalog ids that have a deep-monitoring integration type in the app.
 * Used only to word the drawer's empty state correctly: "not configured"
 * (capability exists) versus "basic monitoring" (no adapter at all).
 */
export const INTEGRATION_CAPABLE_IDS = new Set([
	'sonarr',
	'radarr',
	'prowlarr',
	'seerr',
	'plex',
	'tautulli'
]);

/** Find catalog metadata for a DUMB service name/key. */
export function matchCatalog(name: string, key: string): CatalogEntry | null {
	for (const entry of CATALOG) {
		if (entry.match.test(name) || entry.match.test(key)) return entry;
	}
	return null;
}

export const CATEGORY_ORDER: PipelineCategory[] = [
	'core',
	'request',
	'discovery',
	'manager',
	'indexer',
	'acquisition',
	'usenet',
	'debrid',
	'bridge',
	'mount',
	'storage',
	'database',
	'import',
	'subtitles',
	'media-server',
	'analytics',
	'auxiliary'
];

export const CATEGORY_LABELS: Record<PipelineCategory, string> = {
	core: 'Core',
	request: 'Requests',
	discovery: 'Discovery',
	manager: 'Library managers',
	indexer: 'Indexers',
	acquisition: 'Acquisition',
	usenet: 'Usenet',
	debrid: 'Debrid',
	bridge: 'Bridge',
	mount: 'Mount',
	storage: 'Storage / cache',
	database: 'Database',
	import: 'Import',
	subtitles: 'Subtitles',
	'media-server': 'Media server',
	analytics: 'Analytics',
	auxiliary: 'Other services'
};
