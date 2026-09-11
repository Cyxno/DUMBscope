<script lang="ts">
	import { live } from '$lib/stores/live.svelte';
	import Drawer from './Drawer.svelte';
	import ServiceIcon from './ServiceIcon.svelte';
	import HealthBadge from './HealthBadge.svelte';
	import Sparkline from './Sparkline.svelte';
	import IntegrationPanel from './IntegrationPanel.svelte';
	import { formatPercent, formatBytes, relativeTime, formatDateTime } from '$lib/utils/format';
	import { integrationRegistrySafeSummary } from '$lib/utils/summary';
	import { pipelineModelFromLive, pipelineMetaForKey } from '$lib/pipeline/from-live';
	import { ExternalLink, RotateCw } from '@lucide/svelte';

	let { serviceKey, onclose }: { serviceKey: string | null; onclose: () => void } = $props();

	const service = $derived(serviceKey ? live.serviceByKey(serviceKey) : undefined);
	const discovered = $derived(
		serviceKey ? live.discovered.find((d) => d.key === serviceKey) : undefined
	);
	const summary = $derived(
		service && discovered ? integrationRegistrySafeSummary(discovered, service) : {}
	);
	const cpuSeries = $derived(serviceKey ? live.serviceCpuSeries(serviceKey) : []);
	// Canonical pipeline identity: same name/descriptor as Pipeline & Services.
	const pipelineMeta = $derived(
		serviceKey ? pipelineMetaForKey(pipelineModelFromLive(), serviceKey) : null
	);

	const uptimeLabel = $derived.by(() => {
		if (!service?.restart?.lastRestartTime && service?.runState !== 'running') return '—';
		if (!service) return '—';
		// DUMB does not expose process start time directly; last restart is the
		// closest observed fact.
		return service.restart?.lastRestartTime
			? `since ${relativeTime(service.restart.lastRestartTime)}`
			: 'no restarts observed';
	});
</script>

<Drawer
	open={serviceKey !== null}
	title={pipelineMeta?.name ?? service?.name ?? 'Service'}
	subtitle={service
		? [pipelineMeta?.descriptor, `Process: ${service.processName}`].filter(Boolean).join(' · ')
		: undefined}
	{onclose}
>
	{#if service}
		<div class="space-y-5">
			<div class="flex items-center gap-3">
				<ServiceIcon {service} size={44} />
				<div>
					<HealthBadge health={service.health} />
					<p class="mt-1.5 text-xs text-text-muted">
						{#if service.healthReason}
							{service.healthReason}
						{:else}
							{uptimeLabel}
						{/if}
					</p>
				</div>
			</div>

			{#if service.healthDetails}
				<div class="rounded-xl border border-border-subtle bg-surface-2 p-3 text-xs">
					<p class="mb-1.5 font-semibold text-text-secondary">Health probe</p>
					<p class="text-text-muted">
						{service.healthDetails.probe ?? 'probe'}
						{#if service.healthDetails.httpStatus !== undefined}
							· HTTP {service.healthDetails.httpStatus}
						{/if}
						{#if service.healthDetails.reportedStatus}
							· reports “{service.healthDetails.reportedStatus}”
						{/if}
						{#if service.healthDetails.latencyMs != null}
							· {service.healthDetails.latencyMs} ms
						{/if}
					</p>
				</div>
			{/if}

			<dl class="grid grid-cols-2 gap-3">
				<div class="rounded-xl border border-border-subtle bg-surface-2 p-3">
					<dt class="text-[11px] text-text-faint">Status</dt>
					<dd class="mt-0.5 text-sm font-medium capitalize text-text-primary">
						{service.runState}
					</dd>
				</div>
				<div class="rounded-xl border border-border-subtle bg-surface-2 p-3">
					<dt class="text-[11px] text-text-faint">CPU</dt>
					<dd class="tnum mt-0.5 text-sm font-medium text-text-primary">
						{formatPercent(service.cpuPercent)}
					</dd>
				</div>
				<div class="rounded-xl border border-border-subtle bg-surface-2 p-3">
					<dt class="text-[11px] text-text-faint">Memory</dt>
					<dd class="tnum mt-0.5 text-sm font-medium text-text-primary">
						{formatBytes(service.memoryBytes)}
					</dd>
				</div>
				<div class="rounded-xl border border-border-subtle bg-surface-2 p-3">
					<dt class="text-[11px] text-text-faint">PID</dt>
					<dd class="tnum mt-0.5 text-sm font-medium text-text-primary">{service.pid ?? '—'}</dd>
				</div>
			</dl>

			{#if cpuSeries.length > 2}
				<div>
					<p class="mb-1 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
						CPU trend
					</p>
					<Sparkline data={cpuSeries} height={48} />
				</div>
			{/if}

			{#if service.restart}
				<div class="rounded-xl border border-border-subtle bg-surface-2 p-3.5">
					<p class="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
						<RotateCw size={13} aria-hidden="true" />
						Auto-restart
					</p>
					<dl class="grid grid-cols-3 gap-2 text-center text-xs">
						<div>
							<dt class="text-text-faint">Attempts</dt>
							<dd class="tnum mt-0.5 text-sm font-semibold">{service.restart.attempts}</dd>
						</div>
						<div>
							<dt class="text-text-faint">Successes</dt>
							<dd class="tnum mt-0.5 text-sm font-semibold text-healthy">
								{service.restart.successes}
							</dd>
						</div>
						<div>
							<dt class="text-text-faint">Failures</dt>
							<dd
								class="tnum mt-0.5 text-sm font-semibold {service.restart.failures > 0
									? 'text-critical'
									: ''}"
							>
								{service.restart.failures}
							</dd>
						</div>
					</dl>
					{#if service.restart.lastFailureReason}
						<p class="mt-2.5 border-t border-border-subtle pt-2 text-[11px] text-degraded">
							Last failure: {service.restart.lastFailureReason}
						</p>
					{/if}
					{#if service.restart.lastRestartTime}
						<p class="mt-1 text-[11px] text-text-faint">
							Last restart: {formatDateTime(service.restart.lastRestartTime)}
						</p>
					{/if}
				</div>
			{/if}

			{#if Object.keys(summary).length > 0}
				<div>
					<p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
						Details
					</p>
					<dl class="space-y-1.5 text-xs">
						{#each Object.entries(summary) as [label, value] (label)}
							<div class="flex items-baseline justify-between gap-3">
								<dt class="shrink-0 text-text-muted">{label}</dt>
								<dd class="truncate text-right font-medium text-text-secondary">
									{#if value.startsWith('http')}
										<a
											href={value}
											target="_blank"
											rel="noreferrer noopener"
											class="inline-flex items-center gap-1 text-accent-text hover:underline"
										>
											Project <ExternalLink size={11} aria-hidden="true" />
										</a>
									{:else}
										{value}
									{/if}
								</dd>
							</div>
						{/each}
					</dl>
				</div>
			{/if}

			<IntegrationPanel serviceKey={service.key} />

			<p class="text-[11px] text-text-faint">
				Last observed {relativeTime(service.observedAt)} · version {discovered?.version ??
					'unknown'}
			</p>
		</div>
	{:else}
		<div class="flex h-40 items-center justify-center text-sm text-text-muted">
			{#if live.services.length === 0}
				{live.connection.state === 'live'
					? 'No services discovered yet.'
					: 'Waiting for DUMB connection…'}
			{:else}
				This service is no longer running.
			{/if}
		</div>
	{/if}
</Drawer>
