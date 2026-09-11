<script lang="ts">
	import { live } from '$lib/stores/live.svelte';
	import ServiceCard from '$lib/components/ServiceCard.svelte';
	import ServiceDrawer from '$lib/components/ServiceDrawer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import HealthBadge from '$lib/components/HealthBadge.svelte';
	import { severityRank, runStateLabel } from '$lib/utils/status';
	import { formatPercent, formatBytes, relativeTime } from '$lib/utils/format';
	import { page } from '$app/state';
	import { LayoutGrid, List } from '@lucide/svelte';
	import { fly } from 'svelte/transition';
	import { pipelineModelFromLive, pipelineMetaForKey } from '$lib/pipeline/from-live';
	import type { PipelineStageId } from '$lib/pipeline/model';

	type Filter = 'all' | 'healthy' | 'degraded' | 'unhealthy' | 'stopped' | 'unknown';

	let query = $state('');
	let filter = $state<Filter>('all');
	let view = $state<'cards' | 'list'>('cards');
	let drawerKey = $state<string | null>(null);

	// Deep link: /services?service=key opens the drawer.
	$effect(() => {
		const target = page.url.searchParams.get('service');
		if (target) drawerKey = target;
	});

	const FILTERS: { id: Filter; label: string }[] = [
		{ id: 'all', label: 'All' },
		{ id: 'healthy', label: 'Healthy' },
		{ id: 'degraded', label: 'Degraded' },
		{ id: 'unhealthy', label: 'Unhealthy' },
		{ id: 'stopped', label: 'Stopped' },
		{ id: 'unknown', label: 'Unknown' }
	];

	// Stage grouping comes from the same PipelineViewModel the Pipeline page
	// uses, so a service carries the same name, descriptor and stage everywhere.
	const model = $derived(pipelineModelFromLive());
	const metaOf = $derived((key: string) => pipelineMetaForKey(model, key));

	const matches = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const list = live.services.filter((service) => {
			const meta = metaOf(service.key);
			if (
				q &&
				!service.name.toLowerCase().includes(q) &&
				!service.processName.toLowerCase().includes(q) &&
				!(meta?.name.toLowerCase().includes(q) ?? false)
			) {
				return false;
			}
			switch (filter) {
				case 'healthy':
					return service.health === 'healthy';
				case 'degraded':
					return service.health === 'degraded' || service.health === 'starting';
				case 'unhealthy':
					return service.health === 'unhealthy';
				case 'stopped':
					return service.runState === 'stopped';
				case 'unknown':
					return service.health === 'unknown';
				default:
					return true;
			}
		});
		return [...list].sort(
			(a, b) => severityRank(a.health) - severityRank(b.health) || a.name.localeCompare(b.name)
		);
	});

	// Group matched services by pipeline stage (flow order + supporting last).
	const STAGE_ORDER: PipelineStageId[] = [
		'requests',
		'automation',
		'acquisition',
		'storage',
		'media',
		'supporting'
	];
	const groups = $derived.by(() => {
		const byStage = new Map<PipelineStageId, typeof matches>();
		for (const service of matches) {
			const stage = metaOf(service.key)?.stage ?? 'supporting';
			const list = byStage.get(stage) ?? [];
			list.push(service);
			byStage.set(stage, list);
		}
		const flow = STAGE_ORDER.map((id) => ({
			id,
			label: model.stages.find((s) => s.id === id)?.label ?? model.supporting?.label ?? id,
			services: byStage.get(id) ?? []
		})).filter((group) => group.services.length > 0);
		// Services remain a full inventory: managed platform components get
		// their own group instead of disappearing from the page entirely.
		const infraKeys = new Set(model.infrastructure.map((s) => s.key));
		const infra = matches.filter((service) => infraKeys.has(service.key));
		const supporting = flow.find((group) => group.id === 'supporting');
		const withoutSupporting = flow.filter((group) => group.id !== 'supporting');
		const result = withoutSupporting;
		if (supporting) result.push(supporting);
		if (infra.length > 0)
			result.push({ id: 'infrastructure', label: 'Infrastructure', services: infra });
		return result;
	});

	function openService(key: string) {
		drawerKey = key;
		history.replaceState(null, '', `?service=${encodeURIComponent(key)}`);
	}
	function closeDrawer() {
		drawerKey = null;
		if (page.url.searchParams.has('service')) {
			history.replaceState(null, '', '/services');
		}
	}
</script>

