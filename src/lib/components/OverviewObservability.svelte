<script lang="ts">
	import { live } from '$lib/stores/live.svelte';
	import Card from '$lib/components/Card.svelte';
	import { formatBytes, relativeTime } from '$lib/utils/format';
	import { ArrowRight } from '@lucide/svelte';

	/**
	 * Compact deep-observability strip for the Overview dashboard (brief §12):
	 * DUMB memory state, heaviest services, InfiniDysk health, routing summary,
	 * active anomalies and thermal state — one glance, deep detail one click
	 * away on /observability.
	 */
	const obs = $derived(live.observability);
	const GIB = 1024 ** 3;

	const cg = $derived(obs?.cgroup);
	const currentGiB = $derived((cg?.breakdown.currentBytes ?? 0) / GIB);
	const highGiB = $derived((cg?.highBytes ?? 0) / GIB);
	const usagePct = $derived(cg?.highBytes ? Math.min(100, (currentGiB / highGiB) * 100) : null);

	const state = $derived.by(() => {
		if (!obs) return { label: 'starting', color: 'var(--unknown)' };
		const i = cg?.interpretation;
		if (!cg?.at) return { label: 'no cgroup data', color: 'var(--unknown)' };
		if (i?.oom || i?.pressure || i?.hardLimitHit)
			return { label: 'memory pressure', color: 'var(--critical)' };
		if (i?.softReclaimActive) return { label: 'soft reclaim', color: 'var(--degraded)' };
		return { label: 'within limits', color: 'var(--healthy)' };
	});

	const topServices = $derived(
		(obs?.services ?? []).filter((s) => s.currentBytes !== null).slice(0, 3)
	);
	const anomalies = $derived(
		(obs?.services ?? []).filter((s) => s.classification === 'possible-leak').length
	);
	const infinidysk = $derived(obs?.infiniDysk);
	const routing = $derived(obs?.routing);
	const thermal = $derived(obs?.thermal);
	const primaryClient = $derived((routing?.clients ?? []).find((c) => c.primary) ?? null);
</script>

<Card
	title="DUMB observability"
	subtitle={cg?.at
		? `cgroup ${relativeTime(cg.at).toLowerCase()} · ${state.label}`
		: (cg?.unavailableReason ?? 'Waiting for the first sample…')}
>
	{#snippet actions()}
		<a
			href="/observability"
			class="flex items-center gap-1 text-xs font-medium text-text-muted transition-colors hover:text-text-primary"
		>
			Deep view <ArrowRight size={12} aria-hidden="true" />
		</a>
	{/snippet}

	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
		<!-- Memory -->
		<div class="rounded-lg bg-surface-2 px-3 py-2.5">
			<p class="text-[11px] font-semibold uppercase tracking-wider text-text-faint">Memory</p>
			<p class="tnum mt-1 text-sm font-semibold">
				{cg?.breakdown.currentBytes !== null && cg?.breakdown.currentBytes !== undefined
					? `${currentGiB.toFixed(2)} GiB`
					: '—'}
				{#if cg?.highBytes}
					<span class="text-[11px] font-normal text-text-muted"
						>/ {highGiB.toFixed(1)} GiB high</span
					>
				{/if}
			</p>
			<div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
				<div
					class="h-full rounded-full transition-[width] duration-500"
					style={`width:${usagePct ?? 0}%;background:${state.color}`}
				></div>
			</div>
			<p class="mt-1 text-[11px]" style={state.color}>{state.label}</p>
		</div>
		<!-- Top services -->
		<div class="rounded-lg bg-surface-2 px-3 py-2.5">
			<p class="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
				Top memory services
				{#if anomalies > 0}
					<span
						class="ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
						style="background: color-mix(in srgb, var(--critical) 18%, transparent); color: var(--critical)"
						>{anomalies} leak suspect{anomalies === 1 ? '' : 's'}</span
					>
				{/if}
			</p>
			<ul class="mt-1 space-y-0.5 text-xs">
				{#each topServices as s (s.key)}
					<li class="flex items-center justify-between gap-2">
						<span class="min-w-0 truncate text-text-secondary">{s.name}</span>
						<span class="tnum shrink-0 text-text-muted">{formatBytes(s.currentBytes)}</span>
					</li>
				{:else}
					<li class="text-text-muted">Collecting baselines…</li>
				{/each}
			</ul>
		</div>
		<!-- InfiniDysk -->
		<div class="rounded-lg bg-surface-2 px-3 py-2.5">
			<p class="text-[11px] font-semibold uppercase tracking-wider text-text-faint">InfiniDysk</p>
			<p class="mt-1 text-sm font-semibold">
				{infinidysk?.available ? (infinidysk.version ?? '—') : '—'}
			</p>
			<p
				class="mt-0.5 text-[11px]"
				style={infinidysk?.repairActive ? 'var(--degraded)' : 'var(--healthy)'}
			>
				{infinidysk?.available
					? infinidysk.repairActive
						? 'repair active'
						: `${infinidysk.repairs1h} repairs/h · ${infinidysk.article430_1h}× 430/h`
					: 'not in registry'}
			</p>
		</div>
		<!-- Routing + thermal -->
		<div class="rounded-lg bg-surface-2 px-3 py-2.5">
			<p class="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
				Routing · thermal
			</p>
			<p class="mt-1 text-xs">
				{#if primaryClient}
					<span class="text-text-secondary">primary:</span>
					<span class="font-medium">{primaryClient.client}</span>
					<span class="tnum text-text-muted"
						>({primaryClient.grabs} grabs/{routing?.windowHours ?? 24}h)</span
					>
				{:else}
					<span class="text-text-muted">routing pending</span>
				{/if}
			</p>
			<p class="mt-0.5 text-[11px] text-text-muted">
				{thermal?.maxTempC !== null && thermal?.maxTempC !== undefined
					? `${thermal.maxTempC.toFixed(0)}°C ${thermal.spikeLevel ? '· spike!' : ''}`
					: 'thermal n/a'}
			</p>
		</div>
	</div>
</Card>
