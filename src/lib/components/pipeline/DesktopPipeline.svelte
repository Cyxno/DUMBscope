<script lang="ts">
	import PipelineStage from './PipelineStage.svelte';
	import PipelineConnections from './PipelineConnections.svelte';
	import type { PipelineModel } from '$lib/pipeline/model';

	let {
		model,
		detailed = false,
		selectedKey = null,
		onselect
	}: {
		model: PipelineModel;
		detailed?: boolean;
		selectedKey?: string | null;
		onselect?: (key: string) => void;
	} = $props();

	function connectionAfter(stageId: string) {
		return model.connections.find((c) => c.from === stageId)?.status ?? 'flowing';
	}
</script>

<div class="flex items-stretch overflow-x-auto pb-1">
	{#each model.stages as stage, i (stage.id)}
		<div class="min-w-[180px] max-w-[240px] flex-1">
			<PipelineStage {stage} {detailed} {selectedKey} {onselect} />
		</div>
		{#if i < model.stages.length - 1}
			<PipelineConnections status={connectionAfter(stage.id)} />
		{/if}
	{/each}
</div>

{#if model.supporting}
	<div class="mt-5 border-t border-border-subtle pt-4">
		<PipelineStage stage={model.supporting} cardRow {detailed} {selectedKey} {onselect} />
	</div>
{/if}

{#if detailed && model.infrastructure.length > 0}
	<div class="mt-5 border-t border-border-subtle pt-4">
		<h4 class="mb-2.5 text-[10px] font-bold tracking-[0.1em] uppercase text-text-faint">
			Infrastructure
		</h4>
		<div class="flex flex-wrap gap-2">
			{#each model.infrastructure as service (service.key)}
				<span
					class="rounded-lg border border-border-subtle bg-surface-1 px-2.5 py-1.5 text-[11.5px] text-text-muted"
				>
					{service.name}<span class="text-text-faint"> · {service.descriptor}</span>
				</span>
			{/each}
		</div>
	</div>
{/if}
