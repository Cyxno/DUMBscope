<script lang="ts">
	/**
	 * Movie detail (§37-§44): status, quality/file info, queue correlation,
	 * subtitle state and bounded normalized history. Missing movies show
	 * release age + monitored state — never invented search failures (§40).
	 */
	import PosterImage from './PosterImage.svelte';
	import { formatBytes, relativeTime } from '$lib/utils/format';
	import { daysAgo, formatDate, qualityBadge } from '$lib/utils/library-ui';

	interface MovieFull {
		key: string;
		id: number;
		title: string;
		year: number | null;
		status: string;
		monitored: boolean;
		isAvailable: boolean;
		hasFile: boolean;
		quality: string | null;
		qualityResolution: number | null;
		sizeBytes: number | null;
		releaseGroup: string | null;
		dateAdded: number | null;
		edition: string | null;
		languages: string[];
		customFormats: string[];
		upgradeAvailable: boolean;
		qualityProfile: string | null;
		runtime: number | null;
		certification: string | null;
		studio: string | null;
		genres: string[];
		collection: string | null;
		digitalRelease: number | null;
		inCinemas: number | null;
		physicalRelease: number | null;
		tmdbId: number | null;
		imdbId: string | null;
		path: string | null;
		posterVersion: string | null;
	}
	interface DetailPayload {
		movie: MovieFull;
		queue: { state: string; progress: number | null } | null;
		subtitles: {
			present: { code2: string; name: string }[];
			missing: { code2: string; name: string }[];
		} | null;
		profileName: string | null;
		history: { at: number; label: string; detail: string | null; quality: string | null }[];
		subtitleHistory: { at: string; description: string }[];
	}

	let { itemKey }: { itemKey: string } = $props();

	let data = $state<DetailPayload | null>(null);
	let error = $state<string | null>(null);
	let showTechnical = $state(false);

	$effect(() => {
		void itemKey;
		data = null;
		error = null;
		showTechnical = false;
		void load();
	});

	async function load(): Promise<void> {
		try {
			const response = await fetch(`/api/library/movies/${itemKey}`);
			if (response.status === 404) {
				error = 'This item is no longer in the library.';
				return;
			}
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			data = (await response.json()) as DetailPayload;
		} catch {
			error = 'Movie detail is temporarily unavailable.';
		}
	}

	const releaseDate = $derived(
		data ? (data.movie.digitalRelease ?? data.movie.inCinemas ?? data.movie.physicalRelease) : null
	);
	const missingFlag = $derived(data ? data.movie.isAvailable && !data.movie.hasFile : false);
</script>

