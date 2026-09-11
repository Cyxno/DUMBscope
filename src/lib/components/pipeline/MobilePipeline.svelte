<script lang="ts">
	import PipelineServiceCard from './PipelineServiceCard.svelte';
	import { type PipelineModel, type PipelineStatus } from '$lib/pipeline/model';

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

	function pointClass(status: PipelineStatus | null): string {
		switch (status) {
			case 'critical':
				return 'border-critical';
			case 'degraded':
			case 'affected':
				return 'border-degraded';
			case 'stale':
				return 'border-unknown opacity-40';
			case 'running':
			case 'offline':
				return 'border-unknown';
			default:
				return 'border-healthy';
		}
	}

	function connectionAfter(stageId: string) {
		return model.connections.find((c) => c.from === stageId)?.status ?? 'flowing';
	}
</script>

<div class="timeline">
	{#each model.stages as stage (stage.id)}
		<section class="seg" aria-label="{stage.label} stage">
			<span class="pt {pointClass(stage.status)}" aria-hidden="true"></span>
			{#if connectionAfter(stage.id) === 'broken'}
				<span class="brk" aria-hidden="true"></span>
			{/if}
			<div class="flex items-center gap-2">
				<h4 class="text-[12.5px] font-bold tracking-[0.06em] uppercase text-text-secondary">
					{stage.label}
				</h4>
				{#if stage.affected}
					<span class="text-[10px] font-medium text-degraded">may be affected</span>
				{/if}
			</div>
			<p class="mb-2.5 text-[11px] text-text-faint">{stage.description}</p>
			<div class="flex flex-col gap-2">
				{#each stage.services as service (service.key)}
					<PipelineServiceCard {service} selected={selectedKey === service.key} {onselect} />
				{/each}
				{#if detailed}
					{#each stage.notRunning as service (service.key)}
						<PipelineServiceCard {service} dimmed {onselect} />
					{/each}
				{/if}
			</div>
			{#if stage.notRunning.length > 0 && !detailed}
				<p class="mt-1.5 text-[10.5px] text-text-faint">
					+ {stage.notRunning.length} configured but not running
				</p>
			{/if}
		</section>
	{/each}
</div>

{#if model.supporting}
	<section class="mt-2 border-t border-border-subtle pt-4" aria-label="Supporting services">
		<h4 class="text-[12.5px] font-bold tracking-[0.06em] uppercase text-text-secondary">
			{model.supporting.label}
		</h4>
		<div class="mt-2.5 flex flex-col gap-2">
			{#each model.supporting.services as service (service.key)}
				<PipelineServiceCard {service} selected={selectedKey === service.key} {onselect} />
			{/each}
		</div>
	</section>
{/if}

{#if detailed && model.infrastructure.length > 0}
	<section class="mt-4 border-t border-border-subtle pt-4" aria-label="Infrastructure">
		<h4 class="text-[12.5px] font-bold tracking-[0.06em] uppercase text-text-secondary">
			Infrastructure
		</h4>
		<ul class="mt-2.5 flex flex-wrap gap-2">
			{#each model.infrastructure as service (service.key)}
				<li
					class="rounded-lg border border-border-subtle bg-surface-1 px-2.5 py-1.5 text-[11.5px] text-text-muted"
				>
					{service.name}<span class="text-text-faint"> · {service.descriptor}</span>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.timeline {
		position: relative;
		padding-left: 26px;
	}
	.timeline::before {
		content: '';
		position: absolute;
		left: 7px;
		top: 6px;
		bottom: 6px;
		width: 2px;
		border-radius: 2px;
		background: var(--border-subtle);
	}
	.seg {
		position: relative;
		padding-bottom: 24px;
	}
	.seg:last-child {
		padding-bottom: 4px;
	}
	.pt {
		position: absolute;
		left: -25px;
		top: 3px;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		background: var(--bg);
		border: 2.5px solid var(--healthy);
	}
	.brk {
		position: absolute;
		left: -31px;
		bottom: 12px;
		width: 14px;
		height: 14px;
		background: var(--bg);
	}
	.brk::before,
	.brk::after {
		content: '';
		position: absolute;
		left: 50%;
		top: 50%;
		width: 13px;
		height: 2.5px;
		background: var(--critical);
		border-radius: 1px;
	}
	.brk::before {
		transform: translate(-50%, -50%) rotate(45deg);
	}
	.brk::after {
		transform: translate(-50%, -50%) rotate(-45deg);
	}
	@media (prefers-reduced-motion: no-preference) {
		.seg {
			transition: padding 150ms var(--ease-out);
		}
	}
</style>
