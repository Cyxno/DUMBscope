<script lang="ts">
	/**
	 * Series detail (§11-§26): header renders instantly from list data (§133),
	 * seasons accordion collapses episodes out of the DOM (§15), episode rows
	 * expand to file/queue/subtitle detail (§21/§26). Specials stay separate
	 * from the main seasons (§16). Read-only throughout.
	 */
	import PosterImage from './PosterImage.svelte';
	import { relativeTime, formatBytes } from '$lib/utils/format';
	import {
		episodeStateClass,
		formatDate,
		daysAgo,
		qualityBadge,
		seriesStatusLabel
	} from '$lib/utils/library-ui';
	import { ChevronDown } from '@lucide/svelte';

	export interface SeriesFull {
		key: string;
		id: number;
		title: string;
		year: number | null;
		status: string;
		monitored: boolean;
		network: string | null;
		runtime: number | null;
		genres: string[];
		seriesType: string;
		qualityProfile: string | null;
		seasons: {
			seasonNumber: number;
			monitored: boolean;
			fileCount: number;
			airedCount: number;
			totalCount: number;
			sizeOnDiskBytes: number;
		}[];
		episodeFileCount: number;
		episodeCount: number;
		episodeFutureCount: number;
		missingCount: number;
		completionPct: number | null;
		sizeOnDiskBytes: number;
		addedAt: number | null;
		path: string | null;
		posterVersion: string | null;
	}
	interface EpisodeRow {
		id: number;
		seasonNumber: number;
		episodeNumber: number;
		title: string | null;
		airDateUtc: number | null;
		monitored: boolean;
		hasFile: boolean;
		state: string;
		quality: string | null;
		sizeBytes: number | null;
		releaseGroup: string | null;
		dateAdded: number | null;
		languages: string[];
		customFormats: string[];
		releaseTitle: string | null;
		upgradeAvailable: boolean;
		queue: { state: string; progress: number | null } | null;
		subtitles: {
			present: { code2: string; name: string; forced: boolean; hearingImpaired: boolean }[];
			missing: { code2: string; name: string }[];
		} | null;
	}
	interface SeasonGroup {
		seasonNumber: number;
		monitored: boolean;
		fileCount: number;
		airedCount: number;
		totalCount: number;
		episodes: EpisodeRow[];
	}

	/** Light shape passed from the grid for an instant header (§133); the
	 *  full detail response supersedes it field by field. */
	interface SeriesSummaryLite {
		key: string;
		title: string;
		year?: number | null;
		status?: string;
		monitored?: boolean;
		network?: string | null;
		seasonsCount?: number;
		missingCount?: number;
		completionPct?: number | null;
		posterVersion?: string | null;
	}
	type SeriesShape = SeriesSummaryLite & Partial<SeriesFull>;

	let { itemKey, summary }: { itemKey: string; summary: SeriesSummaryLite | null } = $props();

	let series = $state<SeriesShape | null>(summary);
	let seasons = $state<SeasonGroup[]>([]);
	let upgradeCount = $state<number | null>(null);
	let episodesLoading = $state(true);
	let episodesError = $state<string | null>(null);
	let enabledLanguages = $state<{ code2: string; name: string }[]>([]);
	let expandedSeasons = $state<Set<number>>(new Set());
	let expandedEpisode = $state<number | null>(null);
	let showTechnical = $state(false);
	let notFound = $state(false);

	$effect(() => {
		if (summary && !series) series = summary;
	});

	$effect(() => {
		void itemKey;
		series = summary;
		notFound = false;
		seasons = [];
		upgradeCount = null;
		episodesLoading = true;
		episodesError = null;
		expandedSeasons = new Set();
		expandedEpisode = null;
		showTechnical = false;
		void load();
	});

	async function load(): Promise<void> {
		try {
			const [detailResponse, episodesResponse] = await Promise.all([
				fetch(`/api/library/tv/${itemKey}`),
				fetch(`/api/library/tv/${itemKey}/episodes`)
			]);
			if (detailResponse.status === 404) {
				notFound = true;
				return;
			}
			if (detailResponse.ok) {
				const data = (await detailResponse.json()) as { series: SeriesFull };
				series = data.series;
			}
			if (episodesResponse.ok) {
				const data = (await episodesResponse.json()) as {
					seasons: SeasonGroup[];
					upgradeCount: number;
					enabledLanguages: { code2: string; name: string }[];
				};
				seasons = data.seasons;
				upgradeCount = data.upgradeCount;
				enabledLanguages = data.enabledLanguages ?? [];
			} else {
				episodesError = 'Episode data is temporarily unavailable.';
			}
		} catch {
			episodesError = 'Episode data is temporarily unavailable.';
		} finally {
			episodesLoading = false;
		}
	}

	const seasonsLabel = $derived(
		series
			? series.seasons
				? series.seasons.filter((s) => s.seasonNumber > 0).length
				: (series.seasonsCount ?? 0)
			: 0
	);

	function toggleSeason(n: number): void {
		const next = new Set(expandedSeasons);
		if (next.has(n)) next.delete(n);
		else next.add(n);
		expandedSeasons = next;
	}

	function seasonLabel(n: number): string {
		return n === 0 ? 'Specials' : `Season ${n}`;
	}

	function toggleEpisode(id: number): void {
		expandedEpisode = expandedEpisode === id ? null : id;
	}

	const mainSeasons = $derived(seasons.filter((s) => s.seasonNumber > 0));
	const specials = $derived(seasons.filter((s) => s.seasonNumber === 0));

	function chipsFor(episode: EpisodeRow): { code2: string; name: string; present: boolean }[] {
		if (!episode.subtitles) return [];
		const wanted = new Map(episode.subtitles.missing.map((m) => [m.code2, m.name]));
		const present = new Map(episode.subtitles.present.map((p) => [p.code2, p.name]));
		const enabled = new Map(enabledLanguages.map((l) => [l.code2, l.name]));
		const codes = new Set<string>([...wanted.keys(), ...present.keys(), ...enabled.keys()]);
		return [...codes]
			.slice(0, 6)
			.map((code) => ({
				code2: code,
				name: wanted.get(code) ?? enabled.get(code) ?? present.get(code) ?? code.toUpperCase(),
				present: present.has(code)
			}))
			.sort((a, b) => Number(a.present) - Number(b.present));
	}
