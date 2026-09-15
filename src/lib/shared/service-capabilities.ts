/**
 * Service support matrix — single machine-readable source of truth (§64).
 *
 * The compatibility documentation (docs/COMPATIBILITY.md) and the README
 * compatibility section are generated from this table; a unit test
 * (tests/service-capabilities.test.ts) fails when docs drift from code.
 *
 * Evidence rules:
 * - "Real Tested" is only claimed for services verified against the live
 *   DUMB installation (v2.22.x, 11 enabled services, all healthy in v0.6.0).
 * - "Contract Tested" means an automated test exercises the service's
 *   registry/identity/behavior shape against tests/fixtures/services/.
 * - Deep integration requires a native adapter in
 *   src/lib/server/integrations/ — absence is reported honestly, never
 *   claimed.
 */

export interface ServiceCapability {
	/** Catalog id — must exist in CATALOG (validated by test). */
	id: string;
	displayName: string;
	/** DUMB discovers and reports the service (process registry). */
	discovery: boolean;
	/** Running/stopped state, process identity, CPU/memory, logs. */
	basicMonitoring: boolean;
	/** Service-specific health semantics, incidents/findings, diagnostics. */
	operationalMonitoring: boolean;
	/** Native API/domain data (Library, queue, subtitles, playback). */
	deepIntegration: boolean;
	/** Safe restart through DUMB's own management route. */
	remediation: boolean;
	/** Behavior verified against the registry/contract fixture. */
	contractTested: boolean;
	/** Verified against the real, running instance on the reference stack. */
	realTested: boolean;
	/** DUMB's config knows this service (it can manage it at all). */
	managedByDumb: boolean;
	notes?: string;
}

