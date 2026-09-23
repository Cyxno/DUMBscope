<script lang="ts">
	/**
	 * System → DUMBscope Runtime (§4/§5/§7/§11): DUMBscope observing itself.
	 * Current vital signs, small history graphs, robust trend estimates with
	 * labelled projections, reconciliation observability and the safety-net
	 * heartbeat. Refreshes on a slow, bounded cadence (15s) — sampling
	 * overhead is documented in docs/RELIABILITY.md.
	 */
	import { onMount } from 'svelte';
	import Card from '$lib/components/Card.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import { formatBytes } from '$lib/utils/format';

	interface RuntimeSample {
		at: number;
		rssBytes: number | null;
		heapUsedBytes: number | null;
		heapTotalBytes: number | null;
		externalBytes: number | null;
		arrayBuffersBytes: number | null;
		eventLoopLagMs: number | null;
		fds: number | null;
		workersActive: number | null;
		workersSpawned: number | null;
		workersTerminated: number | null;
		workersTimedOut: number | null;
		sseClients: number | null;
		dbBytes: number | null;
		walBytes: number | null;
		jobsActive: number | null;
		reconDurationMs: number | null;
		probeDurationMs: number | null;
		notifQueueDepth: number | null;
	}

	interface TrendView {
		current: number;
		baseline: number;
		change: number;
		ratePerHour: number;
		rateLabel: string;
		confidence: number;
		samples: number;
		projectionToThreshold: {
			at: number;
			hoursRemaining: number;
			threshold: number;
			estimate: true;
		} | null;
	}

	interface RuntimePayload {
		current: {
			sample: RuntimeSample | null;
			lag: { averageMs: number | null; maxMs: number | null };
			uptimeMs: number;
		};
		reconciliation: {
			lastAttempt: {
				at: number;
				status: string;
				durationMs: number;
				error: string | null;
				stats: Record<string, number> | null;
			} | null;
			lastSuccess: { at: number; durationMs: number; stats: Record<string, number> | null } | null;
			nextRunAt: number | null;
			running: boolean;
			recent: { at: number; status: string; durationMs: number }[];
		};
		safetyNet: { lastInspectedAt: number | null; lastResolvedCount: number };
		series: Record<string, { at: number; value: number }[]>;
		trends: Record<string, TrendView | null>;
	}

	let payload = $state<RuntimePayload | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;

	async function load() {
		try {
			const response = await fetch('/api/runtime?hours=26');
			if (response.ok) payload = (await response.json()) as RuntimePayload;
		} catch {
			// panel stays on its last good payload
		}
	}

	onMount(() => {
		void load();
		timer = setInterval(() => void load(), 15_000);
		return () => {
			if (timer) clearInterval(timer);
		};
	});

	const sample = $derived(payload?.current.sample ?? null);

	interface Stat {
		label: string;
		value: string;
		detail?: string;
		tone?: 'ok' | 'warn';
	}

	const stats = $derived.by<Stat[]>(() => {
		const s = sample;
		if (!s) return [];
		const out: Stat[] = [
			{
				label: 'Process RSS',
				value: formatBytes(s.rssBytes),
				detail: payload?.trends.rss?.rateLabel ?? undefined
			},
			{
				label: 'Heap used / total',
				value: `${formatBytes(s.heapUsedBytes)} / ${formatBytes(s.heapTotalBytes)}`
			},
			{
				label: 'External + buffers',
				value: formatBytes((s.externalBytes ?? 0) + (s.arrayBuffersBytes ?? 0))
			},
			{
				label: 'Event-loop lag',
				value: s.eventLoopLagMs !== null ? `${s.eventLoopLagMs} ms` : '—',
				detail:
					payload?.current.lag.maxMs != null ? `max ${payload.current.lag.maxMs} ms` : undefined
			},
			{
				label: 'Worker threads',
				value: `${s.workersActive ?? 0} active`,
				detail: `${s.workersSpawned ?? 0} spawned · ${s.workersTimedOut ?? 0} timed out`
			},
			{
				label: 'Open file descriptors',
				value: s.fds !== null ? String(s.fds) : 'n/a (not Linux)',
				detail: payload?.trends.fds?.rateLabel ?? undefined
			},
			{ label: 'SSE clients', value: String(s.sseClients ?? 0) },
			{
				label: 'SQLite DB / WAL',
				value: `${formatBytes(s.dbBytes)} / ${formatBytes(s.walBytes)}`
			},
			{ label: 'Scheduled jobs', value: String(s.jobsActive ?? 0) },
			{ label: 'Notification queue', value: String(s.notifQueueDepth ?? 0) },
			{ label: 'Uptime', value: formatUptime(payload?.current.uptimeMs ?? 0) }
		];
		return out;
	});

	function formatUptime(ms: number): string {
		const minutes = Math.floor(ms / 60_000);
		if (minutes < 60) return `${minutes} min`;
		const hours = Math.floor(minutes / 60);
		if (hours < 48) return `${hours} h ${minutes % 60} min`;
		return `${Math.floor(hours / 24)} d ${hours % 24} h`;
	}

	function sparkline(key: string): number[] {
		return (payload?.series[key] ?? []).map((p) => p.value);
	}

	const reconStatusColor: Record<string, string> = {
		ok: 'var(--healthy)',
		failed: 'var(--critical)',
		timeout: 'var(--critical)',
		'skipped-incomplete': 'var(--degraded)',
		disabled: 'var(--unknown)'
	};

	const statusLabel: Record<string, string> = {
		ok: 'successful',
		failed: 'failed',
		timeout: 'aborted at the hard deadline',
		'skipped-incomplete': 'skipped — incomplete Arr data',
		disabled: 'disabled'
	};
