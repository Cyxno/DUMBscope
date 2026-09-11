<script lang="ts">
	/**
	 * Root-cause banner above the pipeline: only rendered when incident
	 * correlation (or a QA demo override) identifies an interrupted flow.
	 */
	import { pipelineStageLabel, type PipelineModel } from '$lib/pipeline/model';

	let { model }: { model: PipelineModel } = $props();

	const stageLabel = $derived(model.rootCause ? pipelineStageLabel(model.rootCause.stage) : '');
	const affectedNames = $derived.by(() => {
		const names = new Set<string>();
		for (const stage of model.stages) {
			if (!stage.affected) continue;
			for (const service of stage.services) names.add(service.name);
		}
		return [...names];
	});
</script>

{#if model.rootCause && !model.stale}
	<div
		class="flex items-start gap-3 rounded-[14px] border px-4 py-3"
		style="border-color: color-mix(in srgb, var(--critical) 35%, transparent); background: var(--critical-soft)"
		role="status"
	>
		<span
			class="mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full bg-critical text-[11px] font-bold text-white"
			aria-hidden="true">!</span
		>
		<div class="min-w-0 flex-1">
			<p class="text-[13.5px] font-semibold text-text-primary">
				Pipeline interrupted at {stageLabel}
			</p>
			<p class="mt-0.5 text-[12.5px] text-text-muted">
				{model.rootCause.name} is unavailable
				{#if affectedNames.length > 0}
					· {affectedNames.join(', ')} may be affected
				{/if}
			</p>
		</div>
		<a
			href="/incidents"
			class="shrink-0 self-center rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors"
			style="border-color: color-mix(in srgb, var(--critical) 40%, transparent); color: var(--accent-text);"
		>
			View incident →
		</a>
	</div>
{/if}
