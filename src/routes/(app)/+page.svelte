<script lang="ts">
	import { live } from '$lib/stores/live.svelte';
	import Card from '$lib/components/Card.svelte';
	import TopologyView from '$lib/components/TopologyView.svelte';
	import ServiceDrawer from '$lib/components/ServiceDrawer.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import AreaChart from '$lib/components/AreaChart.svelte';
	import { fade, fly } from 'svelte/transition';
	import { quintOut } from 'svelte/easing';
	import { Siren, CircleCheck, ArrowRight, Boxes, WifiOff } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { relativeTime } from '$lib/utils/format';

	let drawerKey = $state<string | null>(null);

	const overview = $derived(live.overview);
	const healthyHeadline = $derived.by(() => {
		switch (overview.health) {
			case 'healthy':
				return 'Your media stack is healthy';
			case 'degraded':
				return 'Your stack needs attention';
			case 'incident':
				return 'Your stack needs attention';
			default:
				return live.connection.state === 'offline'
					? 'DUMB is unreachable'
					: 'Connecting to your stack…';
		}
	});
	const healthySubline = $derived.by(() => {
		if (overview.servicesTotal === 0) return 'Waiting for services…';
		switch (overview.health) {
			case 'healthy':
				return `${overview.servicesOnline} services online · No active incidents`;
			case 'degraded':
			case 'incident':
				return `${overview.activeIncidents} incident${overview.activeIncidents === 1 ? '' : 's'} · ${Math.max(overview.servicesUnhealthy + overview.servicesDegraded, 0)} service${overview.servicesUnhealthy + overview.servicesDegraded === 1 ? '' : 's'} affected`;
			default:
				return `${overview.servicesTotal} services known`;
		}
	});

	const heroColor = $derived.by(() => {
		switch (overview.health) {
			case 'healthy':
				return 'var(--healthy)';
			case 'degraded':
				return 'var(--degraded)';
			case 'incident':
				return 'var(--critical)';
			default:
				return 'var(--unknown)';
		}
	});

	const cpuPoints = $derived(live.metricsHistory.slice(-360).map((p) => ({ t: p.t, v: p.cpu })));
	const memPoints = $derived(live.metricsHistory.slice(-360).map((p) => ({ t: p.t, v: p.mem })));
	const cpuNow = $derived(live.metrics?.cpuPercent ?? null);
	const memNow = $derived(live.metrics?.memory?.percent ?? null);
	const disk = $derived(live.metrics?.filesystems[0] ?? null);

	const activeIncidentList = $derived(live.activeIncidents);
	const offline = $derived(
		live.connection.state === 'offline' || live.connection.state === 'credentials-invalid'
	);
</script>