{#if error}
	<p class="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-xs text-text-muted">
		{error}
	</p>
{:else if !data}
	<div class="flex gap-4" aria-hidden="true">
		<div class="aspect-[2/3] w-24 animate-pulse rounded-lg bg-surface-2"></div>
		<div class="flex-1 space-y-2 pt-1">
			<div class="h-5 w-2/3 animate-pulse rounded bg-surface-2"></div>
			<div class="h-3 w-1/3 animate-pulse rounded bg-surface-2"></div>
			<div class="h-3 w-1/2 animate-pulse rounded bg-surface-2"></div>
		</div>
	</div>
{:else}
	{@const movie = data.movie}
	<div class="flex gap-4">
		<div class="w-24 shrink-0 sm:w-28">
			<PosterImage itemKey={movie.key} title={movie.title} version={movie.posterVersion} />
		</div>
		<div class="min-w-0 flex-1">
			<h3 class="text-[15px] font-semibold tracking-tight text-text-primary">{movie.title}</h3>
			<p class="mt-0.5 text-xs text-text-muted">
				{movie.year ?? ''}
				{#if movie.studio}· {movie.studio}{/if}
				{#if movie.runtime}· <span class="tnum">{movie.runtime} min</span>{/if}
			</p>
			<div class="mt-2 flex flex-wrap items-center gap-2 text-[11.5px]">
				<span
					class="rounded-full px-2 py-0.5 {movie.hasFile
						? 'bg-healthy-soft text-healthy'
						: missingFlag
							? 'bg-degraded-soft text-degraded'
							: 'bg-surface-3 text-text-muted'}"
				>
					{movie.hasFile ? 'Available' : movie.isAvailable ? 'Missing' : 'Upcoming'}
				</span>
				{#if movie.quality}
					<span class="rounded-full bg-surface-3 px-2 py-0.5 text-text-secondary">
						{qualityBadge(movie.quality) ?? movie.quality}
					</span>
				{/if}
				{#if movie.sizeBytes}
					<span class="rounded-full bg-surface-3 px-2 py-0.5 tnum text-text-secondary">
						{formatBytes(movie.sizeBytes)}
					</span>
				{/if}
				<span
					class="rounded-full px-2 py-0.5 {movie.monitored
						? 'bg-surface-3 text-text-muted'
						: 'bg-unknown-soft text-text-muted'}"
				>
					{movie.monitored ? 'Monitored' : 'Not monitored'}
				</span>
				{#if movie.upgradeAvailable}
					<span class="rounded-full bg-accent-soft px-2 py-0.5 text-accent-text">
						Upgrade available
					</span>
				{/if}
			</div>
		</div>
	</div>

	<!-- Missing context (§40) / queue (§41) -->
	{#if missingFlag || data.queue}
		<div
			class="rounded-[14px] border border-border-subtle bg-surface-1 p-3 text-[12px] text-text-muted"
		>
			{#if missingFlag}
				<p>
					Released {releaseDate ? daysAgo(releaseDate) : '—'} ·
					{movie.monitored ? 'Monitored' : 'Not monitored'} ·
					{data.queue ? 'in queue' : 'no active queue item'}
				</p>
			{:else if data.queue}
				<div class="flex items-center gap-2">
					<div class="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-surface-3">
						<div
							class="h-full rounded-full bg-accent"
							style="width: {data.queue.progress ?? 2}%"
						></div>
					</div>
					<span class="tnum">
						{data.queue.state === 'downloading'
							? 'Downloading'
							: data.queue.state === 'queued'
								? 'Waiting'
								: 'Importing'}
						{#if data.queue.progress !== null}· {data.queue.progress}%{/if}
					</span>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Upgrade context (§42) -->
	{#if movie.upgradeAvailable}
		<p
			class="rounded-[14px] border border-border-subtle bg-surface-1 p-3 text-[12px] text-text-muted"
		>
			Upgrade available — current: <b class="font-medium text-text-secondary"
				>{qualityBadge(movie.quality) ?? movie.quality}</b
			>, target: quality profile “{movie.qualityProfile ?? 'unknown'}” not yet met.
		</p>
	{/if}

	<!-- Metadata (§38) -->
	<div class="flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-text-muted">
		{#if movie.qualityProfile}<span
				>Quality profile: <b class="font-medium text-text-secondary">{movie.qualityProfile}</b
				></span
			>{/if}
		{#if movie.genres.length > 0}<span>{movie.genres.slice(0, 4).join(', ')}</span>{/if}
		{#if movie.certification}<span>{movie.certification}</span>{/if}
		{#if movie.collection}<span>{movie.collection}</span>{/if}
		{#if releaseDate}<span>Released: {formatDate(releaseDate)}</span>{/if}
	</div>

	<!-- File info (§39) -->
	{#if movie.hasFile}
		<div
			class="rounded-[14px] border border-border-subtle bg-surface-1 p-3 text-[11.5px] text-text-muted"
		>
			<h4 class="mb-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-text-faint">File</h4>
			<div class="grid grid-cols-2 gap-x-4 gap-y-1">
				{#if movie.quality}<span
						>Quality: <b class="font-medium text-text-secondary"
							>{qualityBadge(movie.quality) ?? movie.quality}</b
						></span
					>{/if}
				{#if movie.sizeBytes}<span class="tnum">Size: {formatBytes(movie.sizeBytes)}</span>{/if}
				{#if movie.releaseGroup}<span>Group: {movie.releaseGroup}</span>{/if}
				{#if movie.dateAdded}<span
						>Added: {formatDate(movie.dateAdded)} ({relativeTime(movie.dateAdded)})</span
					>{/if}
				{#if movie.edition}<span>Edition: {movie.edition}</span>{/if}
				{#if movie.languages.length > 0}<span>Languages: {movie.languages.join(', ')}</span>{/if}
			</div>
		</div>
	{/if}

	<!-- Subtitles (§43) -->
	{#if data.subtitles}
		<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-3 text-[11.5px]">
			<h4 class="mb-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-text-faint">
				Subtitles
			</h4>
			<div class="flex flex-wrap gap-1.5">
				{#each data.subtitles.present as lang (lang.code2)}
					<span class="rounded px-1.5 py-0.5 bg-healthy-soft text-healthy">{lang.name} ✓</span>
				{/each}
				{#each data.subtitles.missing as lang (lang.code2)}
					<span class="rounded px-1.5 py-0.5 bg-degraded-soft text-degraded"
						>{lang.name} missing</span
					>
				{/each}
			</div>
			{#if data.profileName}
				<p class="mt-1.5 text-[10.5px] text-text-faint">Language profile: {data.profileName}</p>
			{/if}
			{#if data.subtitleHistory.length > 0}
				<ul
					class="mt-2 space-y-0.5 border-t border-border-subtle pt-1.5 text-[10.5px] text-text-faint"
				>
					{#each data.subtitleHistory as event (event.at + event.description)}
						<li class="truncate">{event.description} · {event.at}</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	<!-- Recent activity (§44) -->
	{#if data.history.length > 0}
		<div
			class="rounded-[14px] border border-border-subtle bg-surface-1 p-3 text-[11.5px] text-text-muted"
		>
			<h4 class="mb-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-text-faint">
				Recent activity
			</h4>
			<ul class="space-y-1">
				{#each data.history as event (event.at + event.label + (event.detail ?? ''))}
					<li class="flex items-baseline gap-2">
						<span class="w-16 shrink-0 text-[10.5px] text-text-faint">{formatDate(event.at)}</span>
						<span class="font-medium text-text-secondary">{event.label}</span>
						{#if event.quality}<span class="text-text-faint"
								>· {qualityBadge(event.quality) ?? event.quality}</span
							>{/if}
						{#if event.detail}<span class="min-w-0 truncate text-[10.5px] text-text-faint"
								>{event.detail}</span
							>{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- Technical (§122/§123) -->
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
				{#if movie.path}
					<div class="flex gap-2">
						<dt class="w-20 shrink-0 text-text-faint">Path</dt>
						<dd class="min-w-0 break-all">{movie.path}</dd>
					</div>
				{/if}
				{#if movie.tmdbId}<div class="flex gap-2">
						<dt class="w-20 shrink-0 text-text-faint">TMDB</dt>
						<dd class="tnum">{movie.tmdbId}</dd>
					</div>{/if}
				{#if movie.imdbId}<div class="flex gap-2">
						<dt class="w-20 shrink-0 text-text-faint">IMDb</dt>
						<dd>{movie.imdbId}</dd>
					</div>{/if}
				{#if movie.customFormats.length > 0}
					<div class="flex gap-2">
						<dt class="w-20 shrink-0 text-text-faint">Formats</dt>
						<dd>{movie.customFormats.join(', ')}</dd>
					</div>
				{/if}
				<div class="flex gap-2">
					<dt class="w-20 shrink-0 text-text-faint">Radarr id</dt>
					<dd class="tnum">{movie.id}</dd>
				</div>
			</dl>
		{/if}
	</div>
{/if}
