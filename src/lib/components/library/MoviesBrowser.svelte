<script lang="ts">
	/**
	 * Movie library browser (§33-§36): poster grid over the cached Radarr
	 * inventory. Missing = upstream `isAvailable && !hasFile`; upgrades show
	 * only when Radarr itself reports cutoff-unmet (§40/§42/§114).
	 */
	import PosterImage from './PosterImage.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { qualityBadge, daysAgo } from '$lib/utils/library-ui';
	import { relativeTime } from '$lib/utils/format';

	export interface MovieCard {
		key: string;
		title: string;
		year: number | null;
		monitored: boolean;
		isAvailable: boolean;
		hasFile: boolean;
		missing: boolean;
		upgradeAvailable: boolean;
		quality: string | null;
		qualityResolution: number | null;
		sizeBytes: number | null;
		releaseDate: number | null;
		posterVersion: string | null;
		addedAt: number | null;
	}
	export interface MoviesHeader {
		moviesTotal: number;
		monitored: number;
		completionPct: number | null;
		missing: number | null;
		upgrades: number;
	}

	let {
		initial = {},
		onparams,
		selectedKey = null,
		onopen
	}: {
		initial?: { q?: string; filter?: string; sort?: string; offset?: number };
		onparams?: (params: { q?: string; filter?: string; sort?: string; offset?: number }) => void;
		selectedKey?: string | null;
		onopen?: (item: MovieCard) => void;
	} = $props();

	const FILTERS = [
		{ id: 'all', label: 'All' },
		{ id: 'available', label: 'Available' },
		{ id: 'missing', label: 'Missing' },
		{ id: 'upgrades', label: 'Upgrades' },
		{ id: 'upcoming', label: 'Upcoming' },
		{ id: 'monitored', label: 'Monitored' },
		{ id: 'unmonitored', label: 'Unmonitored' }
	] as const;
	const SORTS = [
		{ id: 'name', label: 'Name' },
		{ id: 'year', label: 'Year' },
		{ id: 'added', label: 'Recently added' },
		{ id: 'missing-oldest', label: 'Oldest missing' },
		{ id: 'missing-newest', label: 'Newest missing' },
		{ id: 'quality', label: 'Quality' }
	] as const;

	let q = $state(initial.q ?? '');
	let filter = $state(initial.filter ?? 'all');
	let sort = $state(initial.sort ?? 'name');
	let offset = $state(initial.offset ?? 0);

	let header = $state<MoviesHeader | null>(null);
	let items = $state<MovieCard[]>([]);
	let total = $state(0);
	let fetchedAt = $state<number | null>(null);
	let availability = $state<string>('available');
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let listSeq = 0;

	$effect(() => {
		const incomingQ = initial.q ?? '';
		const incomingFilter = initial.filter ?? 'all';
		const incomingSort = initial.sort ?? 'name';
		const incomingOffset = initial.offset ?? 0;
		if (incomingQ !== q) q = incomingQ;
		if (incomingFilter !== filter) filter = incomingFilter;
		if (incomingSort !== sort) sort = incomingSort;
		if (incomingOffset !== offset) offset = incomingOffset;
	});

	async function load(): Promise<void> {
		const seq = ++listSeq;
		const params = new URLSearchParams({ filter, sort, offset: String(offset), limit: '50' });
		if (q.trim()) params.set('q', q.trim());
		try {
			const response = await fetch(`/api/library/movies?${params}`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data = (await response.json()) as {
				availability: string;
				fetchedAt: number | null;
				header: MoviesHeader;
				items: MovieCard[];
				total: number;
			};
			if (seq !== listSeq) return;
			header = data.header;
			items = data.items;
			total = data.total;
			fetchedAt = data.fetchedAt;
			availability = data.availability;
			loadError = null;
		} catch {
			if (seq !== listSeq) return;
			loadError = 'Library data is temporarily unavailable.';
		} finally {
			if (seq === listSeq) loading = false;
		}
	}

	$effect(() => {
		void filter;
		void sort;
		void offset;
		void q;
		void load();
	});

	function setFilter(next: string): void {
		filter = next;
		offset = 0;
		onparams?.({ filter: next, offset: 0 });
	}
	function setSort(next: string): void {
		sort = next;
		offset = 0;
		onparams?.({ sort: next, offset: 0 });
	}
	function onSearchInput(): void {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			offset = 0;
			onparams?.({ q, offset: 0 });
		}, 300);
	}
	function setPage(delta: number): void {
		const next = Math.max(0, offset + delta * 50);
		if (next >= total && delta > 0) return;
		offset = next;
		onparams?.({ offset: next });
	}
</script>