<div class="mx-auto max-w-[1400px] space-y-5 px-4 py-6 md:px-8">
	<!-- Hero -->
	<section
		class="flex flex-wrap items-end justify-between gap-4"
		in:fly={{ y: 8, duration: 260, easing: quintOut }}
	>
		<div>
			<h2
				class="text-[22px] font-semibold tracking-tight text-text-primary md:text-2xl"
				style="color: {overview.health === 'healthy'
					? 'var(--text-primary)'
					: 'var(--text-primary)'}"
			>
				{healthyHeadline}
			</h2>
			<p class="mt-1 flex items-center gap-2 text-[13px] text-text-muted">
				{#if live.connection.state === 'live'}
					<span class="relative flex h-1.5 w-1.5">
						<span
							class="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70"
							style="background:{heroColor}"
						></span>
						<span
							class="relative inline-flex h-1.5 w-1.5 rounded-full"
							style="background:{heroColor}"
						></span>
					</span>
				{/if}
				{healthySubline}
			</p>
		</div>
		<div class="flex gap-2">
			<a
				href="/incidents"
				class="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-1 px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
			>
				<Siren
					size={13}
					class={overview.criticalIncidents > 0 ? 'text-critical' : ''}
					aria-hidden="true"
				/>
				{overview.activeIncidents} active
			</a>
			<a
				href="/services"
				class="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-1 px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
			>
				<Boxes size={13} aria-hidden="true" />
				{overview.servicesTotal} services
			</a>
		</div>
	</section>

	{#if offline}
		<div
			class="flex items-center gap-3 rounded-[14px] border px-4 py-3"
			style="border-color: color-mix(in srgb, var(--critical) 30%, transparent); background: var(--critical-soft)"
		>
			<WifiOff size={16} class="shrink-0 text-critical" aria-hidden="true" />
			<div class="min-w-0 text-xs">
				<p class="font-semibold text-text-primary">
					{live.connection.state === 'credentials-invalid'
						? 'DUMB rejected the stored credentials'
						: 'DUMB is currently unreachable'}
				</p>
				<p class="text-text-muted">
					{#if live.connection.lastUpdateAt}
						Last connected {relativeTime(live.connection.lastUpdateAt)} ·
					{/if}
					Retrying automatically…
				</p>
			</div>
		</div>
	{/if}

	<!-- Topology -->
	<Card title="Media pipeline" subtitle="Live dependency view — click a service for details">
		{#snippet actions()}
			<a
				href="/pipeline"
				class="flex items-center gap-1 text-xs font-medium text-text-muted transition-colors hover:text-text-primary"
			>
				Full view <ArrowRight size={12} aria-hidden="true" />
			</a>
		{/snippet}
		{#if live.topology.nodes.length === 0}
			<div class="py-6">
				<EmptyState
					title={live.connection.state === 'live' ? 'No pipeline yet' : 'Connecting to DUMB…'}
					description={live.connection.state === 'live'
						? 'No services are discovered yet. Once DUMB reports services they will appear here.'
						: 'The topology appears as soon as the DUMB connection is live.'}
					neutral
				/>
			</div>
		{:else}
			<TopologyView graph={live.topology} compact onselect={(key) => (drawerKey = key)} />
		{/if}
	</Card>

	<!-- Bento grid -->
	<section
		class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
		in:fade={{ duration: 200, delay: 100 }}
	>
		<!-- Stack health (2 cols on xl) -->
		<div class="xl:col-span-2">
			<Card
				title="Stack health"
				subtitle={overview.health === 'healthy'
					? 'All monitored services operating normally'
					: 'Based on current incidents and service health'}
			>
				<div class="flex items-start justify-between gap-4">
					<div>
						<p class="text-3xl font-semibold tracking-tight capitalize" style="color: {heroColor}">
							{overview.health}
						</p>
						<p class="mt-1 text-xs text-text-muted">
							{overview.servicesOnline}/{overview.servicesTotal} running
							{#if overview.servicesDegraded > 0}· {overview.servicesDegraded} degraded{/if}
							{#if overview.servicesStopped > 0}· {overview.servicesStopped} stopped{/if}
						</p>
					</div>
					<div class="w-40">
						<Sparkline data={cpuPoints.map((p) => p.v ?? 0)} height={40} color="var(--accent)" />
						<p class="mt-1 text-right text-[10px] text-text-faint">CPU last ~12 min</p>
					</div>
				</div>
			</Card>
		</div>

		<!-- Resource usage -->
		<Card title="Resource usage" subtitle="Host metrics from DUMB">
			<div class="space-y-2.5">
				<div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">CPU</span>
						<span class="tnum font-medium">{cpuNow === null ? '—' : `${cpuNow.toFixed(1)}%`}</span>
					</div>
					<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
						<div
							class="h-full rounded-full bg-accent transition-[width] duration-500"
							style="width: {cpuNow ?? 0}%"
						></div>
					</div>
				</div>
				<div>
					<div class="flex justify-between text-xs">
						<span class="text-text-muted">Memory</span>
						<span class="tnum font-medium">{memNow === null ? '—' : `${memNow.toFixed(1)}%`}</span>
					</div>
					<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
						<div
							class="h-full rounded-full bg-accent transition-[width] duration-500"
							style="width: {memNow ?? 0}%"
						></div>
					</div>
				</div>
				{#if disk}
					<div>
						<div class="flex justify-between text-xs">
							<span class="text-text-muted">Disk {disk.path}</span>
							<span class="tnum font-medium">{disk.percent.toFixed(1)}%</span>
						</div>
						<div class="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
							<div
								class="h-full rounded-full transition-[width] duration-500 {disk.percent > 90
									? 'bg-critical'
									: disk.percent > 75
										? 'bg-degraded'
										: 'bg-accent'}"
								style="width: {disk.percent}%"
							></div>
						</div>
					</div>
				{/if}
			</div>
		</Card>

		<!-- Incidents / activity -->
		<Card title="Recent incidents" subtitle="Latest detected problems">
			{#if activeIncidentList.length === 0}
				<div class="flex flex-col items-center gap-1.5 py-5 text-center">
					<CircleCheck size={20} class="text-healthy" strokeWidth={1.5} aria-hidden="true" />
					<p class="text-xs font-medium text-text-secondary">All clear</p>
					<p class="text-[11px] text-text-muted">No incidents detected.</p>
				</div>
			{:else}
				<ul class="space-y-2">
					{#each activeIncidentList.slice(0, 3) as incident (incident.id)}
						<li>
							<button
								type="button"
								class="w-full rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-left transition-colors hover:border-border-strong"
								onclick={() => goto(`/incidents?incident=${incident.id}`)}
							>
								<div class="flex items-center gap-2">
									<span
										class="h-1.5 w-1.5 shrink-0 rounded-full {incident.severity === 'critical'
											? 'bg-critical'
											: incident.severity === 'warning'
												? 'bg-degraded'
												: 'bg-unknown'}"
									></span>
									<span class="truncate text-xs font-medium text-text-primary"
										>{incident.title}</span
									>
									<span class="tnum ml-auto shrink-0 text-[10px] text-text-faint"
										>{relativeTime(incident.firstSeen)}</span
									>
								</div>
								{#if incident.rootCauseService}
									<p class="mt-1 pl-3.5 text-[10px] text-text-muted">
										Root cause: {incident.rootCauseService}
									</p>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</Card>

		<!-- CPU/Mem chart (wide) -->
		<div class="xl:col-span-3">
			<Card title="Resource history" subtitle="CPU and memory over the recent window" flat={false}>
				{#if cpuPoints.length > 2}
					<AreaChart
						series={[
							{ name: 'CPU', color: 'var(--accent)', points: cpuPoints },
							{ name: 'Memory', color: 'var(--healthy)', points: memPoints }
						]}
						height={150}
					/>
				{:else}
					<div class="flex h-[150px] items-center justify-center text-xs text-text-muted">
						Collecting metrics… chart appears when enough data streams in.
					</div>
				{/if}
			</Card>
		</div>
	</section>
</div>

<ServiceDrawer serviceKey={drawerKey} onclose={() => (drawerKey = null)} />
