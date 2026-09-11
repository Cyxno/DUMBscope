<script lang="ts">
	import {
		pipelineStatusLabel,
		type PipelineService,
		type PipelineStatus
	} from '$lib/pipeline/model';

	let {
		service,
		selected = false,
		dimmed = false,
		metric = null,
		onselect
	}: {
		service: PipelineService;
		selected?: boolean;
		dimmed?: boolean;
		/** One relevant library metric ("26 missing") when deep data exists (§84). */
		metric?: string | null;
		onselect?: (key: string) => void;
	} = $props();

	function dotClass(status: PipelineStatus): string {
		switch (status) {
			case 'healthy':
				return 'bg-healthy';
			case 'running':
				return 'bg-unknown';
			case 'degraded':
			case 'affected':
				return 'bg-degraded';
			case 'critical':
				return 'bg-critical';
			case 'offline':
				return 'bg-unknown opacity-50';
			case 'stale':
				return 'bg-unknown opacity-40';
		}
	}

	function accentClass(status: PipelineStatus): string {
		switch (status) {
			case 'critical':
				return 'border-critical/50 bg-critical-soft';
			case 'affected':
				return 'border-degraded/40';
			default:
				return 'border-border-subtle';
		}
	}

	const subtitle = $derived(
		service.instanceLabel ? `${service.instanceLabel} · ${service.descriptor}` : service.descriptor
	);
	// Instance label included so multi-instance cards stay distinguishable
	// for assistive tech (and unique in accessible-name queries).
	const accessibleName = $derived(
		service.instanceLabel
			? `${service.name} ${service.instanceLabel}: ${pipelineStatusLabel(service.status)}`
			: `${service.name}: ${pipelineStatusLabel(service.status)}`
	);
</script>

<button
	type="button"
	class="pipeline-card w-full rounded-xl border px-3 py-2.5 text-left transition-colors duration-150 focus-visible:border-accent focus-visible:outline-none {accentClass(
		service.status
	)} {selected ? 'border-accent ring-1 ring-accent' : ''} {dimmed ? 'opacity-45' : ''}"
	class:hover:border-border-strong={!selected && service.status !== 'critical'}
	onclick={() => onselect?.(service.key)}
	aria-label={accessibleName}
	aria-pressed={selected}
>
	<span class="flex items-start gap-2.5">
		<span class="mt-[6px] size-1.5 shrink-0 rounded-full {dotClass(service.status)}"
			><span class="sr-only">{pipelineStatusLabel(service.status)}</span></span
		>
		<span class="min-w-0 flex-1">
			<span class="block text-[13px] leading-snug font-semibold break-words text-text-primary"
				>{service.name}</span
			>
			<span class="block text-[11px] leading-snug text-text-muted">{subtitle}</span>
			{#if metric}
				<span class="mt-0.5 block text-[11px] leading-snug font-medium text-accent-text"
					>{metric}</span
				>
			{/if}
		</span>
		{#if service.status !== 'healthy'}
			<span
				class="max-w-[74px] shrink-0 pt-0.5 text-right text-[10.5px] leading-tight font-medium {service.status ===
				'critical'
					? 'text-critical'
					: service.status === 'affected' || service.status === 'degraded'
						? 'text-degraded'
						: 'text-text-faint'}">{pipelineStatusLabel(service.status)}</span
			>
		{/if}
	</span>
</button>
