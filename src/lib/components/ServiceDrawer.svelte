<script lang="ts">
	import { live } from '$lib/stores/live.svelte';
	import Drawer from './Drawer.svelte';
	import ServiceIcon from './ServiceIcon.svelte';
	import HealthBadge from './HealthBadge.svelte';
	import Sparkline from './Sparkline.svelte';
	import IntegrationPanel from './IntegrationPanel.svelte';
	import {
		formatPercent,
		formatBytes,
		relativeTime,
		formatDateTime,
		formatDuration
	} from '$lib/utils/format';
	import { integrationRegistrySafeSummary } from '$lib/utils/summary';
	import { pipelineModelFromLive, pipelineMetaForKey } from '$lib/pipeline/from-live';
	import {
		loadIntegrations,
		loadLinkSettings,
		type IntegrationRef
	} from '$lib/utils/actions-client';
	import { resolveWebUrl } from '$lib/utils/service-links';
	import { matchCatalog } from '$lib/shared/catalog';
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
		if (!service) return '—';
		// Honest process uptime straight from DUMB's start_time when the gateway
		// provides it (metrics payload); fall back to the last observed restart.
		const proc = live.metrics?.processes.find((p) => p.name === service.processName);
		if (proc?.startedAtSeconds) {
			return `up ${formatDuration(Math.max(0, Date.now() - proc.startedAtSeconds * 1000))}`;
		}
		if (!service.restart?.lastRestartTime && service.runState !== 'running') return '—';
		return service.restart?.lastRestartTime
			? `since ${relativeTime(service.restart.lastRestartTime)}`
			: 'no restarts observed';
	});

	// Deep memory observability for this service (classification + baseline),
	// when the Observability pipeline has enough history.
	const memoryObs = $derived(
		serviceKey ? live.observability?.services.find((s) => s.key === serviceKey) : undefined
	);

	// --- Safe Actions (docs/ACTIONS.md §2/§3): Open service + Restart service.
	let integration = $state<IntegrationRef | null>(null);
	let linkPreference = $state<'auto' | 'internal' | 'public'>('auto');

	$effect(() => {
		void serviceKey;
		integration = null;
		if (!serviceKey) return;
		const entry = matchCatalog(serviceKey, serviceKey);
		const catalogId = entry?.id ?? serviceKey;
		void loadIntegrations().then((list) => {
			integration =
				list.find((i) => i.enabled && (i.type === catalogId || i.id.startsWith(catalogId))) ?? null;
		});
		void loadLinkSettings().then((s) => {
			linkPreference = s.linkOpenPreference;
		});
	});

	const openUrl = $derived.by(() => {
		if (!integration) return null;
		return resolveWebUrl(
			{ url: integration.url, publicUrl: integration.publicUrl },
			linkPreference,
			typeof location !== 'undefined' ? location.host : ''
		);
	});

	// Restart rides the existing remediation layer (allowlist, preflight, 6 h
	// cooldown, audit, verification) — no second execution path (§3).
	let confirmRestart = $state(false);
	let restartBusy = $state(false);
	let restartMessage = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	const displayName = $derived(pipelineMeta?.name ?? service?.name ?? serviceKey ?? 'Service');
	const restartable = $derived(Boolean(discovered) && service?.runState === 'running');

	async function requestRestart(): Promise<void> {
		if (!service) return;
		restartBusy = true;
		restartMessage = null;
		try {
			const res = await fetch('/api/reliability/actions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ target: service.processName })
			});
			const data = (await res.json()) as { error?: string };
			if (res.ok) {
				restartMessage = {
					kind: 'ok',
					text: `Restart accepted for ${displayName} — DUMBscope will verify recovery.`
				};
			} else {
				restartMessage = { kind: 'error', text: data.error ?? 'Restart was rejected.' };
			}
		} catch {
			restartMessage = { kind: 'error', text: 'Could not reach DUMBscope.' };
		} finally {
			restartBusy = false;
			confirmRestart = false;
		}
	}
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

			<!-- Safe Actions (§2/§3/§10): open the service's own web UI, or
				     restart it through DUMB's official route. Capability-gated. -->
			{#if openUrl || discovered}
				<div class="flex flex-wrap items-center gap-2">
					{#if openUrl}
						<a
							href={openUrl}
							target="_blank"
							rel="noreferrer noopener"
							class="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[11.5px] font-medium text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary"
							aria-label="Open {displayName}"
						>
							<ExternalLink size={12} aria-hidden="true" />
							Open {displayName}
						</a>
					{/if}
					{#if discovered}
						<button
							type="button"
							class="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[11.5px] font-medium text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
							disabled={!restartable}
							title={restartable
								? 'Restart this managed service via DUMB'
								: service?.runState !== 'running'
									? 'Service is not running — nothing to restart'
									: undefined}
							aria-label="Restart {displayName}"
							onclick={() => {
								restartMessage = null;
								confirmRestart = true;
							}}
						>
							<RotateCw size={12} aria-hidden="true" />
							Restart service
						</button>
					{/if}
				</div>
				{#if restartMessage}
					<p
						class="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-[11.5px] {restartMessage.kind ===
						'ok'
							? 'text-healthy'
							: 'text-degraded'}"
						role="status"
					>
						{restartMessage.text}
					</p>
				{/if}
			{/if}

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

			{#if memoryObs && memoryObs.classification !== 'insufficient-history'}
				<div class="rounded-xl border border-border-subtle bg-surface-2 p-3.5 text-xs">
					<p class="mb-1.5 text-xs font-semibold text-text-secondary">Memory baseline</p>
					<p class="text-text-muted">
						24h p50 <span class="tnum text-text-primary">{formatBytes(memoryObs.p50Bytes)}</span>
						· p95 <span class="tnum text-text-primary">{formatBytes(memoryObs.p95Bytes)}</span>
						{#if memoryObs.delta24hBytes !== null}
							· Δ24h <span class="tnum text-text-primary"
								>{memoryObs.delta24hBytes >= 0 ? '+' : '−'}{formatBytes(
									Math.abs(memoryObs.delta24hBytes)
								)}</span
							>
						{/if}
					</p>
					<p class="mt-1 text-[11px] text-text-muted">
						classification: <span class="font-medium text-text-primary"
							>{memoryObs.classification}</span
						>
					</p>
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

	{#if confirmRestart && service}
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
			role="presentation"
		>
			<div
				class="w-full max-w-md rounded-[16px] border border-border-subtle bg-surface-1 p-5 shadow-2xl"
				role="dialog"
				aria-modal="true"
				aria-label="Confirm restart"
			>
				<h3 class="text-sm font-semibold text-text-primary">Restart {displayName}?</h3>
				<p class="mt-1.5 text-xs text-text-secondary">
					Only this managed service will be restarted, via DUMB's own management route. No other
					services and no container are affected.
				</p>
				<p class="mt-2 text-[11px] text-text-faint">
					Process: {service.processName} · Cooldown 6 h, max 2 attempts per 24 h. DUMBscope verifies recovery
					afterwards.
				</p>
				<div class="mt-4 flex justify-end gap-2">
					<button
						type="button"
						class="rounded-lg border border-border-subtle px-3.5 py-2 text-xs font-medium text-text-secondary hover:border-border-strong"
						onclick={() => (confirmRestart = false)}
					>
						Cancel
					</button>
					<button
						type="button"
						disabled={restartBusy}
						class="rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
						onclick={requestRestart}
					>
						{restartBusy ? 'Requesting…' : 'Restart service'}
					</button>
				</div>
			</div>
		</div>
	{/if}
</Drawer>
