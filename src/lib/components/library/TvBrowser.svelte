<script lang="ts">
	import { untrack } from 'svelte';
	/**
	 * TV library browser (§5-§32): poster grid / compact list over the cached
	 * Sonarr inventory. Search debounced server-side, high-value filter chips,
	 * bounded pagination. Backlog stays neutral — never an alarm (§88-§89).
	 */
	import PosterImage from './PosterImage.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { formatDate, seriesStatusLabel, seriesStatusClass } from '$lib/utils/library-ui';
	import { relativeTime } from '$lib/utils/format';

	export interface TvHeader {
		seriesTotal: number;
		seriesMonitored: number;
		completionPct: number | null;
		missing: number | null;
		upgrades: number;
	}
	export interface SeriesCard {
		key: string;
		title: string;
		year: number | null;
		status: string;
		monitored: boolean;
		network: string | null;
		seasonsCount: number;
		hasSpecials: boolean;
		missingCount: number;
		episodeFutureCount: number;
		completionPct: number | null;
		qualityProfile: string | null;
		posterVersion: string | null;
		addedAt: number | null;
	}
	export interface UpcomingItem {
		key: string;
		seriesTitle: string;
		episodeTitle: string | null;
		seasonNumber: number | null;
		episodeNumber: number | null;
		at: number;
		bucket: 'today' | 'tomorrow' | 'week' | 'later';
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
		onopen?: (item: SeriesCard) => void;
	} = $props();

	const FILTERS = [
		{ id: 'all', label: 'All' },
		{ id: 'incomplete', label: 'Incomplete' },
		{ id: 'continuing', label: 'Continuing' },
		{ id: 'ended', label: 'Ended' },
		{ id: 'monitored', label: 'Monitored' },
		{ id: 'unmonitored', label: 'Unmonitored' }
	] as const;
	const SORTS = [
		{ id: 'name', label: 'Name' },
		{ id: 'completion', label: 'Completion' },
		{ id: 'missing', label: 'Most missing' },
		{ id: 'added', label: 'Recently added' },
		{ id: 'year', label: 'Year' }
	] as const;

	let q = $state(initial.q ?? '');
	let filter = $state((initial.filter === 'missing' ? 'incomplete' : initial.filter) ?? 'all');
	let sort = $state(initial.sort ?? 'name');
	let offset = $state(initial.offset ?? 0);
	let echoedQ = $state<string | null>(null);
	let grid = $state(true);

	let header = $state<TvHeader | null>(null);
	let items = $state<SeriesCard[]>([]);
	let total = $state(0);
	let upcoming = $state<UpcomingItem[]>([]);
	let fetchedAt = $state<number | null>(null);
	let availability = $state<string>('available');
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let listSeq = 0;

	$effect(() => {
		// Adopt outside state (browser back/forward). Only `initial` is tracked:
		// local values are read untracked so typing is never reverted (§135).
		const incomingQ = initial.q ?? '';
		const incomingFilter = initial.filter === 'missing' ? 'incomplete' : (initial.filter ?? 'all');
		const incomingSort = initial.sort ?? 'name';
		const incomingOffset = initial.offset ?? 0;
		untrack(() => {
			if (incomingQ !== q && incomingQ !== echoedQ) q = incomingQ;
			if (incomingFilter !== filter) filter = incomingFilter;
			if (incomingSort !== sort) sort = incomingSort;
			if (incomingOffset !== offset) offset = incomingOffset;
		});
	});

	async function load(): Promise<void> {
		const seq = ++listSeq;
		const params = new URLSearchParams({
			filter,
			sort,
			offset: String(offset),
			limit: '50'
		});
		if (q.trim()) params.set('q', q.trim());
		try {
			const response = await fetch(`/api/library/tv?${params}`);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const data = (await response.json()) as {
				availability: string;
				fetchedAt: number | null;
				header: TvHeader;
				items: SeriesCard[];
				total: number;
				upcoming: UpcomingItem[];
			};
			if (seq !== listSeq) return;
			header = data.header;
			items = data.items;
			total = data.total;
			upcoming = data.upcoming ?? [];
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
			echoedQ = q;
			onparams?.({ q, offset: 0 });
		}, 300);
	}
	function setPage(delta: number): void {
		const next = Math.max(0, offset + delta * 50);
		if (next >= total && delta > 0) return;
		offset = next;
		onparams?.({ offset: next });
	}
	const GRID_PREF_KEY = 'dumbscope.library.tv.grid';
	$effect(() => {
		const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(GRID_PREF_KEY) : null;
		if (stored !== null) grid = stored === '1';
	});
	function toggleGrid(): void {
		grid = !grid;
		try {
			localStorage.setItem(GRID_PREF_KEY, grid ? '1' : '0');
		} catch {
			/* private mode */
		}
	}

	function rangeLabel(): string {
		if (total === 0) return '0';
		return `${offset + 1}–${Math.min(offset + 50, total)} of ${total}`;
	}

	/** Upcoming chips only know title + key — the drawer fetches the rest. */
	function stubItem(key: string, title: string): SeriesCard {
		return {
			key,
			title,
			year: null,
			status: 'continuing',
			monitored: true,
			network: null,
			seasonsCount: 0,
			hasSpecials: false,
			missingCount: 0,
			episodeFutureCount: 0,
			completionPct: null,
			qualityProfile: null,
			posterVersion: null,
			addedAt: null
		};
	}

	const upcomingBuckets = $derived(
		(['today', 'tomorrow', 'week', 'later'] as const)
			.map((bucket) => ({ bucket, items: upcoming.filter((u) => u.bucket === bucket) }))
			.filter((group) => group.items.length > 0)
	);