export const SERVICE_CAPABILITIES: ServiceCapability[] = [
	// ------------------------------------------------------------------ core
	{
		id: 'dumb-frontend',
		displayName: 'DUMB Frontend',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: true,
		managedByDumb: true
	},
	{
		id: 'dumb-api',
		displayName: 'DUMB API',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: true,
		managedByDumb: true,
		notes: 'Gateway the whole product observes; connection incidents cover it.'
	},

	// ------------------------------------------------------------- managers
	{
		id: 'sonarr',
		displayName: 'Sonarr',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: true,
		remediation: true,
		contractTested: true,
		realTested: true,
		managedByDumb: true,
		notes: 'Multi-instance aware (e.g. "Sonarr Anime"). Library: TV, missing, upgrades, media flow.'
	},
	{
		id: 'radarr',
		displayName: 'Radarr',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: true,
		remediation: true,
		contractTested: true,
		realTested: true,
		managedByDumb: true,
		notes:
			'Multi-instance aware (e.g. "Radarr 4K"). Library: movies, missing, upgrades, media flow.'
	},
	{
		id: 'lidarr',
		displayName: 'Lidarr',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true,
		notes: 'Basic monitoring only — no music library adapter.'
	},
	{
		id: 'readarr',
		displayName: 'Readarr',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: false,
		notes: 'In the catalog for generic matching; not part of the current DUMB config surface.'
	},
	{
		id: 'whisparr',
		displayName: 'Whisparr',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true,
		notes: 'Basic monitoring only.'
	},

	// ------------------------------------------------------------ subtitles
	{
		id: 'bazarr',
		displayName: 'Bazarr',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: true,
		remediation: true,
		contractTested: true,
		realTested: true,
		managedByDumb: true,
		notes: 'Subtitles browser: language profiles, episode/movie gaps.'
	},

	// ------------------------------------------------------------- indexers
	{
		id: 'prowlarr',
		displayName: 'Prowlarr',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: true,
		managedByDumb: true,
		notes: 'Deep health monitoring adapter (poller), no library data.'
	},
	{
		id: 'jackett',
		displayName: 'Jackett',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: false,
		notes: 'Generic matching only; not managed by the current DUMB config surface.'
	},

	// -------------------------------------------------------------- debrid
	{
		id: 'decypharr',
		displayName: 'Decypharr',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: true,
		managedByDumb: true
	},
	{
		id: 'nzbdav',
		displayName: 'NZB Dav',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: false,
		notes: 'Referenced via DUMB mounts in the reference stack; generic matching.'
	},
	{
		id: 'altmount',
		displayName: 'AltMount',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},
	{
		id: 'cli-debrid',
		displayName: 'CLI Debrid',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},

	// -------------------------------------------------------------- usenet
	{
		id: 'sabnzbd',
		displayName: 'SABnzbd',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: false,
		notes: 'Generic matching only; not managed by the current DUMB config surface.'
	},
	{
		id: 'nzbget',
		displayName: 'NZBGet',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: false,
		notes: 'Generic matching only; not managed by the current DUMB config surface.'
	},

	// ---------------------------------------------------------- mount/bridge
	{
		id: 'rclone',
		displayName: 'rclone',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true,
		notes: 'Multi-instance naming verified ("rclone w/ RealDebrid").'
	},
	{
		id: 'infinidysk',
		displayName: 'InfiniDysk',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: true,
		managedByDumb: true,
		notes: 'Memory anomaly findings cover it on the reference stack.'
	},
	{
		id: 'zurg',
		displayName: 'Zurg',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true,
		notes: 'Multi-instance naming verified ("Zurg w/ RealDebrid").'
	},
	{
		id: 'cli-battery',
		displayName: 'CLI Battery',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},

	// ------------------------------------------------------------ database
	{
		id: 'postgres',
		displayName: 'PostgreSQL',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true,
		notes: 'Database health observations surface as critical incidents.'
	},
	{
		id: 'mysql',
		displayName: 'MySQL',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: false,
		notes: 'Generic matching only; not managed by the current DUMB config surface.'
	},
	{
		id: 'pgadmin',
		displayName: 'pgAdmin',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},
	{
		id: 'phalanx-db',
		displayName: 'Phalanx DB',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},

	// --------------------------------------------------------- media server
	{
		id: 'plex',
		displayName: 'Plex',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: true,
		managedByDumb: true,
		notes: 'Deep health monitoring adapter (poller), no playback data yet.'
	},
	{
		id: 'jellyfin',
		displayName: 'Jellyfin',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true,
		notes: 'Basic monitoring only — deep integration not yet implemented.'
	},
	{
		id: 'emby',
		displayName: 'Emby',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true,
		notes: 'Basic monitoring only — deep integration not yet implemented.'
	},

	// --------------------------------------------------------- requests etc.
	{
		id: 'seerr',
		displayName: 'Seerr',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: true,
		managedByDumb: true,
		notes: 'Matches Overseerr/Jellyseerr process names too. Deep health adapter.'
	},
	{
		id: 'seerr-sync',
		displayName: 'Seerr Sync',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},
	{
		id: 'pulsarr',
		displayName: 'Pulsarr',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},
	{
		id: 'tautulli',
		displayName: 'Tautulli',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: true,
		managedByDumb: true,
		notes: 'Deep health monitoring adapter (poller), no playback data yet.'
	},
	{
		id: 'kometa',
		displayName: 'Kometa',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: false,
		notes: 'Generic matching only; not managed by the current DUMB config surface.'
	},
	{
		id: 'maintainerr',
		displayName: 'Maintainerr',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},
	{
		id: 'aiostreams',
		displayName: 'AIOStreams',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},
	{
		id: 'mediastorm',
		displayName: 'MediaStorm',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},
	{
		id: 'riven',
		displayName: 'Riven',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true,
		notes: 'Covers Riven Backend and Riven Frontend process names.'
	},
	{
		id: 'neutarr',
		displayName: 'Neutarr',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},
	{
		id: 'profilarr',
		displayName: 'Profilarr',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},
	{
		id: 'zilean',
		displayName: 'Zilean',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},
	{
		id: 'symlink',
		displayName: 'Symlink Manager',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: false,
		notes: 'Generic matching (symlink roots); not a DUMB config service key.'
	},

	// --------------------------------------------- infrastructure (network)
	{
		id: 'traefik',
		displayName: 'Traefik',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},
	{
		id: 'traefik-proxy-admin',
		displayName: 'Traefik Proxy Admin',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},
	{
		id: 'authelia',
		displayName: 'Authelia',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	},
	{
		id: 'cloudflared',
		displayName: 'Cloudflared',
		discovery: true,
		basicMonitoring: true,
		operationalMonitoring: true,
		deepIntegration: false,
		remediation: true,
		contractTested: true,
		realTested: false,
		managedByDumb: true
	}
];

/** Services DUMB can manage that no reference install ran (contract-only). */
export function contractOnlyServices(): ServiceCapability[] {
	return SERVICE_CAPABILITIES.filter((service) => !service.realTested);
}