</script>

{#if series}
	<!-- Header (§11) -->
	<div class="flex gap-4">
		<div class="w-24 shrink-0 sm:w-28">
			<PosterImage itemKey={series.key} title={series.title} version={series.posterVersion} />
		</div>
		<div class="min-w-0 flex-1">
			<h3 class="text-[15px] font-semibold tracking-tight text-text-primary">{series.title}</h3>
			<p class="mt-0.5 text-xs text-text-muted">
				{seriesStatusLabel(series.status ?? 'continuing')}
				{#if series.network}· {series.network}{/if}
				{#if series.year}
					· {series.year}{series.status === 'ended' ? '' : '–'}
				{/if}
			</p>
			<div class="mt-2 flex flex-wrap items-center gap-2 text-[11.5px]">
				<span class="rounded-full bg-surface-3 px-2 py-0.5 text-text-secondary">
					{seasonsLabel}
					{seasonsLabel === 1 ? 'season' : 'seasons'}
				</span>
				{#if series.completionPct !== null}
					<span class="rounded-full bg-surface-3 px-2 py-0.5 tnum text-text-secondary">
						{series.completionPct}% complete
					</span>
				{/if}
				{#if (series.missingCount ?? 0) > 0}
					<span class="rounded-full bg-degraded-soft px-2 py-0.5 tnum text-degraded">
						{series.missingCount} missing
					</span>
				{/if}
				{#if upgradeCount}
					<span class="rounded-full bg-accent-soft px-2 py-0.5 tnum text-accent-text">
						{upgradeCount} upgrades
					</span>
				{/if}
				{#if series.monitored !== undefined}
					<span
						class="rounded-full px-2 py-0.5 {series.monitored
							? 'bg-surface-3 text-text-muted'
							: 'bg-unknown-soft text-text-muted'}"
					>
						{series.monitored ? 'Monitored' : 'Not monitored'}
					</span>
				{/if}
			</div>
		</div>
	</div>

	<!-- Library status (§13) -->
	<div
		class="grid grid-cols-2 gap-2 rounded-[14px] border border-border-subtle bg-surface-1 p-3 sm:grid-cols-4"
	>
		<div>
			<p class="text-[10px] font-bold uppercase tracking-[0.1em] text-text-faint">Episodes</p>
			<p class="tnum mt-0.5 text-sm font-semibold text-text-primary">
				{series.episodeFileCount ?? '…'} / {series.episodeCount ?? '…'}
			</p>
		</div>
		<div>
			<p class="text-[10px] font-bold uppercase tracking-[0.1em] text-text-faint">Missing</p>
			<p
				class="tnum mt-0.5 text-sm font-semibold {(series.missingCount ?? 0) > 0
					? 'text-degraded'
					: 'text-text-primary'}"
			>
				{series.missingCount ?? '…'}
			</p>
		</div>
		<div>
			<p class="text-[10px] font-bold uppercase tracking-[0.1em] text-text-faint">Upgrades</p>
			<p class="tnum mt-0.5 text-sm font-semibold text-text-primary">{upgradeCount ?? '…'}</p>
		</div>
		<div>
			<p class="text-[10px] font-bold uppercase tracking-[0.1em] text-text-faint">Upcoming</p>
			<p class="tnum mt-0.5 text-sm font-semibold text-text-primary">
				{series.episodeFutureCount ?? '…'}
			</p>
		</div>
	</div>

	<!-- Metadata (§12): user-friendly only; path/IDs under technical -->
	<div class="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-text-muted">
		{#if series.qualityProfile}<span
				>Quality profile: <b class="font-medium text-text-secondary">{series.qualityProfile}</b
				></span
			>{/if}
		{#if series.runtime}<span class="tnum">Runtime: {series.runtime} min</span>{/if}
		{#if (series.genres?.length ?? 0) > 0}<span class="min-w-0 truncate"
				>{series.genres?.slice(0, 4).join(', ') ?? ''}</span
			>{/if}
		<span>{series.seriesType === 'standard' ? '' : `Type: ${series.seriesType}`}</span>
	</div>

	<!-- Seasons (§14/§15) -->
	<div class="space-y-1.5">
		<h4 class="text-[11px] font-bold uppercase tracking-[0.1em] text-text-faint">Seasons</h4>
		{#if episodesLoading}
			<div class="space-y-1.5" aria-hidden="true">
				{#each Array(3) as _, i (i)}
					<div class="h-10 animate-pulse rounded-lg bg-surface-2"></div>
				{/each}
			</div>
		{:else if episodesError}
			<p
				class="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-xs text-degraded"
			>
				{episodesError}
			</p>
		{:else}
			{#each mainSeasons as season (season.seasonNumber)}
				<div class="overflow-hidden rounded-lg border border-border-subtle bg-surface-1">
					<button
						type="button"
						class="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2"
						aria-expanded={expandedSeasons.has(season.seasonNumber)}
						onclick={() => toggleSeason(season.seasonNumber)}
					>
						<ChevronDown
							size={14}
							class="shrink-0 text-text-faint transition-transform {expandedSeasons.has(
								season.seasonNumber
							)
								? 'rotate-180'
								: ''}"
						/>
						<span class="w-24 shrink-0 text-[12.5px] font-medium text-text-primary">
							{seasonLabel(season.seasonNumber)}
						</span>
						<span class="tnum text-[11.5px] text-text-muted">
							{season.fileCount} / {season.airedCount}
						</span>
						<div class="h-1 min-w-10 flex-1 overflow-hidden rounded-full bg-surface-3">
							<div
								class="h-full rounded-full {season.airedCount > 0 &&
								season.fileCount >= season.airedCount
									? 'bg-healthy/70'
									: 'bg-accent/70'}"
								style="width: {season.airedCount > 0
									? Math.max(2, Math.min(100, (season.fileCount / season.airedCount) * 100))
									: 2}%"
							></div>
						</div>
						<span
							class="w-16 shrink-0 text-right text-[11px] {season.airedCount - season.fileCount > 0
								? 'text-degraded'
								: 'text-healthy'}"
						>
							{season.airedCount - season.fileCount > 0
								? `${season.airedCount - season.fileCount} missing`
								: 'Complete'}
						</span>
					</button>
					{#if expandedSeasons.has(season.seasonNumber)}
						<ul class="divide-y divide-border-subtle border-t border-border-subtle">
							{#each season.episodes as episode (episode.id)}
								{@render episodeRow(episode)}
							{/each}
						</ul>
					{/if}
				</div>
			{/each}
			{#each specials as season (season.seasonNumber)}
				<div class="overflow-hidden rounded-lg border border-border-subtle bg-surface-1">
					<button
						type="button"
						class="flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-surface-2"
						aria-expanded={expandedSeasons.has(0)}
						onclick={() => toggleSeason(0)}
					>
						<ChevronDown
							size={14}
							class="shrink-0 text-text-faint transition-transform {expandedSeasons.has(0)
								? 'rotate-180'
								: ''}"
						/>
						<span class="w-24 shrink-0 text-[12.5px] font-medium text-text-muted">Specials</span>
						<span class="tnum text-[11.5px] text-text-faint">
							{season.fileCount} / {season.totalCount}
						</span>
					</button>
					{#if expandedSeasons.has(0)}
						<ul class="divide-y divide-border-subtle border-t border-border-subtle">
							{#each season.episodes as episode (episode.id)}
								{@render episodeRow(episode)}
							{/each}
						</ul>
					{/if}
				</div>
			{/each}
		{/if}
	</div>

	<!-- Technical details (§122): paths and ids live here only -->
	<div>
		<button
			type="button"
			class="text-[11px] font-medium text-text-faint transition-colors hover:text-text-muted"
			aria-expanded={showTechnical}
			onclick={() => (showTechnical = !showTechnical)}
		>
			{showTechnical ? 'Hide' : 'Show'} technical details
		</button>
		{#if showTechnical}
			<dl
				class="mt-2 space-y-1 rounded-lg border border-border-subtle bg-surface-1 p-3 text-[11px] text-text-muted"
			>
				{#if series.path}
					<div class="flex gap-2">
						<dt class="w-24 shrink-0 text-text-faint">Path</dt>
						<dd class="min-w-0 break-all">{series.path}</dd>
					</div>
				{/if}
				{#if series.id}
					<div class="flex gap-2">
						<dt class="w-24 shrink-0 text-text-faint">Sonarr id</dt>
						<dd class="tnum">{series.id}</dd>
					</div>
				{/if}
				<div class="flex gap-2">
					<dt class="w-24 shrink-0 text-text-faint">On disk</dt>
					<dd class="tnum">{formatBytes(series.sizeOnDiskBytes)}</dd>
				</div>
				<div class="flex gap-2">
					<dt class="w-24 shrink-0 text-text-faint">Added</dt>
					<dd>{formatDate(series.addedAt)}</dd>
				</div>
			</dl>
		{/if}
	</div>
{:else if notFound}
	<p class="rounded-lg border border-border-subtle bg-surface-1 px-3 py-3 text-xs text-text-muted">
		This item is no longer in the library.
	</p>
{:else}
	<div class="space-y-3" aria-hidden="true">
		<div class="h-5 w-1/2 animate-pulse rounded bg-surface-2"></div>
		<div class="h-3 w-1/3 animate-pulse rounded bg-surface-2"></div>
	</div>
{/if}

{#snippet episodeRow(episode: EpisodeRow)}
	{@const chips = chipsFor(episode)}
	<li>
		<div class="px-3.5 py-2">
			<button
				type="button"
				class="flex w-full items-center gap-2.5 text-left"
				aria-label="Episode {episode.episodeNumber}, {episode.title ??
					'untitled'}, {episode.state}, {episode.airDateUtc
					? `aired ${daysAgo(episode.airDateUtc)}`
					: 'no air date'}"
				onclick={() => toggleEpisode(episode.id)}
			>
				<span class="w-10 shrink-0 text-[11px] font-medium text-text-faint">
					E{String(episode.episodeNumber).padStart(2, '0')}
				</span>
				<span class="min-w-0 flex-1 truncate text-[12.5px] text-text-secondary">
					{episode.title ?? 'Untitled'}
				</span>
				{#if episode.upgradeAvailable}
					<span
						class="hidden shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[10px] text-accent-text sm:inline"
					>
						Upgrade
					</span>
				{/if}
				{#if episode.quality}
					<span
						class="hidden shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] text-text-secondary md:inline"
					>
						{qualityBadge(episode.quality) ?? episode.quality}
					</span>
				{/if}
				{#if episode.subtitles}
					<span class="hidden shrink-0 items-center gap-0.5 lg:flex" aria-hidden="true">
						{#each chipsFor(episode).slice(0, 4) as chip (chip.code2)}
							<span
								class="rounded px-1 py-0.5 text-[9.5px] font-medium uppercase {chip.present
									? 'bg-healthy-soft text-healthy'
									: 'bg-degraded-soft text-degraded'}"
							>
								{chip.code2}{chip.present ? '✓' : '·'}
							</span>
						{/each}
					</span>
				{/if}
				<span class="w-20 shrink-0 text-right text-[10.5px] {episodeStateClass(episode.state)}">
					{episode.state === 'available'
						? 'Available'
						: episode.state === 'missing'
							? 'Missing'
							: episode.state === 'future'
								? 'Future'
								: episode.state === 'unmonitored'
									? 'Not monitored'
									: episode.state === 'downloading'
										? 'Downloading'
										: episode.state === 'queued'
											? 'Queued'
											: episode.state === 'importing'
												? 'Importing'
												: 'Unknown'}
				</span>
			</button>
			{#if expandedEpisode === episode.id}
				<div class="mt-2 space-y-2 rounded-lg bg-surface-2 p-3 text-[11.5px] text-text-muted">
					<p>
						<span class="text-text-faint">Aired:</span>
						{episode.airDateUtc
							? `${formatDate(episode.airDateUtc)} (${daysAgo(episode.airDateUtc)})`
							: 'No air date'}
					</p>
					{#if episode.queue}
						<p>
							<span class="text-text-faint">Queue:</span>
							{episode.queue.state}
							{#if episode.queue.progress !== null}
								· {episode.queue.progress}%
							{/if}
						</p>
					{/if}
					{#if episode.hasFile}
						<p>
							<span class="text-text-faint">Quality:</span>
							{qualityBadge(episode.quality) ?? episode.quality}
							{#if episode.sizeBytes}· {formatBytes(episode.sizeBytes)}{/if}
						</p>
						{#if episode.releaseGroup}<p>
								<span class="text-text-faint">Release group:</span>
								{episode.releaseGroup}
							</p>{/if}
						{#if episode.releaseTitle}<p class="break-all">
								<span class="text-text-faint">Release title:</span>
								{episode.releaseTitle}
							</p>{/if}
						{#if episode.dateAdded}<p>
								<span class="text-text-faint">Added:</span>
								{formatDate(episode.dateAdded)} ({relativeTime(episode.dateAdded)})
							</p>{/if}
						{#if episode.languages.length > 0}<p>
								<span class="text-text-faint">Languages:</span>
								{episode.languages.join(', ')}
							</p>{/if}
						{#if episode.customFormats.length > 0}<p>
								<span class="text-text-faint">Custom formats:</span>
								{episode.customFormats.join(', ')}
							</p>{/if}
					{:else if episode.state === 'missing'}
						<p>
							<span class="text-text-faint">Backlog:</span>
							aired {daysAgo(episode.airDateUtc)} — still missing
						</p>
					{/if}
					{#if chips.length > 0}
						<div class="flex flex-wrap items-center gap-1.5">
							<span class="text-text-faint">Subtitles:</span>
							{#each chips as chip (chip.code2)}
								<span
									class="rounded px-1.5 py-0.5 text-[10px] {chip.present
										? 'bg-healthy-soft text-healthy'
										: 'bg-degraded-soft text-degraded'}"
								>
									{chip.name}
									{chip.present ? '✓' : 'missing'}
								</span>
							{/each}
						</div>
					{/if}
					<a
						href="/activity?service=sonarr"
						class="inline-block text-[11px] font-medium text-accent-text hover:underline"
					>
						View related activity →
					</a>
				</div>
			{/if}
		</div>
	</li>
{/snippet}
