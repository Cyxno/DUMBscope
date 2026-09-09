<script lang="ts">
	import { live } from '$lib/stores/live.svelte';
	import Card from '$lib/components/Card.svelte';
	import Drawer from '$lib/components/Drawer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import TopologyView from '$lib/components/TopologyView.svelte';
	import { formatDuration, formatTime, formatDateTime } from '$lib/utils/format';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ScrollText, History } from '@lucide/svelte';
	import type { Incident } from '$lib/types';

	let detail = $state<Incident | null>(null);
	let detailLoading = $state(false);
	let historyList = $state<Incident[]>([]);
	let historyLoading = $state(true);

	$effect(() => {
		const target = page.url.searchParams.get('incident');
		if (target) void openIncident(target);
	});

	async function loadHistory() {
		historyLoading = true;
		try {
			const response = await fetch('/api/incidents?status=all&limit=40');
			if (response.ok) {
				const data = (await response.json()) as { incidents: Incident[] };
				historyList = data.incidents;
			}
		} finally {
			historyLoading = false;
		}
	}

	$effect(() => {
		void loadHistory();
	});

	// Keep the open drawer live.
	$effect(() => {
		if (!detail) return;
		const updated = live.activeIncidents.find((i) => i.id === detail!.id);
		if (updated) detail = updated;
	});

	async function openIncident(id: string) {
		detailLoading = true;
		history.replaceState(null, '', `?incident=${id}`);
		try {
			const response = await fetch(`/api/incidents/${id}`);
			if (response.ok) {
				const data = (await response.json()) as { incident: Incident };
				detail = data.incident;
			}
		} finally {
			detailLoading = false;
		}
	}

	function closeDetail() {
		detail = null;
		if (page.url.searchParams.has('incident')) {
			history.replaceState(null, '', '/incidents');
		}
	}

	function viewRelatedLogs(incident: Incident) {
		const windowMs = 5 * 60 * 1000;
		const since = incident.firstSeen - windowMs;
		const until = (incident.resolvedAt ?? Date.now()) + windowMs;
		const services = incident.affectedServices
			.map((key) => live.serviceByKey(key)?.processName ?? key)
			.join(',');
		goto(
			`/logs?incidents=${encodeURIComponent(incident.id)}&from=${since}&to=${until}&services=${encodeURIComponent(services)}`
		);
	}

	const sevColor = (incident: Incident) =>
		incident.severity === 'critical'
			? 'var(--critical)'
			: incident.severity === 'warning'
				? 'var(--degraded)'
				: 'var(--unknown)';

	/** Sub-graph around the root cause / affected services for the detail view. */
	const detailGraph = $derived.by(() => {
		if (!detail) return { nodes: [], edges: [] };
		const relevant = new Set<string>();
		for (const node of live.topology.nodes) {
			const isRoot = detail.rootCauseService && node.name === detail.rootCauseService;
			const isAffected = detail.affectedServices.some((key) => key === node.key);
			if (isRoot || isAffected) relevant.add(node.key);
		}
		// Include one hop of context so the chain is visible.
		for (const edge of live.topology.edges) {
			if (relevant.has(edge.to) && detail.rootCauseService) relevant.add(edge.from);
			if (relevant.has(edge.from)) {
				// keep affected downstream visible
			}
		}
		const nodes = live.topology.nodes.filter((n) => relevant.has(n.key));
		const keys = new Set(nodes.map((n) => n.key));
		const edges = live.topology.edges.filter((e) => keys.has(e.from) && keys.has(e.to));
		return { nodes, edges };
	});
</script>

