<script lang="ts">
	import PipelineServiceCard from './PipelineServiceCard.svelte';
	import { type PipelineStage, type PipelineStatus } from '$lib/pipeline/model';

	let {
		stage,
		detailed = false,
		cardRow = false,
		selectedKey = null,
		metricFor = null,
		onselect
	}: {
		stage: PipelineStage;
		detailed?: boolean;
		/** Render cards in a fixed-width wrap row (supporting strip) instead of a stack. */
		cardRow?: boolean;
		selectedKey?: string | null;
		metricFor?: ((key: string) => string | null) | null;
		onselect?: (key: string) => void;
	} = $props();

	function stageDotClass(status: PipelineStatus | null): string {
		switch (status) {
			case 'critical':
				return 'bg-critical';
			case 'degraded':
			case 'affected':
				return 'bg-degraded';
			case 'offline':
				return 'bg-unknown opacity-60';
			case 'stale':
				return 'bg-unknown opacity-40';
			case 'running':
				return 'bg-unknown';
			default:
				return 'bg-healthy';
		}
	}
</script>

<section aria-label="{stage.label} stage">
	<div class="mb-1 flex items-center gap-1.5">
		<span class="size-1.5 rounded-full {stageDotClass(stage.status)}" aria-hidden="true"></span>
		<h4 class="text-[10px] font-bold tracking-[0.1em] uppercase text-text-faint">{stage.label}</h4>
		{#if stage.affected}
			<span class="text-[10px] font-medium text-degraded">may be affected</span>
		{/if}
	</div>
	<p class="mb-2.5 text-[11px] text-text-faint">{stage.description}</p>

	<div class={cardRow ? 'flex flex-row flex-wrap gap-2' : 'flex flex-col gap-2'}>
		{#each stage.services as service (service.key)}
			<div class={cardRow ? 'w-[220px]' : 'min-w-0'}>
				<PipelineServiceCard
					{service}
					selected={selectedKey === service.key}
					metric={metricFor?.(service.key) ?? null}
					{onselect}
				/>
			</div>
		{/each}
		{#if detailed}
			{#each stage.notRunning as service (service.key)}
				<div class={cardRow ? 'w-[220px]' : 'min-w-0'}>
					<PipelineServiceCard {service} dimmed {onselect} />
				</div>
			{/each}
		{/if}
	</div>

	{#if stage.notRunning.length > 0 && !detailed}
		<p class="mt-1.5 px-0.5 text-[10.5px] text-text-faint">
			+ {stage.notRunning.length} configured but not running
		</p>
	{/if}
</section>
