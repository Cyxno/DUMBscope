<script lang="ts">
	/**
	 * The operational media pipeline. One PipelineViewModel, two renderers:
	 * a deterministic staged flow on desktop (read left to right) and a
	 * vertical timeline below the `lg` breakpoint. Infrastructure is hidden
	 * by default; `Detailed` reveals never-running entries and platform
	 * processes. ?demo=failure / ?demo=stale allow QA to render incident and
	 * disconnect stories read-only.
	 */
	import { live } from '$lib/stores/live.svelte';
	import { pipelineModelFromLive, pipelineDemoFromUrl } from '$lib/pipeline/from-live';
	import { page } from '$app/state';
	import DesktopPipeline from './DesktopPipeline.svelte';
	import MobilePipeline from './MobilePipeline.svelte';
	import PipelineBanner from './PipelineBanner.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { relativeTime } from '$lib/utils/format';
	import { CONNECTION_LABELS } from '$lib/utils/status';

	let {
		selectedKey = null,
		metrics = null,
		onselect
	}: {
		/** Selected service key — owned by the page so a drawer close clears it. */
		selectedKey?: string | null;
		/** Optional per-type library metrics (§84), keyed by integration type. */
		metrics?: Record<string, string> | null;
		onselect?: (key: string) => void;
	} = $props();

	let detailed = $state(false);
	const demo = $derived(pipelineDemoFromUrl(page.url));
	const model = $derived(pipelineModelFromLive(demo));

	// Same count the hero uses (DUMB's managed registry) — one vocabulary.
	const runningCount = $derived(live.overview.servicesOnline);
	const hiddenCount = $derived(
		model.infrastructure.length + model.stages.reduce((n, s) => n + s.notRunning.length, 0)
	);
</script>

<div>
	<div class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
		<span
			class="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-[0.08em] text-accent"
		>
			<span
				class="size-1.5 rounded-full {live.feed === 'live' ? 'bg-accent' : 'bg-unknown'}"
				aria-hidden="true"
			></span>
			{CONNECTION_LABELS[live.feed] ?? live.feed.toUpperCase()}
		</span>
		<span class="text-xs text-text-muted">
			{#if model.stale}
				Last known state{live.connection.lastUpdateAt
					? ` · updated ${relativeTime(live.connection.lastUpdateAt)}`
					: ''}
			{:else if model.rootCause}
				1 incident affecting {model.rootCause.stage}
			{:else}
				{runningCount} services online · no incidents
			{/if}
		</span>
		<div class="ml-auto flex overflow-hidden rounded-lg border border-border-subtle text-[11.5px]">
			<button
				type="button"
				class="px-3 py-1.5 transition-colors {!detailed
					? 'bg-surface-3 font-semibold text-text-primary'
					: 'text-text-muted hover:text-text-secondary'}"
				onclick={() => (detailed = false)}
				aria-pressed={!detailed}
			>
				Simple
			</button>
			<button
				type="button"
				class="px-3 py-1.5 transition-colors {detailed
					? 'bg-surface-3 font-semibold text-text-primary'
					: 'text-text-muted hover:text-text-secondary'}"
				onclick={() => (detailed = true)}
				aria-pressed={detailed}
			>
				Detailed
			</button>
		</div>
	</div>

	<PipelineBanner {model} />

	{#if model.stages.length === 0}
		<div class="py-6">
			<EmptyState
				title={live.feed === 'live' ? 'Nothing to map yet' : 'Connecting to DUMB…'}
				description="As soon as services are discovered the pipeline builds itself here."
				neutral
			/>
		</div>
	{:else}
		<div class="hidden lg:block" data-testid="desktop-pipeline">
			<DesktopPipeline {model} {detailed} {selectedKey} {metrics} {onselect} />
		</div>
		<div class="lg:hidden" data-testid="mobile-pipeline">
			<MobilePipeline {model} {detailed} {selectedKey} {metrics} {onselect} />
		</div>
		{#if !detailed && hiddenCount > 0}
			<div class="mt-5 flex items-center gap-2">
				<button
					type="button"
					class="text-[11.5px] text-text-faint transition-colors hover:text-text-secondary"
					onclick={() => (detailed = true)}
				>
					{hiddenCount} infrastructure processes hidden · Show
				</button>
			</div>
		{/if}
	{/if}
</div>