{#if availability === 'unconfigured'}
	<EmptyState
		title="Detailed movie browsing requires a Radarr integration"
		description="Connect Radarr in Settings to browse your movie library, quality and subtitle state."
	>
		{#snippet action()}
			<a
				href="/settings"
				class="rounded-lg bg-surface-3 px-3.5 py-2 text-xs font-semibold text-text-primary transition-colors hover:bg-surface-2"
			>
				Configure Radarr →
			</a>
		{/snippet}
	</EmptyState>
{:else}
	<!-- Header (§33) -->
	<div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
		<h3 class="text-[15px] font-semibold text-text-primary">Movies</h3>
		{#if header}
			<p class="text-[13px] text-text-muted">
				<span class="tnum">{header.moviesTotal}</span> movies
				{#if header.completionPct !== null}
					· <span class="tnum">{header.completionPct}%</span> complete
				{/if}
				· <span class="tnum text-degraded">{header.missing ?? 0}</span> released movies missing ·
				<span class="tnum">{header.upgrades}</span> upgrades available
			</p>
		{/if}
		{#if availability === 'stale' && fetchedAt}
			<p class="text-[11px] text-text-faint">Radarr data last updated {relativeTime(fetchedAt)}</p>
		{/if}
	</div>
	{#if loadError}
		<p class="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-xs text-degraded">
			{loadError}
		</p>
	{/if}

	<div class="flex flex-wrap items-center gap-2">
		<input
			type="search"
			placeholder="Search movies…"
			class="h-9 w-full max-w-[260px] rounded-lg border border-border-subtle bg-surface-1 px-3 text-[13px] text-text-primary placeholder:text-text-faint focus:border-border-strong focus:outline-none"
			value={q}
			oninput={onSearchInput}
			aria-label="Search movies"
		/>
		<div class="flex flex-wrap gap-1" role="group" aria-label="Movie filters">
			{#each FILTERS as f (f.id)}
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
		</div>
		<div class="ml-auto">
			<select
				class="h-8 rounded-lg border border-border-subtle bg-surface-1 px-2 text-[12px] text-text-secondary focus:outline-none"
				aria-label="Sort movies"
				value={sort}
				onchange={(e) => setSort(e.currentTarget.value)}
			>
				{#each SORTS as s (s.id)}
					<option value={s.id}>{s.label}</option>
				{/each}
			</select>
		</div>
	</div>

	{#if loading && items.length === 0}
		<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
			{#each Array(12) as _, i (i)}
				<div class="space-y-2" aria-hidden="true">
					<div class="aspect-[2/3] animate-pulse rounded-lg bg-surface-2"></div>
					<div class="h-3 w-3/4 animate-pulse rounded bg-surface-2"></div>
					<div class="h-2.5 w-1/2 animate-pulse rounded bg-surface-2"></div>
				</div>
			{/each}
		</div>
	{:else if total === 0 && q.trim()}
		<EmptyState
			title={`No movies match “${q.trim()}”`}
			description="Try a different search."
			neutral
		/>
	{:else if total === 0}
		<EmptyState title="No movies in this filter" description="Adjust the filters above." neutral />
	{:else}
		<ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
			{#each items as movie (movie.key)}
				<li>
					<button
						type="button"
						class="group w-full rounded-xl border border-transparent p-1.5 text-left transition-colors hover:border-border-subtle hover:bg-surface-1 focus-visible:border-border-strong focus-visible:outline-none {selectedKey ===
						movie.key
							? 'border-border-strong bg-surface-1'
							: ''}"
						onclick={() => onopen?.(movie)}
						aria-label="{movie.title}, {movie.hasFile
							? `available${movie.quality ? `, ${qualityBadge(movie.quality)}` : ''}`
							: movie.missing
								? `missing, released ${movie.releaseDate ? daysAgo(movie.releaseDate) : 'unknown date'}`
								: 'upcoming'}"
					>
						<PosterImage itemKey={movie.key} title={movie.title} version={movie.posterVersion} />
						<p class="mt-1.5 truncate text-[13px] font-medium text-text-primary">{movie.title}</p>
						<p class="text-[10.5px] text-text-faint">{movie.year ?? ''}</p>
						{#if movie.missing}
							<p class="mt-0.5 text-[11px] text-degraded">Missing</p>
						{:else if !movie.isAvailable}
							<p class="mt-0.5 text-[11px] text-text-faint">Upcoming</p>
						{:else if movie.quality}
							<p class="mt-0.5 text-[11px] text-text-muted">
								{qualityBadge(movie.quality)}
								{#if movie.upgradeAvailable}
									· <span class="text-accent-text">Upgrade</span>
								{/if}
							</p>
						{/if}
					</button>
				</li>
			{/each}
		</ul>
		{#if total > 50}
			<div class="flex items-center justify-between text-[11.5px] text-text-muted">
				<button
					type="button"
					class="rounded-lg border border-border-subtle px-3 py-1.5 transition-colors hover:border-border-strong disabled:opacity-40"
					disabled={offset === 0}
					onclick={() => setPage(-1)}
				>
					← Previous
				</button>
				<span class="tnum">{offset + 1}–{Math.min(offset + 50, total)} of {total}</span>
				<button
					type="button"
					class="rounded-lg border border-border-subtle px-3 py-1.5 transition-colors hover:border-border-strong disabled:opacity-40"
					disabled={offset + 50 >= total}
					onclick={() => setPage(1)}
				>
					Next →
				</button>
			</div>
		{/if}
	{/if}
{/if}