<div class="mx-auto max-w-[1400px] space-y-5 px-4 py-6 md:px-8">
	<header class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h2 class="text-lg font-semibold tracking-tight">Services</h2>
			<p class="mt-0.5 text-[13px] text-text-muted">
				{live.services.length} managed by DUMB · grouped by pipeline stage
			</p>
		</div>
		<div class="flex items-center gap-2">
			<div class="flex overflow-hidden rounded-lg border border-border-subtle">
				<button
					type="button"
					class="px-2.5 py-1.5 {view === 'cards'
						? 'bg-surface-3 text-text-primary'
						: 'text-text-muted hover:text-text-secondary'}"
					onclick={() => (view = 'cards')}
					aria-pressed={view === 'cards'}
					aria-label="Card view"
				>
					<LayoutGrid size={15} />
				</button>
				<button
					type="button"
					class="px-2.5 py-1.5 {view === 'list'
						? 'bg-surface-3 text-text-primary'
						: 'text-text-muted hover:text-text-secondary'}"
					onclick={() => (view = 'list')}
					aria-pressed={view === 'list'}
					aria-label="Compact list view"
				>
					<List size={15} />
				</button>
			</div>
		</div>
	</header>

	<div class="flex flex-wrap items-center gap-2">
		<input
			type="search"
			bind:value={query}
			placeholder="Filter services…"
			class="h-9 w-52 rounded-lg border border-border-subtle bg-surface-1 px-3 text-[13px] text-text-primary outline-none transition-colors placeholder:text-text-faint focus:border-border-focus"
			aria-label="Filter services"
		/>
		<div class="flex flex-wrap gap-1" role="group" aria-label="Health filter">
			{#each FILTERS as f (f.id)}
				<button
					type="button"
					class="rounded-full border px-3 py-1 text-xs font-medium transition-colors {filter ===
					f.id
						? 'border-accent bg-accent-soft text-text-primary'
						: 'border-border-subtle text-text-muted hover:border-border-strong hover:text-text-secondary'}"
					onclick={() => (filter = f.id)}
					aria-pressed={filter === f.id}
				>
					{f.label}
				</button>
			{/each}
		</div>
	</div>

	{#if matches.length === 0}
		<EmptyState
			title={live.services.length === 0 ? 'No services discovered yet' : 'No services match'}
			description={live.services.length === 0
				? 'Services appear here automatically once DUMB reports them.'
				: 'Try a different search or filter.'}
			neutral
		/>
	{:else if view === 'cards'}
		<div class="space-y-7" in:fly={{ y: 6, duration: 180 }}>
			{#each groups as group (group.id)}
				<section aria-label="{group.label} services">
					<h3 class="mb-2.5 text-[11px] font-bold tracking-[0.1em] uppercase text-text-faint">
						{group.label}
					</h3>
					<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
						{#each group.services as service (service.key)}
							<ServiceCard
								{service}
								displayName={metaOf(service.key)?.name ?? null}
								descriptor={metaOf(service.key)?.descriptor ?? null}
								onopen={openService}
							/>
						{/each}
					</div>
				</section>
			{/each}
		</div>
	{:else}
		<div class="overflow-hidden rounded-[14px] border border-border-subtle bg-surface-1">
			<table class="w-full text-left text-[13px]">
				<thead>
					<tr
						class="border-b border-border-subtle text-[11px] uppercase tracking-wider text-text-faint"
					>
						<th class="px-4 py-2.5 font-semibold">Service</th>
						<th class="px-4 py-2.5 font-semibold">Health</th>
						<th class="px-4 py-2.5 font-semibold">State</th>
						<th class="px-4 py-2.5 text-right font-semibold">CPU</th>
						<th class="px-4 py-2.5 text-right font-semibold">RAM</th>
						<th class="px-4 py-2.5 text-right font-semibold">Restarts</th>
						<th class="px-4 py-2.5 text-right font-semibold">Last event</th>
					</tr>
				</thead>
				<tbody>
					{#each matches as service (service.key)}
						<tr
							class="cursor-pointer border-b border-border-subtle transition-colors last:border-0 hover:bg-surface-2"
							onclick={() => openService(service.key)}
							onkeydown={(e) => e.key === 'Enter' && openService(service.key)}
							tabindex="0"
						>
							<td class="px-4 py-2.5 font-medium text-text-primary">
								{metaOf(service.key)?.name ?? service.name}
							</td>
							<td class="px-4 py-2.5"><HealthBadge health={service.health} size="sm" /></td>
							<td class="px-4 py-2.5 text-text-muted">{runStateLabel(service.runState)}</td>
							<td class="tnum px-4 py-2.5 text-right">{formatPercent(service.cpuPercent)}</td>
							<td class="tnum px-4 py-2.5 text-right">{formatBytes(service.memoryBytes)}</td>
							<td class="tnum px-4 py-2.5 text-right">{service.restart?.failures ?? 0}</td>
							<td class="tnum px-4 py-2.5 text-right text-text-muted"
								>{relativeTime(service.observedAt)}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<ServiceDrawer serviceKey={drawerKey} onclose={closeDrawer} />
