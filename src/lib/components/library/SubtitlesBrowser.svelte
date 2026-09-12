<script lang="ts">
	/**
	 * Subtitle browser (§45-§53): coverage header, Overview/Movies/TV/Languages
	 * modes, enabled-language chips (§24) and per-series episode drill-down
	 * (§49). Correlation is id-based via Bazarr's sonarrSeriesId (§62).
	 */
	import EmptyState from '$lib/components/EmptyState.svelte';

	interface LangChip {
		code2: string;
		name: string;
	}
	interface MovieRow {
		key: string;
		title: string;
		year: number | null;
		present: LangChip[];
		missing: LangChip[];
	}
	interface SeriesRow {
		key: string;
		title: string;
		episodeGaps: number;
	}
	interface Payload {
		availability: string;
		header: {
			episodeGaps: number | null;
			movieGaps: number | null;
			seriesWithGaps: number;
			moviesWithGaps: number;
		};
		enabledLanguages: LangChip[];
		profiles: { id: number; name: string; cutoff: string | null; languages: string[] }[];
		languages: { code2: string; name: string; movieGaps: number }[];
		movies: MovieRow[];
		series: SeriesRow[];
		totalMovies: number;
		totalSeries: number;
	}

	let {
		initial = {},
		onparams,
		onopenMovie
	}: {
		initial?: { mode?: string; filter?: string; lang?: string };
		onparams?: (params: { mode?: string; filter?: string; lang?: string }) => void;
		onopenMovie?: (key: string) => void;
	} = $props();

	const MODES = [
		{ id: 'overview', label: 'Overview' },
		{ id: 'movies', label: 'Movies' },
		{ id: 'tv', label: 'TV' },
		{ id: 'languages', label: 'Languages' }
	] as const;

	let mode = $state(initial.mode ?? 'overview');
	let filter = $state(initial.filter ?? 'has-gaps');
	let lang = $state(initial.lang ?? '');
	let data = $state<Payload | null>(null);
	let loading = $state(true);
	let listSeq = 0;

	// Per-series drill-down (§48→§49)
	let drillKey = $state<string | null>(null);
	let drillTitle = $state('');
	let drillEpisodes = $state<
		{
			sonarrEpisodeId: number;
			seasonNumber: number;
			episodeNumber: number;
			title: string | null;
			present: LangChip[];
			missing: LangChip[];
		}[]
	>([]);
	let drillLoading = $state(false);

	$effect(() => {
		const incomingMode = initial.mode ?? 'overview';
		const incomingFilter = initial.filter ?? 'has-gaps';
		const incomingLang = initial.lang ?? '';
		if (incomingMode !== mode) mode = incomingMode;
		if (incomingFilter !== filter) filter = incomingFilter;
		if (incomingLang !== lang) lang = incomingLang;
	});

	async function load(): Promise<void> {
		const seq = ++listSeq;
		const params = new URLSearchParams({ filter, limit: '50' });
		if (lang) params.set('lang', lang);
		try {
			const response = await fetch(`/api/library/subtitles?${params}`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const payload = (await response.json()) as Payload;
			if (seq !== listSeq) return;
			data = payload;
		} catch {
			if (seq !== listSeq) return;
			data = null;
		} finally {
			if (seq === listSeq) loading = false;
		}
	}

	$effect(() => {
		void filter;
		void lang;
		void load();
	});

	function setMode(next: string): void {
		mode = next;
		onparams?.({ mode: next });
	}
	function setFilter(next: string): void {
		filter = next;
		onparams?.({ filter: next });
	}
	function setLang(next: string): void {
		lang = next;
		onparams?.({ lang: next });
	}

	async function openDrill(key: string, title: string): Promise<void> {
		drillKey = key;
		drillTitle = title;
		drillEpisodes = [];
		drillLoading = true;
		try {
			const response = await fetch(`/api/library/subtitles/tv/${key}`);
			if (response.ok) {
				const payload = (await response.json()) as { episodes: typeof drillEpisodes };
				drillEpisodes = payload.episodes;
			}
		} finally {
			drillLoading = false;
		}
	}
</script>

{#if data?.availability === 'unconfigured'}
	<EmptyState
		title="Detailed subtitle browsing requires Bazarr"
		description="Connect Bazarr in Settings to see which subtitles are present, wanted or missing per title and language."
	>
		{#snippet action()}
			<a
				href="/settings"
				class="rounded-lg bg-surface-3 px-3.5 py-2 text-xs font-semibold text-text-primary transition-colors hover:bg-surface-2"
			>
				Configure Bazarr →
			</a>
		{/snippet}
	</EmptyState>
{:else if !data && loading}
	<div class="space-y-2" aria-hidden="true">
		{#each Array(6) as _, i (i)}
			<div class="h-10 animate-pulse rounded-lg bg-surface-2"></div>
		{/each}
	</div>
{:else if data && data.availability === 'unavailable'}
	<EmptyState
		title="Waiting for the first Bazarr poll"
		description="Subtitle coverage fills in automatically once the poll completes — usually within a minute."
		neutral
	/>
{:else if data}
	<!-- Header (§45) -->
	<div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
		<h3 class="text-[15px] font-semibold text-text-primary">Subtitles</h3>
		<p class="text-[13px] text-text-muted">
			<span class="tnum text-degraded">{data.header.episodeGaps ?? '—'}</span> episode gaps ·
			<span class="tnum text-degraded">{data.header.movieGaps ?? '—'}</span> movie gaps
		</p>
	</div>

	<!-- Modes (§46) -->
	<div class="flex flex-wrap items-center gap-1" role="group" aria-label="Subtitle views">
		{#each MODES as m (m.id)}
			<button
				type="button"
				class="rounded-lg px-3 py-1.5 text-[12px] transition-colors {mode === m.id
					? 'bg-surface-3 font-semibold text-text-primary'
					: 'text-text-muted hover:bg-surface-2 hover:text-text-secondary'}"
				aria-pressed={mode === m.id}
				onclick={() => setMode(m.id)}
			>
				{m.label}
			</button>
		{/each}
		<div class="ml-auto flex flex-wrap gap-1">
			{#if mode === 'movies' || mode === 'tv'}
				{#each [{ id: 'has-gaps', label: 'Has gaps' }, { id: 'complete', label: 'Complete' }, { id: 'all', label: 'All' }] as f (f.id)}
					<button
						type="button"
						class="rounded-full px-3 py-1 text-[12px] transition-colors {filter === f.id
							? 'bg-surface-3 font-semibold text-text-primary'
							: 'text-text-muted hover:bg-surface-2 hover:text-text-secondary'}"
						aria-pressed={filter === f.id}
						onclick={() => setFilter(f.id)}
					>
						{f.label}
					</button>
				{/each}
			{/if}
			<select
				class="h-8 rounded-lg border border-border-subtle bg-surface-1 px-2 text-[12px] text-text-secondary focus:outline-none"
				aria-label="Filter by language"
				value={lang}
				onchange={(e) => setLang(e.currentTarget.value)}
			>
				<option value="">All languages</option>
				{#each data.enabledLanguages as l (l.code2)}
					<option value={l.code2}>{l.name}</option>
				{/each}
			</select>
		</div>
	</div>

	{#if mode === 'overview'}
		<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
			<!-- Language profiles (§51) -->
			{#if data.profiles.length > 0}
				<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-3">
					<h4 class="mb-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-text-faint">
						Language profiles
					</h4>
					{#each data.profiles as profile (profile.id)}
						<p class="text-[12px] text-text-secondary">
							{profile.name}
							{#if profile.cutoff}<span class="text-text-faint">· cutoff {profile.cutoff}</span
								>{/if}
						</p>
					{/each}
				</div>
			{/if}
			<!-- Configured languages (§24) -->
			<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-3">
				<h4 class="mb-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-text-faint">
					Configured languages
				</h4>
				<div class="flex flex-wrap gap-1.5">
					{#each data.enabledLanguages as l (l.code2)}
						<button
							type="button"
							class="rounded-full bg-accent-soft px-2.5 py-0.5 text-[11.5px] font-medium text-accent-text"
							onclick={() => {
								setLang(l.code2);
								setMode('movies');
							}}
						>
							{l.name}
						</button>
					{/each}
				</div>
			</div>
			<!-- Per-language movie gaps (§50) -->
			<div class="overflow-hidden rounded-[14px] border border-border-subtle bg-surface-1">
				<h4
					class="border-b border-border-subtle px-3 py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-text-faint"
				>
					Movie gaps per language
				</h4>
				<ul class="divide-y divide-border-subtle">
					{#each data.languages.slice(0, 8) as l (l.code2)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2"
								onclick={() => {
									setLang(l.code2);
									setMode('movies');
								}}
							>
								<span class="flex-1 text-[12.5px] text-text-secondary">{l.name}</span>
								<span class="tnum text-[11.5px] text-degraded">{l.movieGaps} gaps</span>
							</button>
						</li>
					{/each}
					{#if data.languages.length === 0}
						<li class="px-3 py-2 text-[12px] text-text-faint">No movie gaps — complete.</li>
					{/if}
				</ul>
			</div>
			<!-- Worst series (§48) -->
			<div class="overflow-hidden rounded-[14px] border border-border-subtle bg-surface-1">
				<h4
					class="border-b border-border-subtle px-3 py-2 text-[10px] font-bold uppercase tracking-[0.1em] text-text-faint"
				>
					Series with episode gaps
				</h4>
				<ul class="divide-y divide-border-subtle">
					{#each data.series.slice(0, 8) as s (s.key)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2"
								onclick={() => openDrill(s.key, s.title)}
							>
								<span class="min-w-0 flex-1 truncate text-[12.5px] text-text-secondary"
									>{s.title}</span
								>
								<span class="tnum text-[11.5px] text-degraded">{s.episodeGaps} gaps</span>
							</button>
						</li>
					{/each}
					{#if data.series.length === 0}
						<li class="px-3 py-2 text-[12px] text-text-faint">No series gaps — complete.</li>
					{/if}
				</ul>
			</div>
		</div>
	{/if}

	{#if mode === 'movies'}
		<ul
			class="divide-y divide-border-subtle overflow-hidden rounded-[14px] border border-border-subtle bg-surface-1"
		>
			{#each data.movies as movie (movie.key)}
				<li>
					<button
						type="button"
						class="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-surface-2"
						onclick={() => onopenMovie?.(movie.key)}
					>
						<span class="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
							{movie.title}
							{#if movie.year}<span class="font-normal text-text-faint">({movie.year})</span>{/if}
						</span>
						<span class="flex flex-wrap items-center gap-1">
							{#each movie.present.slice(0, 6) as l (l.code2)}
								<span
									class="rounded bg-healthy-soft px-1.5 py-0.5 text-[10px] font-medium text-healthy uppercase"
								>
									{l.code2} ✓
								</span>
							{/each}
							{#each movie.missing.slice(0, 4) as l (l.code2)}
								<span
									class="rounded bg-degraded-soft px-1.5 py-0.5 text-[10px] font-medium text-degraded uppercase"
								>
									{l.code2} missing
								</span>
							{/each}
						</span>
					</button>
				</li>
			{/each}
			{#if data.movies.length === 0}
				<li class="px-4 py-3 text-[12.5px] text-text-faint">No movies match this filter.</li>
			{/if}
		</ul>
	{/if}

	{#if mode === 'tv'}
		{#if drillKey}
			<div>
				<button
					type="button"
					class="mb-2 text-[11.5px] font-medium text-text-muted hover:text-text-secondary"
					onclick={() => (drillKey = null)}
				>
					← All series
				</button>
				<h4 class="text-[13.5px] font-semibold text-text-primary">{drillTitle}</h4>
				{#if drillLoading}
					<div class="mt-2 space-y-1.5" aria-hidden="true">
						{#each Array(5) as _, i (i)}
							<div class="h-8 animate-pulse rounded bg-surface-2"></div>
						{/each}
					</div>
				{:else}
					<ul
						class="mt-2 divide-y divide-border-subtle overflow-hidden rounded-[14px] border border-border-subtle bg-surface-1"
					>
						{#each drillEpisodes as episode (episode.sonarrEpisodeId)}
							<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
								<span class="w-16 shrink-0 text-[11px] text-text-faint">
									S{String(episode.seasonNumber).padStart(2, '0')}E{String(
										episode.episodeNumber
									).padStart(2, '0')}
								</span>
								<span class="min-w-0 flex-1 truncate text-[12.5px] text-text-secondary"
									>{episode.title ?? 'Untitled'}</span
								>
								<span class="flex flex-wrap items-center gap-1">
									{#each episode.present.slice(0, 5) as l (l.code2)}
										<span
											class="rounded bg-healthy-soft px-1.5 py-0.5 text-[10px] font-medium text-healthy uppercase"
											>{l.code2} ✓</span
										>
									{/each}
									{#each episode.missing.slice(0, 3) as l (l.code2)}
										<span
											class="rounded bg-degraded-soft px-1.5 py-0.5 text-[10px] font-medium text-degraded uppercase"
											>{l.code2} missing</span
										>
									{/each}
								</span>
							</li>
						{/each}
						{#if drillEpisodes.length === 0}
							<li class="px-4 py-3 text-[12.5px] text-text-faint">No episode subtitle data.</li>
						{/if}
					</ul>
				{/if}
			</div>
		{:else}
			<ul
				class="divide-y divide-border-subtle overflow-hidden rounded-[14px] border border-border-subtle bg-surface-1"
			>
				{#each data.series as series (series.key)}
					<li>
						<button
							type="button"
							class="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2"
							onclick={() => openDrill(series.key, series.title)}
							aria-label="{series.title}, {series.episodeGaps} episode subtitle gaps"
						>
							<span class="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary"
								>{series.title}</span
							>
							<span
								class="tnum text-[11.5px] {series.episodeGaps > 0
									? 'text-degraded'
									: 'text-text-faint'}"
							>
								{series.episodeGaps > 0 ? `${series.episodeGaps} episode gaps` : 'complete'}
							</span>
						</button>
					</li>
				{/each}
				{#if data.series.length === 0}
					<li class="px-4 py-3 text-[12.5px] text-text-faint">No series match this filter.</li>
				{/if}
			</ul>
		{/if}
	{/if}

	{#if mode === 'languages'}
		<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.languages as l (l.code2)}
				<button
					type="button"
					class="rounded-[14px] border border-border-subtle bg-surface-1 p-3 text-left transition-colors hover:border-border-strong"
					onclick={() => {
						setLang(l.code2);
						setMode('movies');
					}}
				>
					<p class="text-[13px] font-semibold text-text-primary">{l.name}</p>
					<p class="tnum mt-1 text-[11.5px] text-text-muted">{l.movieGaps} movie gaps</p>
					<p class="text-[11.5px] text-text-faint">
						{data.header.episodeGaps ?? '—'} episode gaps in total
					</p>
				</button>
			{/each}
			{#if data.languages.length === 0}
				<p class="text-[12.5px] text-text-faint">No language gaps found.</p>
			{/if}
		</div>
	{/if}
{/if}
