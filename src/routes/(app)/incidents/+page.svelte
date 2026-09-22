<script lang="ts">
	import { live } from '$lib/stores/live.svelte';
	import Card from '$lib/components/Card.svelte';
	import Drawer from '$lib/components/Drawer.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { formatDuration, formatTime, formatDateTime, relativeTime } from '$lib/utils/format';
	import { goto } from '$app/navigation';
	import { pipelineModelFromLive, pipelineMetaForKey } from '$lib/pipeline/from-live';
	import { page } from '$app/state';
	import { ScrollText, History, Check, Archive, ArchiveRestore, ChevronDown } from '@lucide/svelte';
	import type { Incident, IncidentCounts } from '$lib/types';

	type Tab = 'active' | 'acknowledged' | 'resolved' | 'archived';

	let tab = $state<Tab>('active');
	let detail = $state<Incident | null>(null);
	let detailLoading = $state(false);
	let historyList = $state<Incident[]>([]);
	let historyLoading = $state(true);
	let clearOpen = $state(false);

	$effect(() => {
		const target = page.url.searchParams.get('incident');
		if (target) void openIncident(target);
	});

	async function loadHistory() {
		historyLoading = true;
		try {
			const status = tab === 'archived' ? 'archived' : tab === 'resolved' ? 'resolved' : 'open';
			const response = await fetch(`/api/incidents?status=${status}&limit=100`);
			if (response.ok) {
				const data = (await response.json()) as {
					incidents: Incident[];
					counts: IncidentCounts;
				};
				historyList = data.incidents.filter((i) => i.status === tab);
				// Authoritative counts on load; SSE keeps them fresh afterwards.
				live.incidentCounts = data.counts;
			}
		} finally {
			historyLoading = false;
		}
	}

	$effect(() => {
		void tab;
		void loadHistory();
	});
	// Keep history views live: when the open set changes (an incident resolved
	// or was acknowledged while watching), refresh the counts and the list.
	$effect(() => {
		void live.incidentCounts;
		const timer = setTimeout(() => void loadHistory(), 400);
		return () => clearTimeout(timer);
	});

	// Keep the open drawer live.
	$effect(() => {
		if (!detail) return;
		const updated = live.activeIncidents.find((i) => i.id === detail!.id);
		if (updated) {
			detail = updated;
		} else if (detail.status === 'active' || detail.status === 'acknowledged') {
			// The incident left the open set (resolved/rearchived) — pull its
			// resolved state so the drawer reflects recovery live, no reload.
			void fetch(`/api/incidents/${detail.id}`).then(async (r) => {
				if (r.ok) {
					const data = (await r.json()) as { incident: Incident };
					detail = data.incident;
				}
			});
		}
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

	async function act(incident: Incident, action: 'acknowledge' | 'unacknowledge' | 'archive') {
		const response = await fetch(`/api/incidents/${incident.id}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action })
		});
		if (response.ok) {
			const data = (await response.json()) as { incident: Incident };
			// Update the drawer only when it is already showing this incident —
			// row-level actions must not pop the drawer open over the list.
			if (detail?.id === data.incident.id) detail = data.incident;
			applyLocal(data.incident);
			void loadHistory();
		}
	}

	/**
	 * Apply an operator action to the local live store immediately — SSE also
	 * carries the change, but this keeps this tab's list instant and correct
	 * even if the socket is mid-reconnect.
	 */
	function applyLocal(updated: Incident) {
		const idx = live.activeIncidents.findIndex((i) => i.id === updated.id);
		const open = updated.status === 'active' || updated.status === 'acknowledged';
		if (open) {
			if (idx >= 0) live.activeIncidents[idx] = updated;
			else live.activeIncidents.push(updated);
		} else if (idx >= 0) {
			live.activeIncidents.splice(idx, 1);
		}
	}

	async function clearResolved(olderThanHours: number | null) {
		clearOpen = false;
		await fetch('/api/incidents/clear-resolved', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ olderThanHours })
		});
		void loadHistory();
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

	/** Root cause + affected services with canonical pipeline identity. */
	const detailChips = $derived.by(() => {
		const incident = detail;
		if (!incident) return [];
		const model = pipelineModelFromLive();
		const chips: { key: string; name: string; descriptor: string; root: boolean }[] = [];
		const seen = new Set<string>();
		const push = (key: string, root: boolean) => {
			if (seen.has(key)) return;
			const meta = pipelineMetaForKey(model, key);
			seen.add(key);
			chips.push({
				key,
				name: meta?.name ?? live.serviceByKey(key)?.name ?? key,
				descriptor: meta?.descriptor ?? 'Service',
				root
			});
		};
		for (const key of incident.affectedServices) push(key, false);
		if (incident.rootCauseService) {
			const root = live.topology.nodes.find(
				(n) => n.key === incident.rootCauseService || n.name === incident.rootCauseService
			);
			if (root) push(root.key, true);
		}
		return chips;
	});

	/**
	 * Incidents grouped under their correlated root (evidence-based only).
	 * Children whose root is not in the current view render top-level so
	 * nothing silently disappears.
	 */
	const groups = $derived.by(() => {
		const open = tab === 'active' || tab === 'acknowledged' ? live.activeIncidents : historyList;
		// Each tab shows only its own status; both are open problems but the
		// Active view stays the "needs attention right now" list.
		const list = open.filter((i) =>
			tab === 'acknowledged' ? i.status === 'acknowledged' : i.status === 'active'
		);
		const fingerprints = new Set(list.map((i) => i.fingerprint));
		const roots: Incident[] = [];
		const children = new Map<string, Incident[]>();
		for (const incident of list) {
			if (
				incident.rootCauseFingerprint &&
				(!fingerprints.has(incident.rootCauseFingerprint) ||
					incident.rootCauseFingerprint === incident.fingerprint)
			) {
				roots.push(incident);
				continue;
			}
			if (incident.rootCauseFingerprint) {
				const list2 = children.get(incident.rootCauseFingerprint) ?? [];
				list2.push(incident);
				children.set(incident.rootCauseFingerprint, list2);
			} else {
				roots.push(incident);
			}
		}
		/** Children whose root is absent from this view: rendered top-level. */
		const orphans: Incident[] = [];
		for (const [fp, list2] of children) {
			if (!fingerprints.has(fp)) orphans.push(...list2);
		}
		return { roots, children, orphans };
	});

	const resolutionBadge = (incident: Incident): { label: string; tone: string } | null => {
		if (incident.status !== 'resolved' && incident.status !== 'archived') return null;
		if (incident.resolutionKind === 'obsolete') {
			return {
				label: `resolved — ${incident.resolutionReason ?? 'no longer applicable'}`,
				tone: 'var(--unknown)'
			};
		}
		if (incident.resolutionKind === 'operator') {
			return { label: 'archived by operator', tone: 'var(--unknown)' };
		}
		return { label: 'recovered — verified by detector', tone: 'var(--healthy)' };
	};

	const statusTabs: { id: Tab; label: string; count: number }[] = $derived([
		{ id: 'active', label: 'Active', count: live.incidentCounts.active },
		{ id: 'acknowledged', label: 'Acknowledged', count: live.incidentCounts.acknowledged },
		{ id: 'resolved', label: 'Resolved', count: live.incidentCounts.resolved },
		{ id: 'archived', label: 'Archived', count: 0 }
	]);
</script>

<div class="mx-auto max-w-[1100px] space-y-5 px-4 py-6 md:px-8">
	<header class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h2 class="text-lg font-semibold tracking-tight">Incidents</h2>
			<p class="mt-0.5 text-[13px] text-text-muted">
				What requires attention right now — deduplicated, correlated, honestly resolved.
			</p>
		</div>
		<p class="tnum text-[11px] text-text-faint">
			<span class="text-critical">{live.incidentCounts.active} active</span>
			<span class="mx-1.5">·</span>
			<span class="text-degraded">{live.incidentCounts.acknowledged} acknowledged</span>
			<span class="mx-1.5">·</span>
			<span>{live.incidentCounts.resolved} resolved</span>
		</p>
	</header>

	<nav class="flex items-center gap-1" aria-label="Incident status filters">
		{#each statusTabs as t (t.id)}
			<button
				type="button"
				class="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors {tab ===
				t.id
					? 'bg-surface-3 text-text-primary'
					: 'text-text-muted hover:bg-surface-2 hover:text-text-secondary'}"
				onclick={() => (tab = t.id)}
				aria-pressed={tab === t.id}
			>
				{t.label}
				{#if t.id === 'archived'}
					<span class="tnum text-[10px] text-text-faint">{historyList.length}</span>
				{:else if t.count > 0}
					<span
						class="tnum rounded-full px-1.5 text-[10px] font-bold {t.id === 'active'
							? 'bg-critical-soft text-critical'
							: t.id === 'acknowledged'
								? 'bg-degraded-soft text-degraded'
								: 'bg-surface-3 text-text-muted'}">{t.count}</span
					>
				{/if}
			</button>
		{/each}
	</nav>

	{#if tab === 'active' || tab === 'acknowledged'}
		<section data-testid="open-incidents">
			{#if groups.roots.length === 0}
				<EmptyState
					title={tab === 'active' ? 'All clear' : 'Nothing acknowledged'}
					description={tab === 'active'
						? 'No incidents detected. Your stack is operating normally.'
						: 'Acknowledged incidents appear here until DUMBscope verifies their recovery.'}
				/>
			{:else}
				<div class="space-y-2">
					{#each groups.roots as incident (incident.id)}
						{@render IncidentRow(incident)}
						{#if groups.children.get(incident.fingerprint)?.length}
							<div class="ml-6 space-y-2 border-l border-border-subtle pl-3">
								{#each groups.children.get(incident.fingerprint)! as child (child.id)}
									{@render IncidentRow(child)}
								{/each}
							</div>
						{/if}
					{/each}
					{#each groups.orphans as orphan (orphan.id)}
						{@render IncidentRow(orphan)}
					{/each}
				</div>
			{/if}
		</section>
	{:else}
		<section>
			<div class="mb-2 flex items-center justify-between">
				<h3
					class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-text-faint"
				>
					<History size={12} aria-hidden="true" />
					{tab === 'resolved' ? 'Resolved history' : 'Archived history'}
				</h3>
				{#if tab === 'resolved' && historyList.length > 0}
					<div class="relative">
						<button
							type="button"
							class="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-1 px-2.5 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
							onclick={() => (clearOpen = !clearOpen)}
						>
							<ArchiveRestore size={12} aria-hidden="true" />
							Clear resolved
							<ChevronDown size={11} aria-hidden="true" />
						</button>
						{#if clearOpen}
							<div
								class="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded-xl border border-border-subtle bg-surface-1 shadow-[var(--shadow-2)]"
							>
								{#each [{ label: 'All resolved', hours: null }, { label: 'Older than 24h', hours: 24 }, { label: 'Older than 7 days', hours: 24 * 7 }, { label: 'Older than 30 days', hours: 24 * 30 }] as option (option.label)}
									<button
										type="button"
										class="block w-full px-3 py-2 text-left text-xs text-text-secondary hover:bg-surface-2 hover:text-text-primary"
										onclick={() => clearResolved(option.hours)}
									>
										{option.label}
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{/if}
			</div>
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
							title={tab === 'resolved' ? 'No resolved incidents' : 'Nothing archived'}
							description={tab === 'resolved'
								? 'Resolved incidents are kept here as history.'
								: 'Cleared incidents are archived here, never deleted.'}
							neutral
						/>
					</div>
				{:else}
					<ul class="divide-y divide-border-subtle" data-testid="history-list">
						{#each historyList as incident (incident.id)}
							<li class="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2">
								<button
									type="button"
									class="flex min-w-0 flex-1 items-center gap-3 text-left"
									onclick={() => openIncident(incident.id)}
								>
									<span
										class="h-1.5 w-1.5 shrink-0 rounded-full"
										style="background: {sevColor(incident)}"
									></span>
									<span class="min-w-0 flex-1 truncate text-[13px] text-text-secondary">
										{incident.title}
									</span>
									{#if incident.occurrences > 1}
										<span class="tnum text-[11px] text-text-faint">×{incident.occurrences}</span>
									{/if}
									<span class="tnum shrink-0 text-[11px] text-text-faint">
										{formatDateTime(incident.firstSeen)} → {formatDateTime(incident.resolvedAt)}
									</span>
								</button>
								{#if tab === 'resolved'}
									<button
										type="button"
										data-testid="row-archive"
										class="shrink-0 rounded-lg border border-border-subtle px-2 py-1 text-[10px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary"
										onclick={() => act(incident, 'archive')}
									>
										Archive
									</button>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</Card>
		</section>
	{/if}
</div>

{#snippet IncidentRow(incident: Incident)}
	<div
		data-testid="incident-row"
		data-incident-status={incident.status}
		class="group rounded-[14px] border border-border-subtle bg-surface-1 p-4 shadow-[var(--shadow-1)] transition-all hover:border-border-strong hover:shadow-[var(--shadow-2)] {incident.status ===
		'acknowledged'
			? 'opacity-70'
			: ''}"
	>
		<div class="flex items-start gap-3">
			<button
				type="button"
				class="flex min-w-0 flex-1 items-start gap-3 text-left"
				onclick={() => openIncident(incident.id)}
			>
				<span class="mt-1 h-2 w-2 shrink-0 rounded-full" style="background: {sevColor(incident)}"
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
						{#if incident.status === 'acknowledged'}
							<span
								class="rounded bg-degraded-soft px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-degraded"
							>
								acknowledged
							</span>
						{/if}
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
						{:else if groups.children.get(incident.fingerprint)?.length}
							<span class="text-degraded"
								>{groups.children.get(incident.fingerprint)!.length} downstream finding{groups.children.get(
									incident.fingerprint
								)!.length === 1
									? ''
									: 's'}</span
							>
						{:else}
							{incident.affectedServices.length} service{incident.affectedServices.length === 1
								? ''
								: 's'} affected
						{/if}
					</p>
				</div>
			</button>
			{#if incident.status === 'active'}
				<button
					type="button"
					data-testid="row-acknowledge"
					class="shrink-0 rounded-lg border border-border-subtle px-2 py-1 text-[10px] font-medium text-text-muted transition-colors hover:border-border-strong hover:text-text-primary"
					onclick={() => act(incident, 'acknowledge')}
				>
					Acknowledge
				</button>
			{/if}
		</div>
	</div>
{/snippet}

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

			{@render ResolutionBanner(detail)}
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

			{#if detailChips.length > 0}
				<div>
					<p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint">
						Affected
					</p>
					<ul class="space-y-1.5">
						{#each detailChips as chip (chip.key)}
							<li class="flex items-baseline gap-2">
								<span
									class="size-1.5 shrink-0 translate-y-[-1px] rounded-full {chip.root
										? 'bg-critical'
										: 'bg-degraded'}"
								></span>
								<span class="text-[13px] font-medium text-text-primary">{chip.name}</span>
								<span class="text-[11px] text-text-faint"
									>{chip.root ? 'likely root cause' : chip.descriptor}</span
								>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			<p class="tnum text-[11px] text-text-faint">
				Detector: {detail.detector || 'legacy'} ·
				{#if detail.status === 'active' || detail.status === 'acknowledged'}
					{detail.lastEvaluatedAt
						? `last evaluated ${relativeTime(detail.lastEvaluatedAt)}`
						: 'not yet evaluated'}
					·
				{/if}
				{detail.lastEvidenceAt
					? `last evidence ${relativeTime(detail.lastEvidenceAt)}`
					: 'no evidence recorded'}
			</p>

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

			<div class="flex gap-2">
				{#if detail.status === 'active'}
					<button
						type="button"
						class="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-2 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
						onclick={() => act(detail!, 'acknowledge')}
					>
						<Check size={13} aria-hidden="true" />
						Acknowledge
					</button>
				{:else if detail.status === 'acknowledged'}
					<button
						type="button"
						class="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-2 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
						onclick={() => act(detail!, 'unacknowledge')}
					>
						<Check size={13} aria-hidden="true" />
						Unacknowledge
					</button>
				{:else if detail.status === 'resolved'}
					<button
						type="button"
						class="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-2 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
						onclick={() => act(detail!, 'archive')}
					>
						<Archive size={13} aria-hidden="true" />
						Archive
					</button>
				{/if}
				<button
					type="button"
					class="flex flex-1 items-center justify-center gap-2 rounded-lg border border-border-subtle bg-surface-2 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
					onclick={() => viewRelatedLogs(detail!)}
				>
					<ScrollText size={13} aria-hidden="true" />
					View related logs
				</button>
			</div>
		</div>
	{:else}
		<div class="flex h-32 items-center justify-center text-sm text-text-muted">
			Loading incident…
		</div>
	{/if}
</Drawer>

{#snippet ResolutionBanner(incident: Incident)}
	{#if resolutionBadge(incident)}
		<div
			class="rounded-xl border px-3.5 py-2.5"
			style="border-color: color-mix(in srgb, {resolutionBadge(incident)!
				.tone} 30%, transparent); background: color-mix(in srgb, {resolutionBadge(incident)!
				.tone} 8%, transparent)"
		>
			<p
				class="text-[10px] font-bold uppercase tracking-wider"
				style="color: {resolutionBadge(incident)!.tone}"
			>
				{incident.status === 'archived' ? 'Archived' : 'Resolved'}
			</p>
			<p class="mt-0.5 text-xs text-text-secondary">{resolutionBadge(incident)!.label}</p>
		</div>
	{/if}
{/snippet}

<style>
	span[role='button'] {
		cursor: pointer;
	}
</style>