<div class="mx-auto max-w-[1100px] space-y-5 px-4 py-6 md:px-8">
	<header>
		<h2 class="text-lg font-semibold tracking-tight">Incidents</h2>
		<p class="mt-0.5 text-[13px] text-text-muted">
			Deduplicated, correlated failure records with root-cause analysis.
		</p>
	</header>

	<section>
		<h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-text-faint">Active</h3>
		{#if live.activeIncidents.length === 0}
			<EmptyState
				title="All clear"
				description="No incidents detected. Your stack is operating normally."
			/>
		{:else}
			<div class="space-y-2">
				{#each live.activeIncidents as incident (incident.id)}
					<button
						type="button"
						class="group w-full rounded-[14px] border border-border-subtle bg-surface-1 p-4 text-left shadow-[var(--shadow-1)] transition-all hover:border-border-strong hover:shadow-[var(--shadow-2)]"
						onclick={() => openIncident(incident.id)}
					>
						<div class="flex items-start gap-3">
							<span
								class="mt-1 h-2 w-2 shrink-0 rounded-full"
								style="background: {sevColor(incident)}"
							></span>
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-baseline gap-x-2.5">
									<p class="text-sm font-semibold text-text-primary">{incident.title}</p>
									<span
										class="rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-wider"
										style="background: color-mix(in srgb, {sevColor(
											incident
										)} 14%, transparent); color: {sevColor(incident)}"
									>
										{incident.severity}
									</span>
									{#if incident.occurrences > 1}
										<span class="text-[11px] text-text-muted">×{incident.occurrences}</span>
									{/if}
								</div>
								{#if incident.summary}
									<p class="mt-0.5 line-clamp-1 text-xs text-text-muted">{incident.summary}</p>
								{/if}
								<p class="tnum mt-1.5 text-[11px] text-text-faint">
									Started {formatTime(incident.firstSeen)} · {formatDuration(
										(incident.resolvedAt ?? Date.now()) - incident.firstSeen
									)} ·
									{#if incident.rootCauseService}
										<span class="text-degraded">root cause: {incident.rootCauseService}</span>
									{:else}
										{incident.affectedServices.length} service{incident.affectedServices.length ===
										1
											? ''
											: 's'} affected
									{/if}
								</p>
							</div>
						</div>
					</button>
				{/each}
			</div>
		{/if}
	</section>

	<section>
		<h3
			class="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-text-faint"
		>
			<History size={12} aria-hidden="true" />
			History
		</h3>
		<Card padding={false}>
			{#if historyLoading}
				<div class="space-y-2 p-4">
					{#each Array(4) as _, i (i)}
						<div class="h-9 animate-pulse rounded-lg bg-surface-2"></div>
					{/each}
				</div>
			{:else if historyList.length === 0}
				<div class="p-6">
					<EmptyState
						title="No history yet"
						description="Resolved incidents will be archived here."
						neutral
					/>
				</div>
			{:else}
				<ul class="divide-y divide-border-subtle">
					{#each historyList as incident (incident.id)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-surface-2"
								onclick={() => openIncident(incident.id)}
							>
								<span
									class="h-1.5 w-1.5 shrink-0 rounded-full"
									style="background: {sevColor(incident)}"
								></span>
								<span
									class="min-w-0 flex-1 truncate text-[13px] {incident.status === 'active'
										? 'font-medium text-text-primary'
										: 'text-text-secondary'}"
								>
									{incident.title}
								</span>
								{#if incident.status === 'active'}
									<span
										class="rounded bg-critical-soft px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-critical"
										>active</span
									>
								{:else}
									<span class="tnum text-[11px] text-text-faint">
										{formatDateTime(incident.firstSeen)} → {formatDateTime(incident.resolvedAt)}
									</span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</Card>
	</section>
</div>

<Drawer
	open={detail !== null || detailLoading}
	title={detail?.title ?? 'Incident'}
	subtitle={detail ? `${detail.severity.toUpperCase()} · ${detail.status}` : undefined}
	onclose={closeDetail}
>
	{#if detail}
		<div class="space-y-5">
			<dl class="grid grid-cols-3 gap-3 text-center">
				<div class="rounded-xl border border-border-subtle bg-surface-2 p-3">
					<dt class="text-[11px] text-text-faint">Started</dt>
					<dd class="tnum mt-0.5 text-sm font-medium">{formatTime(detail.firstSeen)}</dd>
				</div>
				<div class="rounded-xl border border-border-subtle bg-surface-2 p-3">
					<dt class="text-[11px] text-text-faint">Duration</dt>
					<dd class="tnum mt-0.5 text-sm font-medium">
						{formatDuration((detail.resolvedAt ?? Date.now()) - detail.firstSeen)}
					</dd>
				</div>
				<div class="rounded-xl border border-border-subtle bg-surface-2 p-3">
					<dt class="text-[11px] text-text-faint">Occurrences</dt>
					<dd class="tnum mt-0.5 text-sm font-medium">{detail.occurrences}</dd>
				</div>
			</dl>

			{#if detail.rootCauseService}
				<div
					class="rounded-xl border px-3.5 py-3"
					style="border-color: color-mix(in srgb, var(--degraded) 35%, transparent); background: var(--degraded-soft)"
				>
					<p class="text-[10px] font-bold uppercase tracking-wider text-degraded">Root cause</p>
					<p class="mt-0.5 text-sm font-semibold text-text-primary">{detail.rootCauseService}</p>
					{#if detail.summary}
						<p class="mt-0.5 text-xs text-text-muted">{detail.summary}</p>
					{/if}
				</div>
			{/if}

			<div>
				<p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
					Affected
				</p>
				{#if detailGraph.nodes.length > 0}
					<div class="overflow-x-auto rounded-xl border border-border-subtle bg-surface-1 p-3">
						<TopologyView graph={detailGraph} compact />
					</div>
				{/if}
				<ul class="mt-2 space-y-1 text-[13px]">
					{#each detail.affectedServices as key (key)}
						<li class="flex items-center gap-2">
							<span class="text-text-muted">•</span>
							{live.serviceByKey(key)?.name ?? key}
						</li>
					{/each}
				</ul>
			</div>

			<div>
				<p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
					Timeline
				</p>
				<ol class="relative space-y-2.5 border-l border-border-subtle pl-4">
					{#each detail.timeline as entry, i (i)}
						<li class="relative">
							<span
								class="absolute -left-[21px] top-1.5 h-1.5 w-1.5 rounded-full {entry.severity ===
								'critical'
									? 'bg-critical'
									: entry.severity === 'warning'
										? 'bg-degraded'
										: 'bg-unknown'}"
							></span>
							<p class="text-xs text-text-secondary">
								<span class="tnum mr-2 text-text-faint">{formatTime(entry.at)}</span>
								{entry.message}
							</p>
						</li>
					{/each}
				</ol>
			</div>

			{#if detail.evidence.length > 0}
				<div>
					<p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
						Evidence
					</p>
					<div class="space-y-1 rounded-xl border border-border-subtle bg-surface-2 p-3">
						{#each detail.evidence as item, i (i)}
							<p class="font-mono text-[11px] leading-relaxed text-text-muted">
								<span class="tnum mr-2 text-text-faint">{formatTime(item.at)}</span>
								{item.message}
							</p>
						{/each}
					</div>
				</div>
			{/if}

			<button
				type="button"
				class="flex w-full items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-2 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
				onclick={() => viewRelatedLogs(detail!)}
			>
				<ScrollText size={13} aria-hidden="true" />
				View related logs
			</button>
		</div>
	{:else}
		<div class="flex h-32 items-center justify-center text-sm text-text-muted">
			Loading incident…
		</div>
	{/if}
</Drawer>
