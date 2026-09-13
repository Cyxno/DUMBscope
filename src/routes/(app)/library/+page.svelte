<script lang="ts">
	/**
	 * Media Library workspace: Overview (Library Intelligence, unchanged §3),
	 * plus the read-only Unified Library Manager browsers for TV, Movies and
	 * Subtitles. All list state (view/filter/sort/search/page/item) lives in
	 * the URL so deep links and browser back work (§69/§70/§134/§136).
	 */
	import { page } from '$app/state';
	import { pushState, replaceState } from '$app/navigation';
	import AreaChart from '$lib/components/AreaChart.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Drawer from '$lib/components/Drawer.svelte';
	import TvBrowser from '$lib/components/library/TvBrowser.svelte';
	import SeriesDetail from '$lib/components/library/SeriesDetail.svelte';
	import MoviesBrowser from '$lib/components/library/MoviesBrowser.svelte';
	import MovieDetail from '$lib/components/library/MovieDetail.svelte';
	import SubtitlesBrowser from '$lib/components/library/SubtitlesBrowser.svelte';

	interface BacklogAges {
		new: number;
		'1-7d': number;
		'7-30d': number;
		'30d+': number;
	}
	interface LibraryPayload {
		availability: Record<'tv' | 'movies' | 'subtitles', string>;
		fetchedAt: number | null;
		summary: {
			tv: {
				completionPct: number | null;
				missing: number;
				upgrades: number;
				queue: number;
				series: number;
				backlogAges: BacklogAges | null;
			} | null;
			movies: {
				completionPct: number | null;
				missing: number;
				upgrades: number;
				queue: number;
				movies: number;
				backlogAges: BacklogAges | null;
			} | null;
			subtitles: {
				coveragePct: number | null;
				gaps: number;
				episodeGaps: number;
				movieGaps: number;
				topLanguages: {
					code2: string;
					name: string;
					required: number;
					missing: number;
					coveragePct: number | null;
				}[];
			} | null;
		};
		queue: {
			groups: { kind: string; count: number; sources: { type: string; count: number }[] }[];
			issues: {
				integrationId: string;
				title: string;
				reason: string;
				type: string;
				severity: string;
			}[];
			total: number;
		};
		healthWarnings: { integrationId: string; type: string; message: string }[];
		attention: { id: string; severity: string; title: string; detail: string; href: string }[];
		recent: {
			added: { id: string; title: string; detail: string | null; at: number; href: string }[];
			missing: { id: string; title: string; detail: string | null; at: number; href: string }[];
			imported: { id: string; title: string; detail: string | null; at: number; href: string }[];
		};
		trends: {
			windowDays: number;
			tv: { at: number; missing: number; upgrades: number }[];
			movies: { at: number; missing: number; upgrades: number }[];
			subtitles: { at: number; missing: number; upgrades: number; gaps: number | null }[];
		};
		integrations?: { id: string; type: string }[];
	}

	interface MissingItem {
		id: string;
		title: string;
		detail: string | null;
		releasedAt: number | null;
		ageBucket: string | null;
		status: string;
	}

	const VIEWS = ['overview', 'tv', 'movies', 'subtitles', 'queue'] as const;
	type View = (typeof VIEWS)[number];

	/** URL params the browsers own (§136). Cleared on view switches. */

	let view = $state<View>('overview');
	let data = $state<LibraryPayload | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let windowDays: 7 | 30 | 90 = $state(30);

	// Missing-episode backlog panel (preserved Library Intelligence list, §30).
	let tvMissing = $state<MissingItem[] | null>(null);
	let tvMissingTotal = $state(0);
	let missingSort = $state<'most' | 'oldest' | 'recent' | 'name'>('most');

	// Detail drawers (canonical URL: item param, §69/§70).
	interface SeriesSummaryLite {
		key: string;
		title: string;
		posterVersion?: string | null;
	}
	let seriesKey = $state<string | null>(null);
	let seriesSummary = $state<SeriesSummaryLite | null>(null);
	let movieKey = $state<string | null>(null);
	let movieSummary = $state<SeriesSummaryLite | null>(null);

	let timer: ReturnType<typeof setInterval> | undefined;

	function parseUrlState(): Record<string, string> {
		const out: Record<string, string> = {};
		for (const [key, value] of page.url.searchParams.entries()) out[key] = value;
		return out;
	}

	/** Browsers react to this (back/forward) and echo changes via onparams. */
	let urlState = $state<Record<string, string>>({});

	/** Backlog age chip (§7/§8): URL-shared so chips are bookmarkable. */
	const backlogAge = $derived(urlState.backlogAge ?? '');

	$effect(() => {
		// Track URL (incl. popstate/back — §135) and adopt into state.
		const sp = page.url.searchParams;
		const requestedView = sp.get('view');
		if (requestedView && (VIEWS as readonly string[]).includes(requestedView)) {
			view = requestedView as View;
		}
		urlState = parseUrlState();
		const item = sp.get('item');
		if (!item) {
			seriesKey = null;
			movieKey = null;
		} else if (item.startsWith('sonarr-series-')) {
			seriesKey = item;
			movieKey = null;
		} else if (item.startsWith('radarr-movie-')) {
			movieKey = item;
			seriesKey = null;
		}
	});

	function setParams(update: Record<string, string | null>, push = false): void {
		// Raw history mutations don't notify SvelteKit's page store, so the
		// local mirror is kept in sync for the next param update.
		const sp = new URLSearchParams(urlState);
		for (const [key, value] of Object.entries(update)) {
			if (value === null || value === '') sp.delete(key);
			else sp.set(key, value);
		}
		const next: Record<string, string> = {};
		for (const [key, value] of sp.entries()) next[key] = value;
		const qs = sp.toString();
		const url = `/library${qs ? `?${qs}` : ''}`;
		// SvelteKit shallow routing: these update page.url and make
		// browser back/forward fire popstate into our adoption effect (§62).
		if (push) void pushState(url, {});
		else void replaceState(url, {});
		urlState = next;
	}

	function switchView(next: View): void {
		void replaceState(`/library?view=${next}`, {});
		seriesKey = null;
		movieKey = null;
		urlState = { view: next };
		void loadView();
	}

	async function loadSummary(): Promise<void> {
		const response = await fetch(`/api/library?window=${windowDays}`);
		if (response.ok) data = (await response.json()) as LibraryPayload;
		else error = 'Library data is temporarily unavailable.';
	}

	async function loadMissingBacklog(): Promise<void> {
		const response = await fetch(`/api/library/tv/missing?limit=50&sort=${missingSort}`);
		if (!response.ok) return;
		const payload = (await response.json()) as { items: MissingItem[]; total: number };
		tvMissing = payload.items;
		tvMissingTotal = payload.total;
	}

	async function loadView(): Promise<void> {
		loading = true;
		error = null;
		await loadSummary();
		if (view === 'tv') void loadMissingBacklog();
		loading = false;
	}

	$effect(() => {
		void loadView();
		timer = setInterval(() => void loadSummary(), 60_000);
		return () => clearInterval(timer);
	});

	function changeMissingSort(next: 'most' | 'oldest' | 'recent' | 'name'): void {
		missingSort = next;
		void loadMissingBacklog();
	}

	const tvInitial = $derived({
		q: urlState.q,
		filter: urlState.filter,
		sort: urlState.sort,
		offset: urlState.offset ? Number(urlState.offset) : undefined
	});
	const moviesInitial = $derived({
		q: urlState.q,
		filter: urlState.filter,
		sort: urlState.sort,
		offset: urlState.offset ? Number(urlState.offset) : undefined
	});
	const subtitlesInitial = $derived({
		mode: urlState.sbmode,
		filter: urlState.sbfilter,
		lang: urlState.sblang
	});

	function openSeries(item: SeriesSummaryLite): void {
		seriesSummary = item;
		seriesKey = item.key;
		setParams({ item: item.key }, true);
	}
	function openMovie(item: SeriesSummaryLite): void {
		movieSummary = item;
		movieKey = item.key;
		setParams({ item: item.key }, true);
	}
	function openMovieKey(key: string): void {
		movieSummary = null;
		movieKey = key;
		setParams({ item: key }, true);
	}
	function closeDrawer(): void {
		seriesKey = null;
		movieKey = null;
		setParams({ item: null });
	}

	const dateLabel = (value: number | null) =>
		value
			? new Date(value).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
			: '—';
	const agoLabel = (value: number | null) =>
		value === null
			? ''
			: ` · updated ${Math.max(0, Math.round((Date.now() - value) / 60_000))}m ago`;
	/** Compact "how long ago" for recent lists (§70). */
	const sinceLabel = (value: number) => {
		const minutes = Math.max(1, Math.round((Date.now() - value) / 60_000));
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.round(minutes / 60);
		if (hours < 48) return `${hours}h`;
		return `${Math.round(hours / 24)}d`;
	};

	function recentHas(d: NonNullable<LibraryPayload>): boolean {
		return d.recent.added.length > 0 || d.recent.missing.length > 0 || d.recent.imported.length > 0;
	}

	/** Client-side age filter over the loaded backlog page (§7/§8). */
	const filteredTvMissing = $derived(
		!backlogAge ? (tvMissing ?? []) : (tvMissing ?? []).filter((m) => m.ageBucket === backlogAge)
	);

	function severityClass(severity: string): string {
		return severity === 'issue'
			? 'text-critical'
			: severity === 'attention'
				? 'text-degraded'
				: 'text-text-muted';
	}