</script>

<Card
	title="DUMBscope runtime"
	subtitle="Self-observability: process vitals, leak signatures and reconciliation health"
>
	{#if !sample}
		<p class="px-1 pb-2 text-xs text-text-muted">Collecting the first runtime samples…</p>
	{:else}
		<div class="grid grid-cols-2 gap-2 md:grid-cols-4">
			{#each stats as stat (stat.label)}
				<div class="rounded-xl border border-border-subtle bg-surface-2 px-3 py-2.5">
					<p class="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
						{stat.label}
					</p>
					<p class="tnum mt-0.5 text-sm font-semibold text-text-primary">{stat.value}</p>
					{#if stat.detail}
						<p class="tnum mt-0.5 text-[10px] text-text-faint">{stat.detail}</p>
					{/if}
				</div>
			{/each}
		</div>

		<div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
			<div class="rounded-xl border border-border-subtle p-3">
				<div class="flex items-baseline justify-between">
					<p class="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
						Process memory (26h)
					</p>
					{#if payload?.trends.rss}
						<p
							class="tnum text-[11px] {Math.abs(payload.trends.rss.ratePerHour) > 32 * 1024 ** 2
								? 'text-degraded'
								: 'text-text-faint'}"
						>
							{payload.trends.rss.rateLabel} · baseline {formatBytes(payload.trends.rss.baseline)}
						</p>
					{/if}
				</div>
				<Sparkline data={sparkline('rss')} height={44} color="var(--accent)" />
				{#if payload?.trends.rss?.projectionToThreshold}
					<p class="tnum text-[10px] text-text-faint">
						Estimate: reaches {formatBytes(payload.trends.rss.projectionToThreshold.threshold)} in ~{payload
							.trends.rss.projectionToThreshold.hoursRemaining}h at the current trend.
					</p>
				{/if}
			</div>
			<div class="rounded-xl border border-border-subtle p-3">
				<div class="flex items-baseline justify-between">
					<p class="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
						Event-loop lag (26h)
					</p>
					{#if payload?.trends.lag}
						<p class="tnum text-[11px] text-text-faint">
							now {Math.round(payload.trends.lag.current)} ms · baseline {Math.round(
								payload.trends.lag.baseline
							)} ms
						</p>
					{/if}
				</div>
				<Sparkline data={sparkline('lag')} height={44} color="var(--chart-2, var(--accent))" />
			</div>
			<div class="rounded-xl border border-border-subtle p-3">
				<div class="flex items-baseline justify-between">
					<p class="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
						File descriptors (26h)
					</p>
					{#if payload?.trends.fds}
						<p
							class="tnum text-[11px] {Math.abs(payload.trends.fds.ratePerHour) > 20
								? 'text-degraded'
								: 'text-text-faint'}"
						>
							{payload.trends.fds.rateLabel}
						</p>
					{/if}
				</div>
				<Sparkline data={sparkline('fds')} height={44} color="var(--degraded)" />
			</div>
			<div class="rounded-xl border border-border-subtle p-3">
				<div class="flex items-baseline justify-between">
					<p class="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
						Reconciliation duration (26h)
					</p>
					{#if payload?.trends.recon}
						<p class="tnum text-[11px] text-text-faint">
							last {Math.round(payload.trends.recon.current / 1000)}s · median {Math.round(
								payload.trends.recon.baseline / 1000
							)}s
						</p>
					{/if}
				</div>
				<Sparkline data={sparkline('recon')} height={44} color="var(--chart-2, var(--accent))" />
			</div>
		</div>

		<div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
			<div class="rounded-xl border border-border-subtle bg-surface-2 px-3 py-2.5">
				<p class="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
					Library reconciliation
				</p>
				<ul class="tnum mt-1 space-y-1 text-xs text-text-secondary">
					<li class="flex justify-between">
						<span class="text-text-muted">Last attempted</span>
						<span>
							{#if payload?.reconciliation.lastAttempt}
								<span
									style="color: {reconStatusColor[payload.reconciliation.lastAttempt.status] ??
										'var(--unknown)'}"
								>
									{statusLabel[payload.reconciliation.lastAttempt.status] ??
										payload.reconciliation.lastAttempt.status}
								</span>
								· {Math.round(payload.reconciliation.lastAttempt.durationMs / 100) / 10}s ago
							{:else}
								—
							{/if}
						</span>
					</li>
					<li class="flex justify-between">
						<span class="text-text-muted">Last successful</span>
						<span
							>{payload?.reconciliation.lastSuccess
								? `${Math.round(payload.reconciliation.lastSuccess.durationMs / 100) / 10}s run`
								: '—'}</span
						>
					</li>
					<li class="flex justify-between">
						<span class="text-text-muted">Next scheduled</span>
						<span
							>{payload?.reconciliation.nextRunAt
								? new Date(payload.reconciliation.nextRunAt).toLocaleTimeString()
								: '—'}</span
						>
					</li>
					{#if payload?.reconciliation.lastSuccess?.stats}
						{@const s = payload.reconciliation.lastSuccess.stats}
						<li class="flex justify-between">
							<span class="text-text-muted">Last cycle verdicts</span>
							<span
								>{s.arrChecked ?? 0} Arr · {s.plexChecked ?? 0} Plex · {s.brokenSymlinks ?? 0} broken
								· {s.plexGhosts ?? 0} ghosts · {s.pathsUnverifiable ?? 0} unverifiable</span
							>
						</li>
					{/if}
					{#if payload?.reconciliation.lastAttempt?.error}
						<li class="text-[11px] text-degraded">{payload.reconciliation.lastAttempt.error}</li>
					{/if}
				</ul>
			</div>
			<div class="rounded-xl border border-border-subtle bg-surface-2 px-3 py-2.5">
				<p class="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
					Lifecycle safety net
				</p>
				<ul class="tnum mt-1 space-y-1 text-xs text-text-secondary">
					<li class="flex justify-between">
						<span class="text-text-muted">Last integrity pass</span>
						<span
							>{payload?.safetyNet.lastInspectedAt
								? new Date(payload.safetyNet.lastInspectedAt).toLocaleTimeString()
								: '—'}</span
						>
					</li>
					<li class="flex justify-between">
						<span class="text-text-muted">Retired as obsolete last pass</span>
						<span>{payload?.safetyNet.lastResolvedCount ?? 0}</span>
					</li>
					<li class="flex justify-between">
						<span class="text-text-muted">Worker reclaims</span>
						<span>{sample.workersTerminated ?? 0} · {sample.workersTimedOut ?? 0} timed out</span>
					</li>
				</ul>
				<p class="mt-1.5 text-[10px] leading-relaxed text-text-faint">
					Trend numbers are robust regression estimates (Theil–Sen) — projections are labelled
					estimates and omitted when confidence is insufficient.
				</p>
			</div>
		</div>
	{/if}
</Card>
