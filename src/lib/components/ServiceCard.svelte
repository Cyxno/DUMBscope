<script lang="ts">
	import type { ServiceStatus } from '$lib/types';
	import ServiceIcon from './ServiceIcon.svelte';
	import HealthBadge from './HealthBadge.svelte';
	import Sparkline from './Sparkline.svelte';
	import StatusDot from './StatusDot.svelte';
	import { formatPercent, formatBytes } from '$lib/utils/format';
	import { live } from '$lib/stores/live.svelte';

	let {
		service,
		onopen,
		displayName = null,
		descriptor = null
	}: {
		service: ServiceStatus;
		onopen: (key: string) => void;
		/** Canonical user-facing name from the pipeline viewmodel, if available. */
		displayName?: string | null;
		/** Short description from the pipeline viewmodel ("TV automation"). */
		descriptor?: string | null;
	} = $props();

	const cpuSeries = $derived(live.serviceCpuSeries(service.key));
	const title = $derived(displayName ?? service.name);
</script>

<button
	type="button"
	class="group relative w-full overflow-hidden rounded-[14px] border border-border-subtle bg-surface-1 p-4 text-left shadow-[var(--shadow-1)] transition-all duration-200
		hover:-translate-y-0.5 hover:border-border-strong hover:shadow-[var(--shadow-2)]"
	onclick={() => onopen(service.key)}
	aria-label="{title}: {service.health}"
>
	<div class="flex items-start gap-3">
		<ServiceIcon {service} />
		<div class="min-w-0 flex-1">
			<div class="flex items-center gap-1.5">
				<p class="text-sm font-semibold break-words text-text-primary">{title}</p>
			</div>
			{#if descriptor}
				<p class="mt-0.5 text-[11px] text-text-muted">{descriptor}</p>
			{/if}
			<div class="mt-1 flex items-center gap-2">
				<HealthBadge health={service.health} size="sm" />
				{#if service.runState === 'stopped'}
					<span class="text-[11px] text-text-muted">Stopped</span>
				{:else if service.runState === 'starting'}
					<span class="text-[11px] text-degraded">Starting</span>
				{/if}
			</div>
		</div>
		<StatusDot health={service.health} pulse />
	</div>

	<dl class="mt-3.5 grid grid-cols-3 gap-2 text-[11px]">
		<div>
			<dt class="text-text-faint">CPU</dt>
			<dd class="tnum text-[13px] font-medium text-text-secondary">
				{formatPercent(service.cpuPercent)}
			</dd>
		</div>
		<div>
			<dt class="text-text-faint">RAM</dt>
			<dd class="tnum text-[13px] font-medium text-text-secondary">
				{formatBytes(service.memoryBytes)}
			</dd>
		</div>
		<div>
			<dt class="text-text-faint">Restarts</dt>
			<dd
				class="tnum text-[13px] font-medium {service.restart && service.restart.failures > 0
					? 'text-degraded'
					: 'text-text-secondary'}"
			>
				{service.restart?.failures ?? 0}
			</dd>
		</div>
	</dl>

	<div class="mt-2 -mb-1 opacity-80 transition-opacity group-hover:opacity-100">
		<Sparkline
			data={cpuSeries}
			height={26}
			color={service.health === 'unhealthy' ? 'var(--critical)' : 'var(--accent)'}
		/>
	</div>

	<span
		class="pointer-events-none absolute inset-0 rounded-[14px] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
		style="background: radial-gradient(320px circle at var(--x, 50%) var(--y, 0%), color-mix(in srgb, var(--accent) 6%, transparent), transparent 60%);"
		aria-hidden="true"
	></span>
</button>