</script>

<div class="mx-auto max-w-[1400px] space-y-5 px-4 py-6 md:px-8">
	<header class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h2 class="text-lg font-semibold tracking-tight">Media library</h2>
			<p class="mt-0.5 text-[13px] text-text-muted">
				What's in your library, what's missing and what needs attention — read-only.
				{#if data?.fetchedAt}{agoLabel(data.fetchedAt)}{/if}
			</p>
		</div>
		{#if view !== 'overview'}
			<button
				type="button"
				class="rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary"
				onclick={() => switchView('overview')}
			>
				← Overview
			</button>
		{/if}
	</header>

	<!-- Tabs (§34) -->
	<nav class="flex gap-1 overflow-x-auto" aria-label="Library sections">
		{#each VIEWS as v (v)}
			<button
				type="button"
				class="rounded-lg px-3.5 py-1.5 text-[13px] font-medium capitalize transition-colors {view ===
				v
					? 'bg-surface-3 text-text-primary'
					: 'text-text-muted hover:bg-surface-2 hover:text-text-secondary'}"
				aria-current={view === v ? 'page' : undefined}
				onclick={() => switchView(v)}
			>
				{v === 'overview'
					? 'Overview'
					: v === 'tv'
						? 'TV'
						: v === 'movies'
							? 'Movies'
							: v === 'subtitles'
								? 'Subtitles'
								: 'Queue'}
			</button>
		{/each}
	</nav>

	{#if error && !data}
		<EmptyState title="Library unavailable" description={error} />
	{:else if loading && !data}
		<div class="py-10 text-center text-sm text-text-muted">Loading library…</div>
	{:else if data}
		<!-- Onboarding / partial data banner (§98) -->
		{#if data.availability.tv === 'unconfigured' && data.availability.movies === 'unconfigured' && data.availability.subtitles === 'unconfigured'}
			<div
				class="rounded-[14px] border border-border-subtle bg-surface-1 px-4 py-3 text-xs text-text-muted"
			>
				Connect Sonarr, Radarr or Bazarr in
				<a href="/settings" class="font-medium text-accent-text hover:underline">Settings</a>
				for deeper library insights. Basic process monitoring stays active regardless.
			</div>
		{/if}

		{#if view === 'overview'}
			{#snippet countLink(
				label: string,
				count: number | null,
				href: string,
				tone: 'degraded' | 'muted' | 'faint' = 'muted'
			)}
				{#if count !== null}
					<a
						{href}
						class="inline-flex items-baseline gap-1 transition-colors hover:text-text-primary {tone ===
						'degraded'
							? 'text-degraded hover:underline'
							: tone === 'faint'
								? 'text-text-faint hover:text-text-muted'
								: 'text-text-muted hover:text-text-secondary'}"
					>
						<span class="tnum">{count}</span>
						{label}
					</a>
				{/if}
			{/snippet}

			{#snippet completionCard(
				label: string,
				pct: number | null,
				lines: {
					text: string;
					href?: string;
					count?: number | null;
					tone?: 'degraded' | 'muted' | 'faint';
				}[],
				browseHref: string
			)}
				<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-4">
					<p class="text-[10px] font-bold uppercase tracking-[0.1em] text-text-faint">{label}</p>
					<p class="mt-1 text-3xl font-semibold tabular-nums text-text-primary">
						{pct === null ? '—' : `${pct}%`}
					</p>
					<ul class="mt-2 space-y-0.5 text-xs text-text-muted">
						{#each lines as line (line.text)}
							<li>
								{#if line.href && line.count !== undefined}
									{@render countLink(line.text, line.count, line.href, line.tone ?? 'muted')}
								{:else}
									{line.text}
								{/if}
							</li>
						{/each}
					</ul>
					<a
						href={browseHref}
						class="mt-2 inline-block text-[11.5px] font-medium text-accent-text hover:underline"
					>
						Browse library →
					</a>
				</div>
			{/snippet}

			<!-- Attention (§5/§31): operational problems rank first, always on top -->
			{#if data.attention.length > 0}
				<section aria-label="Needs attention">
					<h3 class="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-degraded">
						Needs attention
					</h3>
					<ul class="grid grid-cols-1 gap-2 md:grid-cols-2">
						{#each data.attention as item (item.id)}
							<li>
								<a
									href={item.href}
									class="block rounded-xl border border-border-subtle bg-surface-1 px-3.5 py-2.5 transition-colors hover:border-border-strong"
								>
									<p class="text-[13px] font-semibold {severityClass(item.severity)}">
										{item.title}
									</p>
									<p class="mt-0.5 line-clamp-3 text-[11.5px] text-text-muted" title={item.detail}>
										{item.detail}
									</p>
								</a>
							</li>
						{/each}
					</ul>
				</section>
			{:else}
				<p class="text-[11.5px] text-text-faint">
					✓ Nothing needs attention — backlog, imports and integrations all look normal.
				</p>
			{/if}

			<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
				{@render completionCard(
					'TV',
					data.summary.tv?.completionPct ?? null,
					[
						data.summary.tv
							? {
									text: 'episodes missing',
									count: data.summary.tv.missing,
									href: '/library?view=tv&filter=incomplete&sort=missing-oldest',
									tone: data.summary.tv.missing > 0 ? ('degraded' as const) : ('muted' as const)
								}
							: { text: 'Sonarr not configured' },
						data.summary.tv
							? {
									text: 'upgrades available',
									count: data.summary.tv.upgrades,
									href: '/library?view=tv&filter=upgrades'
								}
							: { text: '' },
						data.summary.tv ? { text: `${data.summary.tv.series} series monitored` } : { text: '' }
					].filter((l) => l.text !== ''),
					'/library?view=tv'
				)}
				{@render completionCard(
					'Movies',
					data.summary.movies?.completionPct ?? null,
					[
						data.summary.movies
							? {
									text: 'movies missing',
									count: data.summary.movies.missing,
									href: '/library?view=movies&filter=missing&sort=missing-oldest',
									tone: data.summary.movies.missing > 0 ? ('degraded' as const) : ('muted' as const)
								}
							: { text: 'Radarr not configured' },
						data.summary.movies
							? {
									text: 'upgrades available',
									count: data.summary.movies.upgrades,
									href: '/library?view=movies&filter=upgrades'
								}
							: { text: '' },
						data.summary.movies
							? { text: `${data.summary.movies.movies} movies in library` }
							: { text: '' }
					].filter((l) => l.text !== ''),
					'/library?view=movies'
				)}
				{@render completionCard(
					'Subtitles',
					data.summary.subtitles?.coveragePct ?? null,
					[
						data.summary.subtitles
							? {
									text: 'subtitle gaps',
									count: data.summary.subtitles.gaps,
									href: '/library?view=subtitles',
									tone: data.summary.subtitles.gaps > 0 ? ('degraded' as const) : ('muted' as const)
								}
							: { text: 'Bazarr not configured' },
						data.summary.subtitles
							? {
									text: `${data.summary.subtitles.episodeGaps} episode · ${data.summary.subtitles.movieGaps} movie`
								}
							: { text: '' },
						data.summary.subtitles?.topLanguages?.length
							? { text: `mostly ${data.summary.subtitles.topLanguages[0]!.name}` }
							: { text: '' }
					].filter((l) => l.text !== ''),
					'/library?view=subtitles'
				)}
			</div>

			<!-- Aging backlog (§7/§80): age as first-class, clickable, never alarmist -->
			{#if data.summary.tv?.backlogAges || data.summary.movies?.backlogAges}
				<section aria-label="Backlog age" class="flex flex-wrap items-center gap-x-4 gap-y-1">
					<h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-text-faint">
						Backlog age
					</h3>
					<div class="flex flex-wrap gap-1.5">
						{#each [['new', '≤24h'], ['1-7d', '1–7d'], ['7-30d', '7–30d'], ['30d+', '30d+']] as [bucket, chip] (bucket)}
							{@const tvCount = data.summary.tv?.backlogAges?.[bucket as 'new'] ?? 0}
							{@const movieCount = data.summary.movies?.backlogAges?.[bucket as 'new'] ?? 0}
							{@const total = tvCount + movieCount}
							<a
								href={`/library?view=tv&filter=incomplete&sort=missing-oldest&backlogAge=${bucket}`}
								class="rounded-full border border-border-subtle bg-surface-1 px-3 py-1 text-[11.5px] text-text-muted transition-colors hover:border-border-strong hover:text-text-secondary"
							>
								{chip}
								<b class="tnum {total > 0 ? 'text-text-secondary' : 'text-text-faint'}">{total}</b>
							</a>
						{/each}
					</div>
				</section>
			{/if}

			<!-- Recently changed (§70/§71): compact, representative, deep-linked -->
			{#if recentHas(data)}
				<section aria-label="Recently changed">
					<h3 class="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-text-faint">
						Recently changed
					</h3>
					<div class="grid grid-cols-1 gap-3 md:grid-cols-3">
						{#snippet recentList(
							title: string,
							items: {
								id: string;
								title: string;
								detail: string | null;
								at: number;
								href: string;
							}[],
							viewAllHref: string
						)}
							<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-3">
								<p class="text-[11px] font-semibold text-text-secondary">{title}</p>
								{#if items.length === 0}
									<p class="mt-1.5 text-[11.5px] text-text-faint">Nothing recent.</p>
								{:else}
									<ul class="mt-1 space-y-1">
										{#each items.slice(0, 5) as item (item.id)}
											<li class="flex items-baseline gap-2 text-[12px]">
												<a
													href={item.href}
													class="min-w-0 flex-1 truncate text-text-secondary hover:text-text-primary hover:underline"
													title={item.title}
												>
													{item.title}
													{#if item.detail}<span class="text-text-faint">{item.detail}</span>{/if}
												</a>
												<span class="tnum shrink-0 text-[10.5px] text-text-faint"
													>{sinceLabel(item.at)}</span
												>
											</li>
										{/each}
									</ul>
									<a
										href={viewAllHref}
										class="mt-1.5 inline-block text-[11px] text-accent-text hover:underline"
										>View all →</a
									>
								{/if}
							</div>
						{/snippet}
						{@render recentList(
							'Recently added',
							data.recent.added,
							'/library?view=movies&sort=added'
						)}
						{@render recentList(
							'Recently missing',
							data.recent.missing,
							'/library?view=tv&filter=incomplete&sort=missing-oldest'
						)}
						{@render recentList('Recently imported', data.recent.imported, '/activity')}
					</div>
				</section>
			{/if}

			<!-- Trends (§60): compact, textual summary included for a11y (§92) -->
			{#if data.trends.tv.length > 1 || data.trends.movies.length > 1 || data.trends.subtitles.length > 1}
				<section aria-label="Library trends">
					<div class="mb-2 flex items-center justify-between">
						<h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-text-faint">
							Trends — last {data.trends.windowDays} days
						</h3>
						<div class="flex gap-1">
							{#each [7, 30, 90] as w (w)}
								<button
									type="button"
									class="rounded-md px-2 py-0.5 text-[11px] {windowDays === w
										? 'bg-surface-3 font-semibold text-text-primary'
										: 'text-text-muted hover:text-text-secondary'}"
									onclick={() => {
										windowDays = w as 7 | 30 | 90;
										void loadSummary();
									}}
								>
									{w}d
								</button>
							{/each}
						</div>
					</div>
					<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
						{#if data.trends.tv.length > 1}
							<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-4">
								<p class="text-xs font-semibold text-text-secondary">
									Missing TV episodes: {data.trends.tv.at(-1)?.missing ?? '—'}
									{#if (data.trends.tv.at(-1)?.missing ?? 0) < (data.trends.tv[0]?.missing ?? 0)}
										<span class="text-healthy">↓ improving</span>
									{/if}
								</p>
								<AreaChart
									series={[
										{
											name: 'Missing',
											color: 'var(--accent)',
											points: data.trends.tv.map((p) => ({ t: p.at, v: p.missing }))
										}
									]}
									height={110}
								/>
							</div>
						{/if}
						{#if data.trends.subtitles.length > 1}
							<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-4">
								<p class="text-xs font-semibold text-text-secondary">
									Subtitle gaps: {data.trends.subtitles.at(-1)?.gaps ?? '—'}
								</p>
								<AreaChart
									series={[
										{
											name: 'Gaps',
											color: 'var(--healthy)',
											points: data.trends.subtitles.map((p) => ({ t: p.at, v: p.gaps ?? 0 }))
										}
									]}
									height={110}
								/>
							</div>
						{/if}
					</div>
				</section>
			{:else}
				<p class="text-xs text-text-faint">
					Trend data will appear after DUMBscope has collected hourly library snapshots.
				</p>
			{/if}
		{/if}

		{#if view === 'tv'}
			<TvBrowser
				initial={tvInitial}
				onparams={(p) =>
					setParams({
						q: p.q ?? null,
						filter: p.filter ?? null,
						sort: p.sort ?? null,
						offset: p.offset === undefined ? null : String(p.offset)
					})}
				selectedKey={seriesKey}
				onopen={openSeries}
			/>

			<!-- Missing episode backlog — preserved Library Intelligence list (§30) -->
			{#if data.summary.tv && data.summary.tv.missing > 0}
				<section aria-label="Missing episode backlog">
					<div class="mb-2 flex flex-wrap items-center gap-2">
						<h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-text-faint">
							Missing episode backlog — {tvMissingTotal}
						</h3>
						<div class="flex flex-wrap gap-1" role="group" aria-label="Backlog age filter">
							{#each [['', 'All'], ['new', '≤24h'], ['1-7d', '1–7d'], ['7-30d', '7–30d'], ['30d+', '30d+']] as [bucket, chip] (chip)}
								<button
									type="button"
									class="rounded-full px-2.5 py-0.5 text-[11px] transition-colors {backlogAge ===
									bucket
										? 'bg-surface-3 font-semibold text-text-primary'
										: 'text-text-muted hover:bg-surface-2 hover:text-text-secondary'}"
									aria-pressed={backlogAge === bucket}
									onclick={() => setParams({ backlogAge: bucket || null }, true)}
								>
									{chip}
								</button>
							{/each}
						</div>
						<div class="ml-auto flex gap-1">
							{#each ['most', 'oldest', 'recent', 'name'] as sort (sort)}
								<button
									type="button"
									class="rounded-md px-2 py-0.5 text-[11px] {missingSort === sort
										? 'bg-surface-3 font-semibold text-text-primary'
										: 'text-text-muted hover:text-text-secondary'}"
									onclick={() => changeMissingSort(sort as 'most')}
								>
									{sort === 'most'
										? 'Most missing'
										: sort === 'oldest'
											? 'Oldest'
											: sort === 'recent'
												? 'Recently aired'
												: 'Name'}
								</button>
							{/each}
						</div>
					</div>
					{#if filteredTvMissing.length === 0}
						<p
							class="rounded-[14px] border border-border-subtle bg-surface-1 px-4 py-3 text-[12px] text-text-muted"
						>
							No missing episodes in this age range.
						</p>
					{:else}
						<ul
							class="divide-y divide-border-subtle overflow-hidden rounded-[14px] border border-border-subtle bg-surface-1"
						>
							{#each filteredTvMissing as item (item.id)}
								<li class="flex items-center gap-3 px-4 py-2.5">
									<span class="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary"
										>{item.title}</span
									>
									<span class="shrink-0 text-[11px] text-text-muted">{item.detail}</span>
									<span class="tnum w-20 shrink-0 text-right text-[11px] text-text-faint"
										>{dateLabel(item.releasedAt)}</span
									>
									<span class="w-14 shrink-0 text-right text-[11px] text-text-faint"
										>{item.ageBucket ?? ''}</span
									>
								</li>
							{/each}
						</ul>
						{#if backlogAge && filteredTvMissing.length !== tvMissing?.length}
							<p class="mt-1.5 text-[11px] text-text-faint">
								Showing {filteredTvMissing.length} of {tvMissing?.length ?? 0} loaded entries — clear
								the age filter to see everything.
							</p>
						{/if}
					{/if}
					{#if data.summary.tv?.backlogAges}
						<p class="mt-3 text-[11px] text-text-faint">
							Backlog ages — ≤24h: {data.summary.tv.backlogAges?.new ?? 0} · 1–7d: {data.summary.tv
								.backlogAges?.['1-7d'] ?? 0} · 7–30d: {data.summary.tv.backlogAges?.['7-30d'] ?? 0} ·
							30d+:
							{data.summary.tv.backlogAges?.['30d+'] ?? 0}
						</p>
					{/if}
				</section>
			{/if}
		{/if}

		{#if view === 'movies'}
			<MoviesBrowser
				initial={moviesInitial}
				onparams={(p) =>
					setParams({
						q: p.q ?? null,
						filter: p.filter ?? null,
						sort: p.sort ?? null,
						offset: p.offset === undefined ? null : String(p.offset)
					})}
				selectedKey={movieKey}
				onopen={openMovie}
			/>
		{/if}

		{#if view === 'subtitles'}
			<SubtitlesBrowser
				initial={subtitlesInitial}
				onparams={(p) =>
					setParams({
						sbmode: p.mode ?? null,
						sbfilter: p.filter ?? null,
						sblang: p.lang ?? null
					})}
				onopenMovie={openMovieKey}
			/>
		{/if}

		{#if view === 'queue'}
			<section aria-label="Download queue">
				<h3 class="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-text-faint">
					Queue — {data.queue.total} items
				</h3>
				{#if data.queue.groups.length === 0}
					<EmptyState title="Queue is empty" description="No active downloads right now." neutral />
				{:else}
					<div class="mb-3 flex flex-wrap gap-2">
						{#each data.queue.groups as group (group.kind)}
							<span
								class="rounded-full border border-border-subtle bg-surface-1 px-3 py-1 text-[11.5px] capitalize text-text-secondary"
							>
								{group.kind}: <b class="tnum">{group.count}</b>
								<span class="text-text-faint">({group.sources.map((s) => s.type).join(', ')})</span>
							</span>
						{/each}
					</div>
				{/if}
				{#if data.queue.issues.length > 0}
					<h3 class="mb-2 mt-4 text-[11px] font-bold uppercase tracking-[0.1em] text-degraded">
						Queue issues
					</h3>
					<ul class="space-y-1.5">
						{#each data.queue.issues as issue (issue.integrationId + issue.title)}
							<li class="rounded-xl border border-degraded/40 bg-surface-1 px-3.5 py-2.5">
								<p class="text-[13px] font-semibold text-degraded">{issue.title} — {issue.type}</p>
								<p class="text-[11.5px] text-text-muted">{issue.reason}</p>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	{/if}
</div>

<!-- Series detail drawer (§70: desktop drawer + canonical URL; full screen on mobile) -->
<Drawer
	open={seriesKey !== null}
	title={seriesSummary?.title ?? 'Series'}
	subtitle="TV library · Sonarr"
	onclose={closeDrawer}
>
	{#if seriesKey}
		<SeriesDetail itemKey={seriesKey} summary={seriesSummary} />
	{/if}
</Drawer>

<Drawer
	open={movieKey !== null}
	title={movieSummary?.title ?? 'Movie'}
	subtitle="Movie library · Radarr"
	onclose={closeDrawer}
>
	{#if movieKey}
		<MovieDetail itemKey={movieKey} />
	{/if}
</Drawer>
