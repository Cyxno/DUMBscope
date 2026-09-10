<script lang="ts">
	/**
	 * Overview v0.2 dynamic bento (brief §4/§5/§24): only cards with real,
	 * configured data sources render. A missing integration never shows as an
	 * error card — it's simply absent.
	 */
	import { onMount } from 'svelte';

	interface Overview {
		services: { online: number; total: number; unhealthy: number };
		incidents: { active: number };
		cards: {
			acquisition: {
				active: number;
				queued: number;
				importIssues: number;
				wanted: number;
				cutoffUnmet: number;
			} | null;
			indexers: { healthy: number; failed: number; warnings: number } | null;
			requests: { pending: number; approved: number; total: number } | null;
			media: { active: number; directPlay: number; transcode: number } | null;
		};
		recent: {
			id: string;
			at: number;
			source: string;
			category: string;
			title: string;
		}[];
	}

	let overview = $state<Overview | null>(null);
	let timer: ReturnType<typeof setInterval> | undefined;

	onMount(() => {
		const load = async () => {
			const response = await fetch('/api/overview');
			if (response.ok) overview = (await response.json()) as Overview;
		};
		void load();
		timer = setInterval(() => void load(), 15_000);
		return () => clearInterval(timer);
	});

	const timeLabel = (at: number) =>
		new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
</script>

{#if overview}
	<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
		{#if overview.cards.acquisition}
			{@const acq = overview.cards.acquisition}
			<div
				class="group rounded-xl border border-border-subtle bg-surface-1 p-4 shadow-[var(--shadow-1)] transition-colors hover:border-border-strong md:col-span-2"
			>
				<div class="flex items-baseline justify-between">
					<p class="text-sm font-semibold text-text-primary">Acquisition</p>
					<p class="text-[11px] text-text-faint">Sonarr + Radarr</p>
				</div>
				<div class="mt-3 grid grid-cols-4 gap-3">
					<div>
						<p class="text-[10px] uppercase tracking-wide text-text-faint">Active</p>
						<p class="text-xl font-semibold text-text-primary tabular-nums">{acq.active}</p>
					</div>
					<div>
						<p class="text-[10px] uppercase tracking-wide text-text-faint">Queued</p>
						<p class="text-xl font-semibold text-text-primary tabular-nums">{acq.queued}</p>
					</div>
					<div>
						<p class="text-[10px] uppercase tracking-wide text-text-faint">Import issues</p>
						<p
							class="text-xl font-semibold tabular-nums {acq.importIssues > 0
								? 'text-degraded'
								: 'text-text-primary'}"
						>
							{acq.importIssues}
						</p>
					</div>
					<div>
						<p class="text-[10px] uppercase tracking-wide text-text-faint">Wanted</p>
						<p class="text-xl font-semibold text-text-primary tabular-nums">{acq.wanted}</p>
					</div>
				</div>
			</div>
		{/if}

		{#if overview.cards.media}
			{@const m = overview.cards.media}
			<div
				class="rounded-xl border border-border-subtle bg-surface-1 p-4 shadow-[var(--shadow-1)] transition-colors hover:border-border-strong"
			>
				<p class="text-sm font-semibold text-text-primary">Plex</p>
				<p class="mt-3 text-2xl font-semibold text-text-primary tabular-nums">
					{m.active}
					<span class="text-sm font-normal text-text-muted"
						>active stream{m.active === 1 ? '' : 's'}</span
					>
				</p>
				<p class="mt-1 text-[11px] text-text-muted">
					{m.directPlay} direct play · {m.transcode} transcode
				</p>
			</div>
		{/if}

		{#if overview.cards.indexers}
			{@const ix = overview.cards.indexers}
			<div
				class="rounded-xl border border-border-subtle bg-surface-1 p-4 shadow-[var(--shadow-1)] transition-colors hover:border-border-strong"
			>
				<p class="text-sm font-semibold text-text-primary">Indexers</p>
				<p
					class="mt-3 text-2xl font-semibold tabular-nums {ix.failed > 0
						? 'text-degraded'
						: 'text-healthy'}"
				>
					{ix.healthy}
					<span class="text-sm font-normal text-text-muted">healthy</span>
				</p>
				<p class="mt-1 text-[11px] text-text-muted">
					{ix.failed} failed · {ix.warnings} warning{ix.warnings === 1 ? '' : 's'}
				</p>
			</div>
		{/if}

		{#if overview.cards.requests}
			{@const r = overview.cards.requests}
			<div
				class="rounded-xl border border-border-subtle bg-surface-1 p-4 shadow-[var(--shadow-1)] transition-colors hover:border-border-strong"
			>
				<p class="text-sm font-semibold text-text-primary">Requests</p>
				<p class="mt-3 text-2xl font-semibold text-text-primary tabular-nums">
					{r.pending} <span class="text-sm font-normal text-text-muted">pending</span>
				</p>
				<p class="mt-1 text-[11px] text-text-muted">{r.approved} approved · {r.total} total</p>
			</div>
		{/if}

		{#if overview.recent.length > 0}
			<div
				class="rounded-xl border border-border-subtle bg-surface-1 p-4 shadow-[var(--shadow-1)] md:col-span-2"
			>
				<p class="text-sm font-semibold text-text-primary">Recent activity</p>
				<ul class="mt-2 space-y-1.5">
					{#each overview.recent as event (event.id)}
						<li class="flex items-baseline gap-2 text-xs">
							<span class="shrink-0 tabular-nums text-text-faint">{timeLabel(event.at)}</span>
							<span class="shrink-0 font-medium capitalize text-text-secondary"
								>{event.source.split('-')[0]}</span
							>
							<span class="truncate text-text-muted">{event.title}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</div>
{/if}
