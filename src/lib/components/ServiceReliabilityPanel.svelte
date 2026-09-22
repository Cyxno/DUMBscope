<script lang="ts">
	/**
	 * Per-service operational statistics (§12): 24 h availability, incident
	 * count, restarts, degraded time, longest outage and MTTR — computed from
	 * the existing incident + service-event history. Availability is the share
	 * of MONITORED time; unobserved periods are excluded (coverage) and never
	 * implied as available.
	 */
	import { onMount } from 'svelte';
	import Card from '$lib/components/Card.svelte';
	import { formatDuration } from '$lib/utils/format';

	interface Slo {
		serviceKey: string;
		name: string;
		coverageMs: number;
		windowLengthMs: number;
		availability: number | null;
		incidentCount: number;
		restartCount: number;
		degradedMs: number;
		longestOutageMs: number;
		mttrMs: number | null;
		firstObservedAt: number | null;
	}

	interface SloRow extends Slo {
		windows: Slo[];
	}

	let rows = $state<SloRow[] | null>(null);

	onMount(async () => {
		try {
			const response = await fetch('/api/reliability/slo');
			if (response.ok) {
				const data = (await response.json()) as { services: SloRow[] };
				rows = data.services;
			}
		} catch {
			rows = [];
		}
	});

	const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(2)}%`);
</script>

<Card
	title="Service reliability (24h)"
	subtitle="Availability over monitored time — incidents, restarts, outages and recovery speed"
>
	{#if !rows}
		<p class="px-1 pb-2 text-xs text-text-muted">Loading service statistics…</p>
	{:else if rows.length === 0}
		<p class="px-1 pb-2 text-xs text-text-muted">No service history yet.</p>
	{:else}
		<div class="overflow-x-auto">
			<table class="w-full text-left text-xs">
				<thead>
					<tr class="text-[10px] uppercase tracking-wider text-text-faint">
						<th class="px-2 py-1.5 font-semibold">Service</th>
						<th class="px-2 py-1.5 text-right font-semibold">Availability</th>
						<th class="px-2 py-1.5 text-right font-semibold">Incidents</th>
						<th class="px-2 py-1.5 text-right font-semibold">Restarts</th>
						<th class="px-2 py-1.5 text-right font-semibold">Degraded</th>
						<th class="px-2 py-1.5 text-right font-semibold">Longest outage</th>
						<th class="px-2 py-1.5 text-right font-semibold">MTTR</th>
						<th class="px-2 py-1.5 text-right font-semibold">Coverage</th>
					</tr>
				</thead>
				<tbody class="tnum">
					{#each rows as row (row.serviceKey)}
						{@const day = row.windows?.[0] ?? row}
						<tr class="border-t border-border-subtle">
							<td class="px-2 py-1.5 font-medium text-text-primary">{row.name}</td>
							<td
								class="px-2 py-1.5 text-right font-semibold {day.availability !== null &&
								day.availability < 0.99
									? 'text-degraded'
									: 'text-healthy'}"
							>
								{pct(day.availability)}
							</td>
							<td class="px-2 py-1.5 text-right text-text-secondary">{day.incidentCount}</td>
							<td class="px-2 py-1.5 text-right text-text-secondary">{day.restartCount}</td>
							<td class="px-2 py-1.5 text-right text-text-secondary">
								{day.degradedMs > 0 ? formatDuration(day.degradedMs) : '—'}
							</td>
							<td class="px-2 py-1.5 text-right text-text-secondary">
								{day.longestOutageMs > 0 ? formatDuration(day.longestOutageMs) : '—'}
							</td>
							<td class="px-2 py-1.5 text-right text-text-secondary">
								{day.mttrMs !== null ? formatDuration(day.mttrMs) : '—'}
							</td>
							<td
								class="px-2 py-1.5 text-right text-text-faint"
								title="Share of the 24h window DUMBscope was observing this service"
							>
								{day.coverageMs > 0
									? `${Math.min(100, Math.round((day.coverageMs / day.windowLengthMs) * 100))}%`
									: '—'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="mt-2 text-[10px] leading-relaxed text-text-faint">
			Availability counts only time DUMBscope was observing (coverage). 7d/30d windows are available
			via <code class="font-mono">/api/reliability/slo</code>.
		</p>
	{/if}
</Card>
