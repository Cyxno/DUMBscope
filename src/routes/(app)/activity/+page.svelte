<script lang="ts">
	import Card from '$lib/components/Card.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { formatTime } from '$lib/utils/format';
	import type { ActivityEntry } from '$lib/types';
	import { History } from '@lucide/svelte';

	let entries = $state<ActivityEntry[]>([]);
	let loading = $state(true);

	async function load() {
		try {
			const response = await fetch('/api/activity?limit=120');
			if (response.ok) {
				const data = (await response.json()) as { entries: ActivityEntry[] };
				entries = data.entries;
			}
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void load();
	});

	function kindColor(kind: ActivityEntry['kind']): string {
		switch (kind) {
			case 'incident':
				return 'var(--critical)';
			case 'health-transition':
				return 'var(--degraded)';
			case 'restart':
				return 'var(--degraded)';
			case 'connection':
				return 'var(--live)';
			case 'service-started':
				return 'var(--healthy)';
			default:
				return 'var(--unknown)';
		}
	}
</script>

<div class="mx-auto max-w-[800px] space-y-5 px-4 py-6 md:px-8">
	<header>
		<h2 class="text-lg font-semibold tracking-tight">Activity</h2>
		<p class="mt-0.5 text-[13px] text-text-muted">
			Every entry is an observed fact from DUMB or a DUMBscope state change — nothing inferred or
			invented.
		</p>
	</header>

	<Card padding={false}>
		{#if loading}
			<div class="space-y-2 p-4">
				{#each Array(6) as _, i (i)}
					<div class="h-8 animate-pulse rounded-lg bg-surface-2"></div>
				{/each}
			</div>
		{:else if entries.length === 0}
			<div class="p-6">
				<EmptyState
					icon={History}
					title="No activity yet"
					description="Health transitions, restarts and connection changes appear here as they happen."
					neutral
				/>
			</div>
		{:else}
			<ol class="divide-y divide-border-subtle">
				{#each entries as entry (entry.id)}
					<li class="flex items-start gap-3 px-4 py-2.5">
						<span
							class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
							style="background: {kindColor(entry.kind)}"
						></span>
						<p class="min-w-0 flex-1 text-[13px] text-text-secondary">
							<span class="tnum mr-2.5 text-[11px] text-text-faint">{formatTime(entry.at)}</span>
							{entry.message}
						</p>
						<span
							class="shrink-0 rounded bg-surface-2 px-1.5 py-px text-[10px] capitalize text-text-faint"
							>{entry.kind.replace('-', ' ')}</span
						>
					</li>
				{/each}
			</ol>
		{/if}
	</Card>
</div>
