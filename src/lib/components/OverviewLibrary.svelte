<script lang="ts">
	/**
	 * Overview Library card (brief §30/§83): compact completion + backlog
	 * numbers. Only renders when at least one deep media integration exists.
	 * Backlog is neutral; upgrades are accent, never alarms (§42/§90).
	 */
	import { onMount } from 'svelte';

	interface Summary {
		availability: Record<'tv' | 'movies' | 'subtitles', string>;
		fetchedAt: number | null;
		summary: {
			tv: { completionPct: number | null; missing: number; upgrades: number } | null;
			movies: { completionPct: number | null; missing: number; upgrades: number } | null;
			subtitles: { coveragePct: number | null; gaps: number } | null;
		};
		attention: { id: string; severity: string; title: string }[];
	}

	let summary = $state<Summary | null>(null);
	let timer: ReturnType<typeof setInterval> | undefined;

	onMount(() => {
		const load = async () => {
			const response = await fetch('/api/library');
			if (response.ok) summary = (await response.json()) as Summary;
		};
		void load();
		timer = setInterval(() => void load(), 60_000);
		return () => clearInterval(timer);
	});

	const hasAny = $derived(
		summary && Object.values(summary.availability).some((s) => s === 'available' || s === 'stale')
	);
</script>

{#if hasAny && summary}
	<div class="rounded-xl border border-border-subtle bg-surface-1 p-4 shadow-[var(--shadow-1)]">
		<div class="flex items-baseline justify-between">
			<p class="text-sm font-semibold text-text-primary">Library</p>
			<a
				href="/library"
				class="text-[11px] font-medium text-text-muted transition-colors hover:text-text-primary"
			>
				Open →
			</a>
		</div>
		{#if summary.attention.some((item) => item.severity === 'issue' || item.severity === 'attention')}
			<p class="mt-2 text-[11.5px] font-medium text-degraded">
				Needs attention — {summary.attention.filter((i) => i.severity !== 'backlog').length} items
			</p>
		{/if}
		<div class="mt-3 grid grid-cols-3 gap-3">
			<div>
				<p class="text-[10px] uppercase tracking-wide text-text-faint">TV</p>
				<p class="text-lg font-semibold tabular-nums text-text-primary">
					{summary.summary.tv?.completionPct === null || summary.summary.tv === null
						? '—'
						: `${summary.summary.tv.completionPct}%`}
				</p>
				<p class="text-[10.5px] text-text-muted">
					{summary.summary.tv
						? `${summary.summary.tv.missing} missing · ${summary.summary.tv.upgrades} upgrades`
						: 'not configured'}
				</p>
				{#if summary.summary.tv}
					<a
						href="/library?view=tv&filter=missing"
						class="text-[10.5px] font-medium text-accent-text hover:underline"
					>
						Which episodes? →
					</a>
				{/if}
			</div>
			<div>
				<p class="text-[10px] uppercase tracking-wide text-text-faint">Movies</p>
				<p class="text-lg font-semibold tabular-nums text-text-primary">
					{summary.summary.movies?.completionPct === null || summary.summary.movies === null
						? '—'
						: `${summary.summary.movies.completionPct}%`}
				</p>
				<p class="text-[10.5px] text-text-muted">
					{summary.summary.movies
						? `${summary.summary.movies.missing} missing · ${summary.summary.movies.upgrades} upgrades`
						: 'not configured'}
				</p>
				{#if summary.summary.movies}
					<a
						href="/library?view=movies&filter=missing"
						class="text-[10.5px] font-medium text-accent-text hover:underline"
					>
						Which movies? →
					</a>
				{/if}
			</div>
			<div>
				<p class="text-[10px] uppercase tracking-wide text-text-faint">Subtitles</p>
				<p class="text-lg font-semibold tabular-nums text-text-primary">
					{summary.summary.subtitles?.coveragePct === null || summary.summary.subtitles === null
						? '—'
						: `${summary.summary.subtitles.coveragePct}%`}
				</p>
				<p class="text-[10.5px] text-text-muted">
					{summary.summary.subtitles ? `${summary.summary.subtitles.gaps} gaps` : 'not configured'}
				</p>
				{#if summary.summary.subtitles}
					<a
						href="/library?view=subtitles"
						class="text-[10.5px] font-medium text-accent-text hover:underline"
					>
						Which gaps? →
					</a>
				{/if}
			</div>
		</div>
	</div>
{/if}
