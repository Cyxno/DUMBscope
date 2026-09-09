<script lang="ts">
	import { live } from '$lib/stores/live.svelte';
	import Card from '$lib/components/Card.svelte';
	import AreaChart from '$lib/components/AreaChart.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { formatBytes, formatPercent } from '$lib/utils/format';
	import { Cpu, MemoryStick, HardDrive, ArrowDownUp } from '@lucide/svelte';

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
