<script lang="ts">
	import { live } from '$lib/stores/live.svelte';
	import Card from '$lib/components/Card.svelte';
	import TopologyView from '$lib/components/TopologyView.svelte';
	import ServiceDrawer from '$lib/components/ServiceDrawer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { CATEGORY_ORDER } from '$lib/shared/catalog';

	let drawerKey = $state<string | null>(null);

	const legend = $derived.by(() => {
		const present = new Set(live.topology.nodes.map((n) => n.category));
		return CATEGORY_ORDER.filter((c) => present.has(c));
	});
</script>

<div class="mx-auto max-w-[1500px] space-y-5 px-4 py-6 md:px-8">
	<header>
		<h2 class="text-lg font-semibold tracking-tight">Media pipeline</h2>
		<p class="mt-0.5 text-[13px] text-text-muted">
			How data flows through your stack, derived from the services DUMB manages. Unknown services
			appear as generic nodes.
		</p>
	</header>

	<div class="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-text-muted">
		<span class="flex items-center gap-1.5"
			><span class="h-1.5 w-1.5 rounded-full bg-healthy"></span> Healthy</span
		>
		<span class="flex items-center gap-1.5"
			><span class="h-1.5 w-1.5 rounded-full bg-degraded"></span> Degraded / starting</span
		>
		<span class="flex items-center gap-1.5"
			><span class="h-1.5 w-1.5 rounded-full bg-critical"></span> Unhealthy</span
		>
		<span class="flex items-center gap-1.5"
			><span class="h-1.5 w-1.5 rounded-full bg-unknown"></span> Unknown / stopped</span
		>
		<span class="flex items-center gap-1.5"
			><span class="inline-block h-px w-5 bg-accent"></span> Flowing</span
		>
	</div>

	<Card padding={false}>
		{#if live.topology.nodes.length === 0}
			<div class="p-6">
				<EmptyState
					title={live.connection.state === 'live' ? 'Nothing to map yet' : 'Connecting to DUMB…'}
					description="As soon as services are discovered the pipeline builds itself here."
					neutral
				/>
			</div>
		{:else}
			<div class="overflow-x-auto p-5">
				<TopologyView graph={live.topology} onselect={(key) => (drawerKey = key)} />
			</div>
		{/if}
	</Card>

	{#if legend.length > 0}
		<div class="flex flex-wrap gap-2">
			{#each legend as category (category)}
				<span
					class="rounded-full border border-border-subtle bg-surface-1 px-2.5 py-1 text-[11px] capitalize text-text-muted"
				>
					{category.replace('-', ' ')}
				</span>
			{/each}
		</div>
	{/if}
</div>

<ServiceDrawer serviceKey={drawerKey} onclose={() => (drawerKey = null)} />
