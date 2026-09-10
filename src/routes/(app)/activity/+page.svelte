<script lang="ts">
	/**
	 * Activity v0.2 (brief §2/§6/§9): live operational timeline combining
	 * observed DUMB events with semantic deep-integration events. Filters run
	 * client-side over a capped buffer; polling refreshes in place.
	 */
	import Card from '$lib/components/Card.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { formatTime } from '$lib/utils/format';
	import { History, Search } from '@lucide/svelte';

	interface FeedEntry {
		id: string | number;
		at: number;
		source: string;
		serviceKey: string | null;
		category: string;
		title: string;
		detail: string | null;
		severity: string | null;
		observed: boolean;
	}

	const CATEGORIES = [
		{ id: 'all', label: 'All' },
		{ id: 'request', label: 'Requests' },
		{ id: 'search', label: 'Search' },
		{ id: 'grab', label: 'Grabbed' },
		{ id: 'download', label: 'Downloads' },
		{ id: 'import', label: 'Imports' },
		{ id: 'library', label: 'Library' },
		{ id: 'playback', label: 'Playback' },
		{ id: 'health', label: 'Health' },
		{ id: 'system', label: 'System' }
	];

	let entries = $state<FeedEntry[]>([]);
	let loading = $state(true);
	let category = $state('all');
	let serviceFilter = $state('all');
	let query = $state('');
	let onlyIssues = $state(false);
	let timer: ReturnType<typeof setInterval> | undefined;

	async function load() {
		try {
			const response = await fetch('/api/activity?limit=200');
			if (response.ok) {
				const data = (await response.json()) as { entries: FeedEntry[] };
				entries = data.entries;
			}
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void load();
		timer = setInterval(() => void load(), 15_000);
		return () => clearInterval(timer);
	});

	const services = $derived([...new Set(entries.map((e) => e.source))].sort());

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		return entries.filter((e) => {
			if (category !== 'all' && e.category !== category) return false;
			if (serviceFilter !== 'all' && e.source !== serviceFilter) return false;
			if (onlyIssues && (e.severity ?? 'info') === 'info') return false;
			if (q && !`${e.title} ${e.detail ?? ''} ${e.source}`.toLowerCase().includes(q)) return false;
			return true;
		});
	});

	function categoryColor(cat: string): string {
		switch (cat) {
			case 'grab':
			case 'download':
				return 'var(--live)';
			case 'import':
			case 'library':
				return 'var(--healthy)';
			case 'playback':
				return 'var(--accent)';
			case 'health':
				return 'var(--degraded)';
			case 'request':
			case 'search':
				return 'var(--text-secondary)';
			default:
				return 'var(--unknown)';
		}
	}

	function severityColor(sev: string | null): string {
		if (sev === 'critical') return 'var(--critical)';
		if (sev === 'warning') return 'var(--degraded)';
		return 'var(--text-primary)';
	}
</script>

<div class="mx-auto max-w-[860px] space-y-5 px-4 py-6 md:px-8">
	<header>
		<h2 class="text-lg font-semibold tracking-tight">Activity</h2>
		<p class="mt-0.5 text-[13px] text-text-muted">
			Live view of your media stack — observed facts and integration events.
		</p>
	</header>

	<div class="flex flex-wrap items-center gap-1.5">
		{#each CATEGORIES as cat (cat.id)}
			<button
				type="button"
				class="rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors {category ===
				cat.id
					? 'border-accent bg-accent-soft text-text-primary'
					: 'border-border-subtle text-text-muted hover:border-border-strong hover:text-text-primary'}"
				onclick={() => (category = cat.id)}
			>
				{cat.label}
			</button>
		{/each}
		<div class="ml-auto flex items-center gap-1.5">
			<div class="relative">
				<Search size={12} class="pointer-events-none absolute top-2 left-2 text-text-faint" />
				<input
					type="search"
					bind:value={query}
					placeholder="Search…"
					class="h-7 w-36 rounded-lg border border-border-subtle bg-surface-2 pl-7 text-[11px] text-text-primary outline-none focus:border-border-focus"
				/>
			</div>
			<select
				bind:value={serviceFilter}
				class="h-7 rounded-lg border border-border-subtle bg-surface-2 px-1.5 text-[11px] text-text-secondary outline-none focus:border-border-focus"
			>
				<option value="all">All sources</option>
				{#each services as s (s)}
					<option value={s}>{s}</option>
				{/each}
			</select>
			<button
				type="button"
				class="rounded-lg border px-2 py-1 text-[11px] transition-colors {onlyIssues
					? 'border-degraded bg-degraded-soft text-degraded'
					: 'border-border-subtle text-text-muted hover:text-text-primary'}"
				onclick={() => (onlyIssues = !onlyIssues)}
			>
				Issues
			</button>
		</div>
	</div>

	<Card padding={false}>
		{#if loading}
			<div class="space-y-2 p-4">
				{#each Array(6) as _, i (i)}
					<div class="h-8 animate-pulse rounded-lg bg-surface-2"></div>
				{/each}
			</div>
		{:else if filtered.length === 0}
			<div class="p-6">
				<EmptyState
					icon={History}
					title={entries.length === 0 ? 'No activity yet' : 'Nothing matches these filters'}
					description="Media grabs, imports, playback and health events appear here as they happen."
					neutral
				/>
			</div>
		{:else}
			<ol class="divide-y divide-border-subtle">
				{#each filtered as entry (entry.id)}
					<li class="flex items-start gap-3 px-4 py-2.5">
						<span
							class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
							style="background: {severityColor(entry.severity) === 'var(--text-primary)'
								? categoryColor(entry.category)
								: severityColor(entry.severity)}"
						></span>
						<p class="min-w-0 flex-1 text-[13px]">
							<span class="tnum mr-2.5 text-[11px] text-text-faint">{formatTime(entry.at)}</span>
							<span
								class="{entry.severity === 'warning' || entry.severity === 'critical'
									? 'font-medium'
									: ''} {severityColor(entry.severity) === 'var(--critical)'
									? 'text-critical'
									: 'text-text-secondary'}"
							>
								{entry.title}
							</span>
							{#if entry.detail}
								<span class="block pl-0.5 text-[11px] text-text-faint">{entry.detail}</span>
							{/if}
						</p>
						<span
							class="shrink-0 rounded bg-surface-2 px-1.5 py-px text-[10px] capitalize text-text-faint"
						>
							{entry.source.split('-')[0]}
						</span>
					</li>
				{/each}
			</ol>
		{/if}
	</Card>

	<p class="text-[11px] text-text-faint">
		Showing {filtered.length} of {entries.length} events · auto-refreshes every 15s · retention 14 days.
	</p>
</div>
