<script lang="ts">
	/**
	 * Deep-integration panel inside the service drawer. Loads cached poll data
	 * from DUMBscope (never the service API directly) for the integration
	 * matching this service, and renders a compact read-only view.
	 */
	import { onMount } from 'svelte';
	import EmptyState from './EmptyState.svelte';
	import { matchCatalog, INTEGRATION_CAPABLE_IDS } from '$lib/shared/catalog';

	let { serviceKey }: { serviceKey: string } = $props();

	/** True when a deep-monitoring adapter exists for this service type. */
	const capabilityKnown = $derived.by(() => {
		const entry = matchCatalog(serviceKey, serviceKey);
		return entry ? INTEGRATION_CAPABLE_IDS.has(entry.id) : false;
	});

	interface QueueItem {
		id: number;
		title: string;
		status: string;
		trackedDownloadStatus: string;
		progress: number;
		timeLeft: string | null;
		errorMessage: string | null;
	}
	interface IntegrationData {
		config: { id: string; type: string; enabled: boolean; hasApiKey: boolean };
		status: { state: string; version: string | null; lastError: string | null } | null;
		data: {
			queue: { total: number; items: QueueItem[]; warnings: number; failures: number } | null;
			health: { source: string; message: string }[] | null;
			wanted: { missing: number; cutoffUnmet: number } | null;
			upcoming: { title: string }[] | null;
		};
	}

	let integration = $state<IntegrationData | null>(null);
	let found = $state(false);
	let timer: ReturnType<typeof setInterval> | undefined;

	async function load() {
		const listResponse = await fetch('/api/integrations');
		if (!listResponse.ok) return;
		const list = (await listResponse.json()) as {
			integrations: { config: IntegrationData['config'] }[];
		};
		const match = list.integrations.find(
			(i) => i.config.type === serviceKey || i.config.id.startsWith(serviceKey)
		);
		if (!match) {
			found = false;
			return;
		}
		found = true;
		const dataResponse = await fetch(`/api/integrations/${match.config.id}/data`);
		if (dataResponse.ok) integration = (await dataResponse.json()) as IntegrationData;
	}

	onMount(() => {
		void load();
		timer = setInterval(() => void load(), 15_000);
		return () => clearInterval(timer);
	});

	const queueItems = $derived(integration?.data.queue?.items ?? []);
</script>

{#if found}
	<div class="rounded-xl border border-border-subtle bg-surface-2 p-3 text-xs">
		<p class="mb-2 font-semibold text-text-secondary">Deep monitoring</p>

		{#if integration?.status?.state === 'connected'}
			<p class="mb-2 flex items-center gap-1.5 text-[11px] text-healthy">
				<span class="inline-block size-1.5 rounded-full bg-healthy"></span>
				Connected{integration.status.version ? ` · v${integration.status.version}` : ''}
			</p>
		{:else if integration?.status?.state}
			<p class="mb-2 flex items-center gap-1.5 text-[11px] text-degraded">
				<span class="inline-block size-1.5 rounded-full bg-degraded"></span>
				{integration.status.state}
				{#if integration.status.lastError}
					— {integration.status.lastError}
				{/if}
			</p>
		{/if}

		{#if integration?.data.queue}
			<div class="mb-1 flex items-center justify-between">
				<p class="font-medium text-text-secondary">Queue</p>
				<p class="text-text-faint">
					{integration.data.queue.total} item{integration.data.queue.total === 1 ? '' : 's'}
					{#if integration.data.queue.failures > 0}
						· <span class="text-critical">{integration.data.queue.failures} failed</span>
					{/if}
				</p>
			</div>
			{#if queueItems.length === 0}
				<p class="mb-2 text-[11px] text-text-faint">Download queue is empty.</p>
			{:else}
				<ul class="mb-2 max-h-44 space-y-1.5 overflow-y-auto">
					{#each queueItems as item (item.id)}
						<li class="rounded-lg border border-border-subtle bg-surface-1 px-2 py-1.5">
							<p class="truncate text-[11px] font-medium text-text-primary">{item.title}</p>
							<div class="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
								<div
									class="h-full rounded-full {item.trackedDownloadStatus === 'failure'
										? 'bg-critical'
										: 'bg-accent'}"
									style="width: {item.progress}%"
								></div>
							</div>
							<p class="mt-0.5 text-[10px] text-text-faint">
								{Math.round(item.progress)}%{item.timeLeft ? ` · ${item.timeLeft} left` : ''}
							</p>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}

		{#if integration?.data.wanted}
			<div class="mb-1 mt-3 grid grid-cols-2 gap-2">
				<div class="rounded-lg border border-border-subtle bg-surface-1 px-2 py-1.5">
					<p class="text-[10px] text-text-faint">Missing</p>
					<p class="text-sm font-semibold text-text-primary tabular-nums">
						{integration.data.wanted.missing}
					</p>
				</div>
				<div class="rounded-lg border border-border-subtle bg-surface-1 px-2 py-1.5">
					<p class="text-[10px] text-text-faint">Cutoff unmet</p>
					<p class="text-sm font-semibold text-text-primary tabular-nums">
						{integration.data.wanted.cutoffUnmet}
					</p>
				</div>
			</div>
		{/if}

		{#if integration?.data.upcoming && integration.data.upcoming.length > 0}
			<p class="mt-3 font-medium text-text-secondary">Next 7 days</p>
			<ul class="mt-1 space-y-0.5 text-[11px] text-text-muted">
				{#each integration.data.upcoming.slice(0, 6) as entry (entry.title)}
					<li class="truncate">• {entry.title}</li>
				{/each}
			</ul>
		{/if}

		{#if integration?.data.health && integration.data.health.length > 0}
			<p class="mt-3 font-medium text-text-secondary">Health warnings</p>
			<ul class="mt-1 space-y-0.5 text-[11px]">
				{#each integration.data.health.slice(0, 4) as entry (entry.source + entry.message)}
					<li class="text-degraded">• {entry.message}</li>
				{/each}
			</ul>
		{/if}
	</div>
{:else if found === false}
	{#if capabilityKnown}
		<div
			class="rounded-xl border border-border-subtle bg-surface-2 px-4 py-3.5 text-xs text-text-muted"
		>
			<p class="font-semibold text-text-secondary">Detailed monitoring isn't configured</p>
			<p class="mt-1">Basic process monitoring through DUMB is active.</p>
			<a href="/settings" class="mt-1.5 inline-block font-medium text-accent-text hover:underline"
				>Configure in Settings →</a
			>
		</div>
	{:else}
		<EmptyState
			title="Basic monitoring"
			description="DUMBscope is monitoring process status and resource usage for this service."
		/>
	{/if}
{/if}
