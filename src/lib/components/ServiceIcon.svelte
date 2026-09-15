<script lang="ts">
	import {
		Tv,
		Film,
		Music,
		BookOpen,
		Clapperboard,
		Search,
		CloudDownload,
		Database,
		Captions,
		MonitorPlay,
		Ticket,
		Activity,
		Sparkles,
		Terminal,
		Link2,
		Box,
		Server,
		Zap,
		FolderSync,
		Cloud,
		Play,
		Compass,
		SlidersHorizontal,
		Radar,
		ArrowDownUp,
		Bell,
		HardDriveDownload,
		Download,
		Shuffle,
		BatteryCharging,
		CloudCog,
		Lock,
		Gauge,
		DatabaseZap,
		Wrench,
		ListChecks
	} from '@lucide/svelte';
	import type { Component } from 'svelte';
	import type { DiscoveredService } from '$lib/types';
	import { matchCatalogId } from '$lib/utils/catalog';

	const ICONS: Record<string, Component> = {
		'dumb-frontend': Server,
		'dumb-api': Server,
		sonarr: Tv,
		radarr: Film,
		lidarr: Music,
		readarr: BookOpen,
		whisparr: Clapperboard,
		bazarr: Captions,
		prowlarr: Search,
		jackett: Search,
		decypharr: CloudDownload,
		nzbdav: CloudDownload,
		altmount: HardDriveDownload,
		sabnzbd: Download,
		nzbget: Download,
		infinidysk: Cloud,
		zurg: Zap,
		rclone: FolderSync,
		postgres: Database,
		mysql: Database,
		plex: Play,
		jellyfin: MonitorPlay,
		emby: MonitorPlay,
		seerr: Ticket,
		'seerr-sync': Ticket,
		pulsarr: Bell,
		tautulli: Activity,
		kometa: Sparkles,
		riven: ArrowDownUp,
		neutarr: Compass,
		profilarr: SlidersHorizontal,
		zilean: Radar,
		'cli-debrid': Terminal,
		'cli-battery': BatteryCharging,
		symlink: Link2,
		maintainerr: Wrench,
		aiostreams: ListChecks,
		mediastorm: Shuffle,
		'traefik-proxy-admin': Gauge,
		traefik: ArrowDownUp,
		authelia: Lock,
		cloudflared: CloudCog,
		pgadmin: DatabaseZap,
		'phalanx-db': DatabaseZap,
		generic: Box
	};

	let { service, size = 36 }: { service: Pick<DiscoveredService, 'name' | 'key'>; size?: number } =
		$props();

	const Icon = $derived(ICONS[matchCatalogId(service.name, service.key)] ?? Box);
	const unknown = $derived(Icon === Box);
</script>

<span
	class="service-icon inline-flex shrink-0 items-center justify-center rounded-[10px] border border-border-subtle bg-surface-2 text-text-secondary"
	style="width:{size}px;height:{size}px"
	title={unknown ? 'Unknown service' : service.name}
>
	<Icon size={Math.round(size * 0.5)} strokeWidth={1.75} aria-hidden="true" />
</span>

<style>
	.service-icon {
		box-shadow: var(--shadow-1);
	}
</style>
