<script lang="ts">
	/**
	 * Compact cross-service media flow for one library item (DEEL 2, brief
	 * §28): shows the correlated per-source lines for exactly the stable media
	 * keys passed in — Sonarr/Radarr state, the acquisition path (InfiniDysk
	 * or Decypharr via the Arr's emulated download client) and storage. Items
	 * with no correlated flow render nothing at all: only sources that
	 * actually exist are shown.
	 */
	import { live } from '$lib/stores/live.svelte';
	import { Repeat2 } from '@lucide/svelte';

	let { keys }: { keys: string[] } = $props();

	const matches = $derived(live.mediaFlow.items.filter((i) => keys.includes(i.mediaKey)));

	const summaryColor = (summary: string): string => {
		switch (summary) {
			case 'available':
				return 'var(--healthy)';
			case 'failed':
				return 'var(--critical)';
			case 'acquiring':
			case 'importing':
			case 'downloading':
				return 'var(--degraded)';
			default:
				return 'var(--unknown)';
		}
	};
</script>

{#if matches.length > 0}
	<div class="rounded-xl border border-border-subtle bg-surface-2 p-3">
		<p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
			Media flow
		</p>
		{#each matches as item (item.mediaKey)}
			<div class="mb-1.5 last:mb-0">
				<div class="flex items-center justify-between gap-2 text-xs">
					<span class="font-medium text-text-primary">{item.title}</span>
					<span
						class="shrink-0 font-semibold capitalize"
						style="color:{summaryColor(item.summary)}"
					>
						{item.summary}
					</span>
				</div>
				<ul class="mt-1 space-y-0.5 text-[10px] text-text-muted">
					{#each item.observations.slice(-4) as obs, i (i)}
						<li class="flex items-center justify-between gap-2">
							<span class="capitalize">{obs.source}</span>
							<span class="truncate" title={obs.evidence ?? ''}>
								{obs.state}{obs.evidence ? ` — ${obs.evidence}` : ''}
							</span>
						</li>
					{/each}
				</ul>
				{#if item.classification === 'repeated-request'}
					<p class="mt-1 flex items-center gap-1 text-[10px] text-degraded">
						<Repeat2 size={10} aria-hidden="true" />
						Repeated request detected — {item.acquisitions} requests in the recent window while acquisition
						was active
					</p>
				{:else if item.classification === 'mount-unavailable'}
					<p class="mt-1 text-[10px] text-degraded">
						Storage mount unavailable — likely storage availability issue
					</p>
				{/if}
			</div>
		{/each}
	</div>
{/if}
