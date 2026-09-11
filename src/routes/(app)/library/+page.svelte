<script lang="ts">
	/**
	 * Media Library Intelligence workspace (brief §32–§43/§89): completion
	 * first, attention second, details after. Tabs via URL state for deep
	 * links. Read-only intelligence — backlog is neutral, never an incident.
	 */
	import { page } from '$app/state';
	import AreaChart from '$lib/components/AreaChart.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';

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

	let view = $state<View>('overview');
	let data = $state<LibraryPayload | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let windowDays: 7 | 30 | 90 = $state(30);

	// detail lists, loaded per tab
	let tvMissing = $state<MissingItem[] | null>(null);
	let tvMissingTotal = $state(0);
	let movieMissing = $state<MissingItem[] | null>(null);
	let movieMissingTotal = $state(0);
	let subtitleGaps = $state<MissingItem[] | null>(null);
	let subtitleGapsTotal = $state(0);
	let missingSort = $state<'most' | 'oldest' | 'recent' | 'name'>('most');
	let subtitleLang = $state('all');

	let timer: ReturnType<typeof setInterval> | undefined;

	function switchView(next: View): void {
		view = next;
		history.replaceState(null, '', `/library?view=${next}`);
		void loadView();
	}

	async function loadSummary(): Promise<void> {
		const response = await fetch(`/api/library?window=${windowDays}`);
		if (response.ok) data = (await response.json()) as LibraryPayload;
		else error = 'Library data is temporarily unavailable.';
	}

	async function loadList(url: string, target: 'tv' | 'movies' | 'subtitles'): Promise<void> {
		const response = await fetch(url);
		if (!response.ok) return;
		const payload = (await response.json()) as { items: MissingItem[]; total: number };
		if (target === 'tv') {
			tvMissing = payload.items;
			tvMissingTotal = payload.total;
		} else if (target === 'movies') {
			movieMissing = payload.items;
			movieMissingTotal = payload.total;
		} else {
			subtitleGaps = payload.items;
			subtitleGapsTotal = payload.total;
		}
	}

	async function loadView(): Promise<void> {
		loading = true;
		error = null;
		await loadSummary();
		if (view === 'tv') await loadList(`/api/library/tv/missing?limit=50&sort=${missingSort}`, 'tv');
		if (view === 'movies')
			await loadList(`/api/library/movies/missing?limit=50&sort=${missingSort}`, 'movies');
		if (view === 'subtitles')
			await loadList(
				`/api/library/subtitles/missing?limit=50&lang=${encodeURIComponent(subtitleLang)}`,
				'subtitles'
			);
		loading = false;
	}

	$effect(() => {
		const requested = page.url.searchParams.get('view');
		if (requested && (VIEWS as readonly string[]).includes(requested)) {
			view = requested as View;
		}
		void loadView();
		timer = setInterval(() => void loadSummary(), 60_000);
		return () => clearInterval(timer);
	});

	function changeSort(next: 'most' | 'oldest' | 'recent' | 'name'): void {
		missingSort = next;
		void loadView();
	}

	const dateLabel = (value: number | null) =>
		value
			? new Date(value).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
			: '—';
	const agoLabel = (value: number | null) =>
		value === null
			? ''
			: ` · updated ${Math.max(0, Math.round((Date.now() - value) / 60_000))}m ago`;

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
				What's missing, what's queued and what needs attention — read-only.
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
			{#snippet completionCard(label: string, pct: number | null, lines: string[])}
				<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-4">
					<p class="text-[10px] font-bold uppercase tracking-[0.1em] text-text-faint">{label}</p>
					<p class="mt-1 text-3xl font-semibold tabular-nums text-text-primary">
						{pct === null ? '—' : `${pct}%`}
					</p>
					<ul class="mt-2 space-y-0.5 text-xs text-text-muted">
						{#each lines as line (line)}
							<li>{line}</li>
						{/each}
					</ul>
				</div>
			{/snippet}

			<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
				{@render completionCard(
					'TV',
					data.summary.tv?.completionPct ?? null,
					[
						data.summary.tv
							? `${data.summary.tv.missing} episodes missing`
							: 'Sonarr not configured',
						data.summary.tv ? `${data.summary.tv.upgrades} upgrades available` : '',
						data.summary.tv ? `${data.summary.tv.series} series monitored` : ''
					].filter(Boolean)
				)}
				{@render completionCard(
					'Movies',
					data.summary.movies?.completionPct ?? null,
					[
						data.summary.movies
							? `${data.summary.movies.missing} movies missing`
							: 'Radarr not configured',
						data.summary.movies ? `${data.summary.movies.upgrades} upgrades available` : '',
						data.summary.movies ? `${data.summary.movies.movies} movies in library` : ''
					].filter(Boolean)
				)}
				{@render completionCard(
					'Subtitles',
					data.summary.subtitles?.coveragePct ?? null,
					[
						data.summary.subtitles
							? `${data.summary.subtitles.gaps} subtitle gaps`
							: 'Bazarr not configured',
						data.summary.subtitles
							? `${data.summary.subtitles.episodeGaps} episode · ${data.summary.subtitles.movieGaps} movie`
							: '',
						data.summary.subtitles?.topLanguages?.length
							? `mostly ${data.summary.subtitles.topLanguages[0]!.name}`
							: ''
					].filter(Boolean)
				)}
			</div>

			<!-- Attention (§31): above plain totals when present -->
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
									<p class="mt-0.5 text-[11.5px] text-text-muted">{item.detail}</p>
								</a>
							</li>
						{/each}
					</ul>
				</section>
			{:else}
				<EmptyState
					title="Nothing needs attention"
					description="Backlog, imports and integrations all look normal."
					neutral
				/>
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
			<section aria-label="TV missing episodes">
				<div class="mb-2 flex flex-wrap items-center gap-2">
					<h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-text-faint">
						Missing episodes — {tvMissingTotal}
					</h3>
					<div class="ml-auto flex gap-1">
						{#each ['most', 'oldest', 'recent', 'name'] as sort (sort)}
							<button
								type="button"
								class="rounded-md px-2 py-0.5 text-[11px] {missingSort === sort
									? 'bg-surface-3 font-semibold text-text-primary'
									: 'text-text-muted hover:text-text-secondary'}"
								onclick={() => changeSort(sort as 'most')}
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
				{#if data.summary.tv && data.summary.tv.missing === 0}
					<EmptyState
						title="No missing episodes"
						description="Your monitored TV library is complete."
						neutral
					/>
				{:else if tvMissing && tvMissing.length > 0}
					<ul
						class="divide-y divide-border-subtle overflow-hidden rounded-[14px] border border-border-subtle bg-surface-1"
					>
						{#each tvMissing as item (item.id)}
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
				{/if}
				{#if data.summary.tv}
					<p class="mt-3 text-[11px] text-text-faint">
						Backlog ages — ≤24h: {data.summary.tv.backlogAges?.new ?? 0} · 1–7d: {data.summary.tv
							.backlogAges?.['1-7d'] ?? 0} · 7–30d: {data.summary.tv.backlogAges?.['7-30d'] ?? 0} · 30d+:
						{data.summary.tv.backlogAges?.['30d+'] ?? 0}
					</p>
				{/if}
			</section>
		{/if}

		{#if view === 'movies'}
			<section aria-label="Missing movies">
				<h3 class="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-text-faint">
					Missing movies — {movieMissingTotal}
				</h3>
				{#if data.summary.movies && data.summary.movies.missing === 0}
					<EmptyState
						title="No missing movies"
						description="Your monitored movie library is complete."
						neutral
					/>
				{:else if movieMissing && movieMissing.length > 0}
					<ul
						class="divide-y divide-border-subtle overflow-hidden rounded-[14px] border border-border-subtle bg-surface-1"
					>
						{#each movieMissing as item (item.id)}
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
				{/if}
			</section>
		{/if}

		{#if view === 'subtitles'}
			<section aria-label="Subtitle coverage">
				{#if data.availability.subtitles === 'unconfigured'}
					<EmptyState
						title="Detailed subtitle monitoring isn't configured"
						description="Basic Bazarr process monitoring remains active. Configure Bazarr in Settings to see subtitle coverage."
					/>
				{:else if data.summary.subtitles}
					<div class="mb-4 overflow-hidden rounded-[14px] border border-border-subtle bg-surface-1">
						<table class="w-full text-left text-[13px]">
							<thead>
								<tr
									class="border-b border-border-subtle text-[11px] uppercase tracking-wider text-text-faint"
								>
									<th class="px-4 py-2.5 font-semibold">Language</th>
									<th class="px-4 py-2.5 text-right font-semibold">Required</th>
									<th class="px-4 py-2.5 text-right font-semibold">Missing</th>
									<th class="px-4 py-2.5 text-right font-semibold">Coverage</th>
								</tr>
							</thead>
							<tbody>
								{#each data.summary.subtitles.topLanguages as lang (lang.code2)}
									<tr class="border-b border-border-subtle last:border-0">
										<td class="px-4 py-2 font-medium text-text-primary">{lang.name}</td>
										<td class="tnum px-4 py-2 text-right">{lang.required}</td>
										<td class="tnum px-4 py-2 text-right">{lang.missing}</td>
										<td class="tnum px-4 py-2 text-right font-medium"
											>{lang.coveragePct === null ? '—' : `${lang.coveragePct}%`}</td
										>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<h3 class="mb-2 text-[11px] font-bold uppercase tracking-[0.1em] text-text-faint">
						Titles with missing subtitles — {subtitleGapsTotal}
					</h3>
					{#if subtitleGaps && subtitleGaps.length > 0}
						<ul
							class="divide-y divide-border-subtle overflow-hidden rounded-[14px] border border-border-subtle bg-surface-1"
						>
							{#each subtitleGaps as item (item.id)}
								<li class="flex items-center gap-3 px-4 py-2.5">
									<span class="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary"
										>{item.title}</span
									>
									<span class="shrink-0 text-[11px] text-text-muted">{item.detail}</span>
								</li>
							{/each}
						</ul>
					{/if}
				{/if}
			</section>
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