</script>

{#snippet sectionLabel(text: string)}
	<h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-text-faint">{text}</h3>
{/snippet}

{#if availability === 'unconfigured'}
	<EmptyState
		title="Detailed TV library browsing requires a Sonarr integration"
		description="Connect Sonarr in Settings to browse series, seasons and episodes. Basic process monitoring stays active."
	>
		{#snippet action()}
			<a
				href="/settings"
				class="rounded-lg bg-surface-3 px-3.5 py-2 text-xs font-semibold text-text-primary transition-colors hover:bg-surface-2"
			>
				Configure Sonarr →
			</a>
		{/snippet}
	</EmptyState>
{:else}
	<!-- Header (§5) -->
	<div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
		<h3 class="text-[15px] font-semibold text-text-primary">TV Library</h3>
		{#if header}
			<p class="text-[13px] text-text-muted">
				<span class="tnum">{header.seriesTotal}</span> series
				{#if header.completionPct !== null}
					· <span class="tnum">{header.completionPct}%</span> complete
				{/if}
				· <span class="tnum text-degraded">{header.missing ?? 0}</span> released episodes missing ·
				<span class="tnum">{header.upgrades}</span> upgrades available
			</p>
		{/if}
		{#if availability === 'stale' && fetchedAt}
			<p class="text-[11px] text-text-faint">Sonarr data last updated {relativeTime(fetchedAt)}</p>
		{/if}
	</div>
	{#if loadError}
		<p class="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2 text-xs text-degraded">
			{loadError}
		</p>
	{/if}

	<!-- Upcoming (§32): compact, grouped -->
	{#if upcomingBuckets.length > 0 && filter === 'all' && q.trim() === ''}
		<section aria-label="Upcoming episodes" class="space-y-1.5">
			{@render sectionLabel('Upcoming')}
			<div class="flex flex-wrap gap-1.5">
				{#each upcomingBuckets as group (group.bucket)}
					{#each group.items.slice(0, group.bucket === 'today' ? 6 : 3) as item (item.key + String(item.at))}
						<button
							type="button"
							class="max-w-[300px] truncate rounded-full border border-border-subtle bg-surface-1 px-3 py-1 text-[11.5px] text-text-muted transition-colors hover:border-border-strong hover:text-text-secondary"
							onclick={() => item.key && onopen?.(stubItem(item.key, item.seriesTitle))}
							title="{item.seriesTitle} · S{item.seasonNumber}E{item.episodeNumber} {item.episodeTitle ??
								''}"
						>
							<span class="font-medium text-text-secondary">{item.seriesTitle}</span>
							<span class="text-text-faint">
								· {group.bucket === 'today'
									? 'today'
									: group.bucket === 'tomorrow'
										? 'tomorrow'
										: formatDate(item.at)}
							</span>
						</button>
					{/each}
				{/each}
			</div>
		</section>
	{/if}

	<!-- Search + filters + sort + grid/list (§85-§87) -->
	<div class="flex flex-wrap items-center gap-2">
		<input
			type="search"
			placeholder="Search series…"
			class="h-9 w-full max-w-[260px] rounded-lg border border-border-subtle bg-surface-1 px-3 text-[13px] text-text-primary placeholder:text-text-faint focus:border-border-strong focus:outline-none"
			value={q}
			oninput={(e) => {
				q = e.currentTarget.value;
				onSearchInput();
			}}
			aria-label="Search series"
		/>
		<div class="flex flex-wrap gap-1" role="group" aria-label="TV filters">
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
		<div class="ml-auto flex items-center gap-2">
			<select
				class="h-8 rounded-lg border border-border-subtle bg-surface-1 px-2 text-[12px] text-text-secondary focus:outline-none"
				aria-label="Sort series"
				value={sort}
				onchange={(e) => setSort(e.currentTarget.value)}
			>
				{#each SORTS as s (s.id)}
					<option value={s.id}>{s.label}</option>
				{/each}
			</select>
			<div
				class="flex overflow-hidden rounded-lg border border-border-subtle"
				role="group"
				aria-label="View mode"
			>
				<button
					type="button"
					class="px-2.5 py-1.5 text-[11.5px] {grid
						? 'bg-surface-3 font-semibold text-text-primary'
						: 'text-text-muted hover:text-text-secondary'}"
					aria-pressed={grid}
					onclick={() => grid || toggleGrid()}
				>
					Grid
				</button>
				<button
					type="button"
					class="px-2.5 py-1.5 text-[11.5px] {!grid
						? 'bg-surface-3 font-semibold text-text-primary'
						: 'text-text-muted hover:text-text-secondary'}"
					aria-pressed={!grid}
					onclick={() => !grid || toggleGrid()}
				>
					List
				</button>
			</div>
		</div>
	</div>

	<!-- Grid (§6/§9) -->
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
			title={`No series match “${q.trim()}”`}
			description="Try a different search."
			neutral
		/>
	{:else if total === 0 && availability === 'unavailable'}
		<EmptyState
			title="Waiting for the first Sonarr poll"
			description="The library fills in automatically once the inventory poll completes — usually within a minute."
			neutral
		/>
	{:else if total === 0}
		<EmptyState title="No series in this filter" description="Adjust the filters above." neutral />
	{:else if grid}
		<ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
			{#each items as series (series.key)}
				<li>
					<button
						type="button"
						class="group w-full rounded-xl border border-transparent p-1.5 text-left transition-colors hover:border-border-subtle hover:bg-surface-1 focus-visible:border-border-strong focus-visible:outline-none {selectedKey ===
						series.key
							? 'border-border-strong bg-surface-1'
							: ''}"
						onclick={() => onopen?.(series)}
						aria-label="{series.title}, {series.completionPct ??
							'—'} percent complete, {series.missingCount} missing"
					>
						<PosterImage itemKey={series.key} title={series.title} version={series.posterVersion} />
						<p class="mt-1.5 truncate text-[13px] font-medium text-text-primary">{series.title}</p>
						{#if series.completionPct !== null}
							<div class="mt-1 h-1 w-full overflow-hidden rounded-full bg-surface-3">
								<div
									class="h-full rounded-full bg-accent/70"
									style="width: {Math.max(2, Math.min(100, series.completionPct))}%"
								></div>
							</div>
							<p class="mt-1 text-[11px] text-text-muted">
								<span class="tnum">{series.completionPct}%</span> complete
								{#if series.missingCount > 0}
									· <span class="text-degraded tnum">{series.missingCount} missing</span>
								{/if}
							</p>
						{:else}
							<p class="mt-1 text-[11px] text-text-muted">
								<span class="tnum">{series.missingCount}</span> missing
							</p>
						{/if}
						<p class="mt-0.5 text-[10.5px] text-text-faint">
							{seriesStatusLabel(series.status)} · {series.seasonsCount}
							{series.seasonsCount === 1 ? 'season' : 'seasons'}
						</p>
					</button>
				</li>
			{/each}
		</ul>
	{:else}
		<!-- Compact list (§146) -->
		<ul
			class="divide-y divide-border-subtle overflow-hidden rounded-[14px] border border-border-subtle bg-surface-1"
		>
			{#each items as series (series.key)}
				<li>
					<button
						type="button"
						class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none {selectedKey ===
						series.key
							? 'bg-surface-2'
							: ''}"
						onclick={() => onopen?.(series)}
						aria-label="{series.title}, {seriesStatusLabel(series.status)}, {series.completionPct ??
							'—'} percent complete, {series.missingCount} missing"
					>
						<span class="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
							{series.title}
							{#if series.year}<span class="font-normal text-text-faint">({series.year})</span>{/if}
						</span>
						<span
							class="hidden w-24 shrink-0 text-right text-[11px] {seriesStatusClass(
								series.status
							)} sm:block"
						>
							{seriesStatusLabel(series.status)}
						</span>
						<span class="w-16 shrink-0 text-right text-[11px] text-text-faint">
							{series.seasonsCount}
							{series.seasonsCount === 1 ? 'season' : 'seasons'}
						</span>
						<span class="tnum w-16 shrink-0 text-right text-[11px] text-text-muted">
							{series.completionPct === null ? '—' : `${series.completionPct}%`}
						</span>
						<span
							class="tnum w-20 shrink-0 text-right text-[11px] {series.missingCount > 0
								? 'text-degraded'
								: 'text-text-faint'}"
						>
							{series.missingCount > 0 ? `${series.missingCount} missing` : 'complete'}
						</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}

	<!-- Pagination (§29) -->
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
			<span class="tnum">{rangeLabel()}</span>
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
