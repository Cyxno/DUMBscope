<script lang="ts">
	/**
	 * Overview reliability widget (DEEL 3, brief §37/§38): compact healthy
	 * summary — never a green wall — that flips to a focused problem state
	 * with the top issue and a path to details.
	 */
	import { live } from '$lib/stores/live.svelte';
	import Card from './Card.svelte';
	import { ArrowRight, ShieldCheck, TriangleAlert } from '@lucide/svelte';

	const conn = $derived(live.connection);
	const mounts = $derived(live.reliability.mounts);
	const mountsHealthy = $derived(mounts.filter((m) => m.state === 'healthy').length);
	const mountsConfigured = $derived(mounts.length > 0);
	const mountProblem = $derived(
		mounts.find(
			(m) =>
				m.state === 'unresponsive' ||
				m.state === 'read-error' ||
				m.state === 'degraded' ||
				m.state === 'missing'
		)
	);
	const memoryProblem = $derived(
		live.reliability.memory.find((m) => m.level === 'warning' || m.level === 'critical')
	);
	const memoryCollecting = $derived(
		live.reliability.memory.every((m) => m.samples === 0) &&
			live.reliability.stats.memoryTracked > 0
	);
	const repeats = $derived(live.mediaFlow.metrics.repeatedRequests24h);
	const mismatches = $derived(live.mediaFlow.metrics.activeMediaMismatches);

	const connLabel = $derived.by(() => {
		switch (conn.state) {
			case 'live':
				return 'Connected';
			case 'starting':
				return 'Starting';
			case 'reconnecting':
				return 'Reconnecting';
			case 'degraded':
				return 'Partial';
			case 'stale':
				return 'Quiet';
			case 'credentials-invalid':
				return 'Authentication failed';
			case 'offline':
				return 'Unreachable';
			default:
				return 'Waiting';
		}
	});
	const connColor = $derived(
		conn.state === 'live'
			? 'var(--healthy)'
			: conn.state === 'offline' || conn.state === 'credentials-invalid'
				? 'var(--critical)'
				: 'var(--degraded)'
	);

	const problems = $derived.by(() => {
		const list: { label: string; detail: string }[] = [];
		if (conn.state === 'offline') list.push({ label: 'DUMB', detail: 'Gateway unreachable' });
		if (conn.state === 'credentials-invalid')
			list.push({ label: 'DUMB', detail: 'Authentication failed — check credentials' });
		else if (conn.state === 'reconnecting' || conn.state === 'stale')
			list.push({ label: 'DUMB', detail: 'Reconnecting to DUMB' });
		if (mountProblem)
			list.push({
				label: 'Storage',
				detail: `${mountProblem.target.label}: ${mountProblem.state}`
			});
		if (memoryProblem)
			list.push({
				label: 'Memory',
				detail: `${memoryProblem.process} ${(memoryProblem.currentBytes ?? 0) / 1024 ** 3 >= 1 ? `${((memoryProblem.currentBytes ?? 0) / 1024 ** 3).toFixed(1)} GB` : `${Math.round((memoryProblem.currentBytes ?? 0) / 1024 ** 2)} MB`} · ${memoryProblem.level}`
			});
		if (repeats > 0)
			list.push({
				label: 'Media flow',
				detail: `${repeats} repeated request${repeats === 1 ? '' : 's'} (24h)`
			});
		if (mismatches > 0)
			list.push({
				label: 'Media flow',
				detail: `${mismatches} state mismatch${mismatches === 1 ? '' : 'es'}`
			});
		return list;
	});
	const hasProblem = $derived(problems.length > 0);
</script>

<Card
	title="Reliability"
	subtitle={hasProblem ? 'Needs attention' : 'Connectivity, storage, memory and media flow'}
>
	{#if hasProblem}
		<ul class="space-y-1.5">
			{#each problems.slice(0, 4) as problem (problem.label + problem.detail)}
				<li class="flex items-start gap-2 text-xs">
					<TriangleAlert size={13} class="mt-0.5 shrink-0 text-degraded" aria-hidden="true" />
					<span class="min-w-0">
						<span class="font-medium text-text-primary">{problem.label}</span>
						<span class="text-text-secondary"> — {problem.detail}</span>
					</span>
				</li>
			{/each}
		</ul>
		<a
			href="/system"
			class="mt-2.5 flex items-center gap-1 text-xs font-medium text-text-muted transition-colors hover:text-text-primary"
		>
			View details <ArrowRight size={12} aria-hidden="true" />
		</a>
	{:else}
		<div class="flex items-center gap-2">
			<ShieldCheck size={15} class="text-healthy" aria-hidden="true" />
			<ul class="grid flex-1 grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
				<li class="flex justify-between gap-2">
					<span class="text-text-muted">DUMB</span>
					<span class="font-medium" style="color:{connColor}">{connLabel}</span>
				</li>
				<li class="flex justify-between gap-2">
					<span class="text-text-muted">Mounts</span>
					<span class="font-medium text-text-secondary"
						>{mountsConfigured
							? `${mountsHealthy}/${mounts.length} healthy`
							: 'Not configured'}</span
					>
				</li>
				<li class="flex justify-between gap-2">
					<span class="text-text-muted">Memory</span>
					<span class="font-medium text-text-secondary"
						>{memoryCollecting ? 'Collecting baseline' : 'Normal'}</span
					>
				</li>
				<li class="flex justify-between gap-2">
					<span class="text-text-muted">Media flow</span>
					<span class="font-medium text-text-secondary">No active issues</span>
				</li>
			</ul>
		</div>
	{/if}
</Card>
