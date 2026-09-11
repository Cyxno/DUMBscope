<script lang="ts">
	/**
	 * Overview mini pipeline: stage-level health as a compact summary flow.
	 * Desktop reads left-to-right with arrows; small screens stack vertically.
	 * Never a scaled-down topology — this is a projection of the same
	 * PipelineViewModel the full Pipeline page uses.
	 */
	import { ArrowRight } from '@lucide/svelte';
	import { live } from '$lib/stores/live.svelte';
	import { pipelineModelFromLive, pipelineDemoFromUrl } from '$lib/pipeline/from-live';
	import { page } from '$app/state';

	const model = $derived(pipelineModelFromLive(pipelineDemoFromUrl(page.url)));
	const runningCount = $derived(live.overview.servicesOnline);

	function chipClass(status: string | null): string {
		switch (status) {
			case 'critical':
				return 'text-critical';
			case 'degraded':
			case 'affected':
				return 'text-degraded';
			case 'stale':
			case 'offline':
			case 'running':
				return 'text-text-muted';
			default:
				return 'text-healthy';
		}
	}

	function glyph(status: string | null): string {
		switch (status) {
			case 'critical':
				return '✕';
			case 'degraded':
			case 'affected':
				return '!';
			case 'stale':
				return '~';
			default:
				return '✓';
		}
	}
</script>

{#if model.stages.length === 0}
	<p class="py-4 text-center text-xs text-text-muted">
		{live.feed === 'live'
			? 'No services discovered yet.'
			: 'The pipeline appears once the DUMB connection is live.'}
	</p>
{:else}
	<nav aria-label="Pipeline stage status">
		<ol
			class="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-2 sm:gap-y-2"
		>
			{#each model.stages as stage, i (stage.id)}
				<li class="flex items-center gap-2 sm:gap-x-2">
					<a
						href="/pipeline"
						class="group flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-surface-2"
					>
						<span class="text-[13px] font-semibold {chipClass(stage.status)}"
							>{glyph(stage.status)}</span
						>
						<span class="text-[13px] font-medium text-text-primary">{stage.label}</span>
						{#if stage.affected}
							<span class="text-[11px] text-degraded">affected</span>
						{/if}
					</a>
					{#if i < model.stages.length - 1}
						<ArrowRight size={13} class="hidden text-text-faint sm:inline" aria-hidden="true" />
					{/if}
				</li>
			{/each}
		</ol>
	</nav>
	<p class="mt-3 text-[11.5px] text-text-muted">
		{#if model.stale}
			Showing last known state · reconnecting…
		{:else if model.rootCause}
			{model.rootCause.name} is unavailable ·
			<a href="/incidents" class="text-accent-text hover:underline">View incident</a>
		{:else}
			{runningCount} services online · no incidents
		{/if}
	</p>
{/if}
