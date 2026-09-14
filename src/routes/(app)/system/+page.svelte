<script lang="ts">
	import { live } from '$lib/stores/live.svelte';
	import Card from '$lib/components/Card.svelte';
	import AreaChart from '$lib/components/AreaChart.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { formatBytes, formatPercent, relativeTime } from '$lib/utils/format';
	import { CONNECTION_LABELS } from '$lib/utils/status';
	import type { MountHealth, MemoryAnomalyLevel } from '$lib/types';
	import {
		Cpu,
		MemoryStick,
		HardDrive,
		ArrowDownUp,
		HardDriveDownload,
		TriangleAlert,
		RefreshCw,
		Repeat2
	} from '@lucide/svelte';
	import type { MediaFlowItem } from '$lib/types';

	const mounts = $derived(live.reliability.mounts);
	const memoryViews = $derived(live.reliability.memory);

	let confirmTarget = $state<string | null>(null);
	let confirmBusy = $state(false);
	let actionMessage = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);

	const mediaItems = $derived(live.mediaFlow.items);
	const mediaMetrics = $derived(live.mediaFlow.metrics);
	const recommendations = $derived(live.mediaFlow.recommendations);
	const recentActions = $derived(live.mediaFlow.actions);

	async function requestRestart(target: string) {
		confirmBusy = true;
		actionMessage = null;
		try {
			const res = await fetch('/api/reliability/actions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ target })
			});
			const data = (await res.json()) as { error?: string; state?: string };
			if (res.ok) {
				actionMessage = {
					kind: 'ok',
					text: 'Restart accepted for ' + target + ' — DUMBscope will verify recovery.'
				};
			} else {
				actionMessage = { kind: 'error', text: data.error ?? 'Action rejected.' };
			}
		} finally {
			confirmBusy = false;
			confirmTarget = null;
		}
	}

	function flowSummaryColor(item: MediaFlowItem): string {
		switch (item.summary) {
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
	}

	function mountColor(state: MountHealth): string {
		switch (state) {
			case 'healthy':
				return 'var(--healthy)';
			case 'slow':
			case 'degraded':
				return 'var(--degraded)';
			case 'unresponsive':
			case 'read-error':
				return 'var(--critical)';
			case 'missing':
				return 'var(--degraded)';
			default:
				return 'var(--unknown)';
		}
	}

	function memoryColor(level: MemoryAnomalyLevel): string {
		switch (level) {
			case 'critical':
				return 'var(--critical)';
			case 'warning':
				return 'var(--degraded)';
			default:
				return 'var(--text-muted)';
		}
	}

	function signed(bytes: number | null): string {
		if (bytes === null) return '—';
		const sign = bytes >= 0 ? '+' : '−';
		return `${sign}${formatBytes(Math.abs(bytes))}`;
	}

	let hours = $state(1);
	let remotePoints = $state<
		{ t: number; cpu: number | null; mem: number | null; disk: number | null }[] | null
	>(null);
	let loading = $state(false);

	async function loadRange() {
		if (hours <= 1) {
			remotePoints = null;
			return;
		}
		loading = true;
		try {
			const response = await fetch(`/api/metrics/history?hours=${hours}&points=600`);
			if (response.ok) {
				const data = (await response.json()) as { points: typeof remotePoints };
				remotePoints = data.points;
			}
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void loadRange();
	});

	const points = $derived.by(() => {
		if (hours > 1 && remotePoints) return remotePoints;
		return live.metricsHistory.map((p) => ({ t: p.t, cpu: p.cpu, mem: p.mem, disk: p.disk }));
	});

	const cpuPoints = $derived(points.map((p) => ({ t: p.t, v: p.cpu })));
	const memPoints = $derived(points.map((p) => ({ t: p.t, v: p.mem })));
	const diskPoints = $derived(points.map((p) => ({ t: p.t, v: p.disk })));

	const metrics = $derived(live.metrics);
	const nets = $derived(metrics?.network ?? []);
	const dbs = $derived(metrics?.databaseHealth ?? []);

	const conn = $derived(live.connection);
	const layerRows = $derived.by(() => {
		const colorFor = (status: string) =>
			status === 'ok' || status === 'live'
				? 'var(--healthy)'
				: status === 'failed' || status === 'offline' || status === 'credentials-invalid'
					? 'var(--critical)'
					: 'var(--degraded)';
		return [
			{
				name: 'HTTP',
				value: conn.probes.http.status,
				detail: conn.probes.http.detail,
				color: colorFor(conn.probes.http.status)
			},
			{
				name: 'Auth',
				value: conn.probes.auth.status,
				detail: conn.probes.auth.detail,
				color: colorFor(conn.probes.auth.status)
			},
			{
				name: 'REST',
				value: conn.probes.rest.status,
				detail: conn.probes.rest.detail,
				color: colorFor(conn.probes.rest.status)
			},
			{
				name: 'Status stream',
				value: conn.streams.status,
				detail: null,
				color: colorFor(conn.streams.status)
			},
			{
				name: 'Metrics stream',
				value: conn.streams.metrics,
				detail: null,
				color: colorFor(conn.streams.metrics)
			},
			{
				name: 'Logs stream',
				value: conn.streams.logs,
				detail: null,
				color: colorFor(conn.streams.logs)
			}
		];
	});
</script>

<div class="mx-auto max-w-[1400px] space-y-5 px-4 py-6 md:px-8">
	<header class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h2 class="text-lg font-semibold tracking-tight">System</h2>
			<p class="mt-0.5 text-[13px] text-text-muted">
				Container metrics streamed from DUMB
				{#if metrics}· updated {new Date(metrics.receivedAt).toLocaleTimeString()}{/if}
			</p>
		</div>
		<div class="flex gap-1" role="group" aria-label="Time range">
			{#each [1, 6, 24] as h (h)}
				<button
					type="button"
					class="rounded-full border px-3 py-1 text-xs font-medium transition-colors {hours === h
						? 'border-accent bg-accent-soft text-text-primary'
						: 'border-border-subtle text-text-muted hover:border-border-strong'}"
					onclick={() => (hours = h)}
					aria-pressed={hours === h}
				>
					{h}h
				</button>
			{/each}
		</div>
	</header>

	<!-- DUMB connection diagnostics (brief §10): troubleshooting detail, honest per layer. -->
	<Card
		title="DUMB connection"
		subtitle="Per-layer connectivity of the shared server-side connection"
	>
		<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
			<ul class="space-y-1.5 text-xs">
				{#each layerRows as row (row.name)}
					<li class="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
						<span class="font-medium text-text-primary">{row.name}</span>
						<span class="flex items-center gap-2 text-right">
							{#if row.detail}
								<span class="text-[11px] text-text-faint">{row.detail}</span>
							{/if}
							<span class="font-medium capitalize" style="color: {row.color}">{row.value}</span>
						</span>
					</li>
				{/each}
			</ul>
			<ul class="space-y-1.5 text-xs">
				<li class="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
					<span class="text-text-muted">Overall</span>
					<span class="font-semibold">{CONNECTION_LABELS[conn.state] ?? conn.state}</span>
				</li>
				<li class="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
					<span class="text-text-muted">Last successful contact</span>
					<span class="tnum text-text-secondary">{relativeTime(conn.lastSuccessAt)}</span>
				</li>
				<li class="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
					<span class="text-text-muted">Last telemetry update</span>
					<span class="tnum text-text-secondary">{relativeTime(conn.lastUpdateAt)}</span>
				</li>
				<li class="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
					<span class="text-text-muted">Current session</span>
					<span class="tnum text-text-secondary">
						{conn.connectedSince ? `since ${relativeTime(conn.connectedSince)}` : '—'}
					</span>
				</li>
				<li class="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
					<span class="text-text-muted">Reconnect attempts</span>
					<span class="tnum text-text-secondary">{conn.reconnectAttempts}</span>
				</li>
				{#if conn.lastError}
					<li class="rounded-lg bg-surface-2 px-3 py-2 text-[11px] text-degraded">
						{conn.lastError}
					</li>
				{/if}
			</ul>
		</div>
	</Card>

	<!-- Storage mounts (FASE B): read-only observability, states + latency. -->
	<Card
		title="Storage mounts"
		subtitle="Read-only probe results — stat latency and bounded symlink sampling"
	>
		{#if mounts.length === 0}
			<p class="rounded-lg bg-surface-2 px-3 py-3 text-xs text-text-muted">
				No mount paths configured. Set <code class="text-text-secondary">DUMBSCOPE_MOUNTS</code>
				(JSON) to monitor debrid mounts, symlink roots or media paths.
			</p>
		{:else}
			<ul class="grid grid-cols-1 gap-2 lg:grid-cols-2">
				{#each mounts as mount (mount.target.id)}
					<li class="rounded-lg bg-surface-2 px-3 py-2.5 text-xs">
						<div class="flex items-center justify-between gap-2">
							<span class="flex min-w-0 items-center gap-2">
								<HardDriveDownload
									size={13}
									style="color:{mountColor(mount.state)}"
									aria-hidden="true"
								/>
								<span class="min-w-0">
									<span class="block truncate font-medium text-text-primary"
										>{mount.target.label}</span
									>
									<span class="block truncate text-[10px] text-text-faint" title={mount.target.path}
										>{mount.target.path}</span
									>
								</span>
							</span>
							<span class="font-semibold capitalize" style="color:{mountColor(mount.state)}"
								>{mount.state}</span
							>
						</div>
						<div class="tnum mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-text-muted">
							<span>
								{mount.state === 'missing'
									? 'not mounted'
									: mount.statLatencyMs === null
										? 'no response yet'
										: `stat ${Math.round(mount.statLatencyMs)} ms`}
							</span>
							{#if mount.listLatencyMs !== null}
								<span>list {Math.round(mount.listLatencyMs)} ms</span>
							{/if}
							{#if mount.symlink}
								<span>
									links {mount.symlink.sampled} sampled · {mount.symlink.valid} valid ·
									<span class={mount.symlink.broken > 0 ? 'text-degraded' : ''}
										>{mount.symlink.broken} broken</span
									>
								</span>
							{/if}
							{#if mount.failedRounds > 0}
								<span class="text-degraded"
									>{mount.failedRounds} failed round{mount.failedRounds === 1 ? '' : 's'}</span
								>
							{/if}
							{#if mount.lastError}
								<span class="w-full text-degraded" title={mount.lastError}>{mount.lastError}</span>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</Card>

	<!-- Memory anomalies (FASE C): current vs typical vs growth. -->
	<Card title="Memory anomalies" subtitle="Per-process RSS against its rolling-median baseline">
		{#if memoryViews.length === 0}
			<p class="rounded-lg bg-surface-2 px-3 py-3 text-xs text-text-muted">
				Collecting per-process memory samples — baselines form within about an hour.
			</p>
		{:else}
			<ul class="space-y-1.5 text-xs">
				{#each memoryViews as view (view.process)}
					{@const anomalous = view.level !== 'ok'}
					<li
						class="flex items-center gap-2.5 rounded-lg bg-surface-2 px-3 py-2 {anomalous
							? 'border border-degraded'
							: ''}"
					>
						{#if anomalous}
							<TriangleAlert size={13} style="color:{memoryColor(view.level)}" aria-hidden="true" />
						{/if}
						<span class="min-w-0 flex-1 truncate font-medium text-text-primary">{view.process}</span
						>
						<span class="tnum w-16 text-right font-semibold" style="color:{memoryColor(view.level)}"
							>{formatBytes(view.currentBytes)}</span
						>
						<span class="tnum w-16 text-right text-text-muted" title="Typical (6h baseline median)"
							>{view.baselineBytes === null ? '—' : formatBytes(view.baselineBytes)}</span
						>
						<span
							class="tnum w-16 text-right"
							style="color:{(view.delta6hBytes ?? 0) > 0 ? 'var(--degraded)' : 'var(--text-muted)'}"
							>{signed(view.delta6hBytes)}</span
						>
						<span class="tnum w-16 text-right text-text-faint" title="24h peak"
							>{formatBytes(view.peak24hBytes)}</span
						>
					</li>
				{/each}
			</ul>
			<p class="mt-2 text-[10px] text-text-faint">
				Columns: current · typical · 6h change · 24h peak. Anomalous processes keep their finding
				until memory stays near typical for 10 minutes.
			</p>
		{/if}
	</Card>

	<!-- Media state (DEEL 2): cross-service acquisition correlation. -->
	<Card
		title="Media state"
		subtitle="Sonarr/Radarr acquisition flow — observe and correlate, never auto-fix"
	>
		<div class="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">
			<span class="tnum"
				><Repeat2
					size={11}
					class="mr-1 inline text-degraded"
					aria-hidden="true"
				/>{mediaMetrics.repeatedRequests24h}
				repeated request{mediaMetrics.repeatedRequests24h === 1 ? '' : 's'} (24h)</span
			>
			<span class="tnum"
				>{mediaMetrics.activeMediaMismatches} active mismatch{mediaMetrics.activeMediaMismatches ===
				1
					? ''
					: 'es'}</span
			>
			{#if mediaMetrics.propagation.medianMs !== null}
				<span class="tnum"
					>grab→import median {Math.round(mediaMetrics.propagation.medianMs / 1000)}s · p95
					{Math.round((mediaMetrics.propagation.p95Ms ?? 0) / 1000)}s</span
				>
			{/if}
		</div>
		{#if mediaItems.length === 0}
			<p class="rounded-lg bg-surface-2 px-3 py-3 text-xs text-text-muted">
				No recent acquisition activity to correlate. Items appear here while they are being
				acquired, repeated or stuck.
			</p>
		{:else}
			<ul class="space-y-1.5 text-xs">
				{#each mediaItems.slice(0, 8) as item (item.mediaKey)}
					{@const attention =
						item.classification === 'repeated-request' ||
						item.classification === 'mount-unavailable'}
					<li class="rounded-lg bg-surface-2 px-3 py-2 {attention ? 'border border-degraded' : ''}">
						<div class="flex items-center justify-between gap-2">
							<span class="min-w-0 truncate font-medium text-text-primary">{item.title}</span>
							<span
								class="shrink-0 font-semibold capitalize"
								style="color:{flowSummaryColor(item)}"
							>
								{item.summary}
							</span>
						</div>
						<p class="mt-0.5 truncate text-[10px] text-text-muted">
							{item.observations.map((o) => o.source + ': ' + o.state).join(' · ')}
							{#if item.acquisitions > 1}· {item.acquisitions} requests{/if}
						</p>
						{#if attention && item.reason}
							<p class="mt-0.5 text-[10px] text-degraded">{item.reason}</p>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</Card>

	<!-- Recommended actions (DEEL 2): recommendation-only, confirmation before any execution. -->
	<Card
		title="Recommended actions"
		subtitle="Recommendation-only — nothing runs without explicit confirmation"
	>
		{#if actionMessage}
			<p
				class="mb-2 rounded-lg px-3 py-2 text-xs {actionMessage.kind === 'ok'
					? 'bg-healthy-soft text-text-secondary'
					: 'bg-critical-soft text-text-secondary'}"
			>
				{actionMessage.text}
			</p>
		{/if}
		{#if recommendations.length === 0}
			<p class="rounded-lg bg-surface-2 px-3 py-3 text-xs text-text-muted">
				No recommended actions. Recommendations appear when sustained evidence (for example a memory
				anomaly) supports a single-service restart — and always require manual confirmation.
			</p>
		{:else}
			<ul class="space-y-2 text-xs">
				{#each recommendations as rec (rec.id)}
					<li class="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2.5">
						<div class="flex items-center justify-between gap-2">
							<span class="flex min-w-0 items-center gap-2">
								<RefreshCw size={13} class="shrink-0 text-degraded" aria-hidden="true" />
								<span class="min-w-0">
									<span class="block truncate font-medium text-text-primary"
										>Restart {rec.target}</span
									>
									<span class="block text-[10px] text-text-muted">{rec.reason}</span>
								</span>
							</span>
							<button
								type="button"
								class="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[11px] font-semibold text-bg transition-opacity hover:opacity-90"
								onclick={() => (confirmTarget = rec.target)}
							>
								Review…
							</button>
						</div>
						<p class="tnum mt-1 text-[10px] text-text-faint">{rec.evidence.join(' · ')}</p>
					</li>
				{/each}
			</ul>
		{/if}
		{#if recentActions.length > 0}
			<details class="mt-3">
				<summary class="cursor-pointer text-[11px] font-medium text-text-muted">
					Recent actions ({recentActions.length})
				</summary>
				<ul class="mt-1.5 space-y-1 text-[10px] text-text-muted">
					{#each recentActions as action (action.id)}
						<li class="flex items-center justify-between gap-2 rounded bg-surface-2 px-2.5 py-1.5">
							<span class="min-w-0 truncate"
								>{action.target} · {action.state}{action.verification
									? ' — ' + action.verification
									: ''}</span
							>
							<span class="tnum shrink-0"
								>{action.requestedAt ? relativeTime(action.requestedAt) : ''}</span
							>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	</Card>

	{#if confirmTarget}
		<div
			class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
			role="presentation"
		>
			<div
				class="w-full max-w-md rounded-[16px] border border-border-subtle bg-surface-1 p-5 shadow-2xl"
				role="dialog"
				aria-modal="true"
				aria-label="Confirm restart"
			>
				<h3 class="text-sm font-semibold text-text-primary">Restart {confirmTarget}?</h3>
				<p class="mt-1.5 text-xs text-text-secondary">
					Only this managed service will be restarted, via DUMB's own management route. No other
					services and no container are affected.
				</p>
				<p class="mt-2 text-[11px] text-text-muted">Current evidence:</p>
				<ul class="mt-1 space-y-0.5 text-[11px] text-text-muted">
					{#each recommendations.find((r) => r.target === confirmTarget)?.evidence ?? [] as line (line)}
						<li class="font-mono">• {line}</li>
					{/each}
				</ul>
				<p class="mt-2 text-[11px] text-text-faint">
					DUMBscope will verify recovery afterwards. Cooldown 6 h, max 2 attempts per 24 h.
				</p>
				<div class="mt-4 flex justify-end gap-2">
					<button
						type="button"
						class="rounded-lg border border-border-subtle px-3.5 py-2 text-xs font-medium text-text-secondary hover:border-border-strong"
						onclick={() => (confirmTarget = null)}
					>
						Cancel
					</button>
					<button
						type="button"
						disabled={confirmBusy}
						class="rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
						onclick={() => confirmTarget && requestRestart(confirmTarget)}
					>
						{confirmBusy ? 'Requesting…' : 'Restart service'}
					</button>
				</div>
			</div>
		</div>
	{/if}

	{#if !metrics}
		<EmptyState
			title={live.connection.state === 'live' ? 'No metrics yet' : 'Metrics unavailable'}
			description={live.connection.state === 'live'
				? 'Waiting for the first metrics snapshot from DUMB.'
				: 'Connect to DUMB to stream CPU, memory, disk and network metrics.'}
			neutral
		/>
	{:else}
		<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
			<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-4">
				<p
					class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint"
				>
					<Cpu size={12} aria-hidden="true" /> CPU
				</p>
				<p class="tnum mt-1 text-2xl font-semibold">{formatPercent(metrics.cpuPercent)}</p>
				<p class="mt-0.5 text-[11px] text-text-muted">
					{metrics.cpuCount ?? '?'} cores{metrics.loadAvg
						? ` · load ${metrics.loadAvg[0].toFixed(2)}`
						: ''}
				</p>
			</div>
			<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-4">
				<p
					class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint"
				>
					<MemoryStick size={12} aria-hidden="true" /> Memory
				</p>
				<p class="tnum mt-1 text-2xl font-semibold">
					{formatPercent(metrics.memory?.percent ?? null)}
				</p>
				<p class="mt-0.5 text-[11px] text-text-muted">
					{formatBytes(metrics.memory?.usedBytes)} of {formatBytes(metrics.memory?.totalBytes)}
				</p>
			</div>
			{#each metrics.filesystems.slice(0, 2) as fs, i (fs.path)}
				<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-4">
					<p
						class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint"
					>
						<HardDrive size={12} aria-hidden="true" /> Disk {i === 0 ? '' : i + 1}
					</p>
					<p class="tnum mt-1 text-2xl font-semibold">{formatPercent(fs.percent)}</p>
					<p class="mt-0.5 truncate text-[11px] text-text-muted" title={fs.path}>
						{fs.path} · {formatBytes(fs.freeBytes)} free
					</p>
				</div>
			{/each}
			<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-4">
				<p
					class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint"
				>
					<ArrowDownUp size={12} aria-hidden="true" /> Network
				</p>
				<p class="tnum mt-1 text-lg font-semibold leading-7">
					↓ {formatBytes(metrics.networkTotals?.recvBytes ?? null)}<br />
					↑ {formatBytes(metrics.networkTotals?.sentBytes ?? null)}
				</p>
				<p class="mt-0.5 text-[11px] text-text-muted">cumulative</p>
			</div>
		</div>

		<Card
			title="CPU & memory"
			subtitle={hours > 1 && loading
				? 'Loading history from DUMB…'
				: 'Percent of capacity over time'}
		>
			{#if points.length > 2}
				<AreaChart
					series={[
						{ name: 'CPU', color: 'var(--accent)', points: cpuPoints },
						{ name: 'Memory', color: 'var(--healthy)', points: memPoints },
						...(diskPoints.some((p) => p.v !== null)
							? [{ name: 'Disk', color: 'var(--degraded)', points: diskPoints }]
							: [])
					]}
					height={200}
				/>
			{:else}
				<div class="flex h-[200px] items-center justify-center text-xs text-text-muted">
					Collecting enough data to chart…
				</div>
			{/if}
		</Card>

		<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
			{#if nets.length > 0}
				<Card title="Network interfaces" subtitle="Cumulative counters per interface">
					<ul class="space-y-2 text-xs">
						{#each nets.slice(0, 6) as net (net.name)}
							<li class="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
								<span class="font-medium text-text-primary">{net.name}</span>
								<span class="tnum text-text-muted"
									>↓ {formatBytes(net.recvBytes)} · ↑ {formatBytes(net.sentBytes)}</span
								>
							</li>
						{/each}
					</ul>
				</Card>
			{/if}

			<Card title="Managed processes" subtitle="Per-process CPU/memory from DUMB">
				<ul class="space-y-2 text-xs">
					{#each metrics.processes.slice(0, 8) as proc (proc.name)}
						<li class="flex items-center gap-2.5 rounded-lg bg-surface-2 px-3 py-2">
							<span class="min-w-0 flex-1 truncate font-medium text-text-primary">{proc.name}</span>
							{#if proc.pid}<span class="tnum text-text-faint">pid {proc.pid}</span>{/if}
							<span class="tnum w-14 text-right text-text-muted"
								>{formatPercent(proc.cpuPercent)}</span
							>
							<span class="tnum w-20 text-right text-text-muted"
								>{formatBytes(proc.memoryBytes)}</span
							>
						</li>
					{:else}
						<li class="rounded-lg bg-surface-2 px-3 py-3 text-center text-text-muted">
							No process metrics in this snapshot.
						</li>
					{/each}
				</ul>
			</Card>
		</div>

		{#if dbs.length > 0}
			<Card title="Database health" subtitle="Observed by DUMB's database health probes">
				<ul class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
					{#each dbs as db (db.processName)}
						<li class="flex items-center gap-2.5 rounded-lg bg-surface-2 px-3 py-2.5 text-xs">
							<span
								class="h-1.5 w-1.5 rounded-full {db.healthy === true
									? 'bg-healthy'
									: db.healthy === false
										? 'bg-critical'
										: 'bg-unknown'}"
							></span>
							<span class="min-w-0 flex-1 truncate font-medium text-text-primary"
								>{db.processName}</span
							>
							{#if db.reason}<span class="truncate text-text-muted" title={db.reason}
									>{db.reason}</span
								>{/if}
						</li>
					{/each}
				</ul>
			</Card>
		{/if}
	{/if}
</div>
