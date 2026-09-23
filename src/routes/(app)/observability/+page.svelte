<script lang="ts">
	import { live } from '$lib/stores/live.svelte';
	import Card from '$lib/components/Card.svelte';
	import AreaChart from '$lib/components/AreaChart.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { formatBytes, formatPercent, formatDuration, relativeTime } from '$lib/utils/format';
	import type { CgroupMemoryInterpretation, ServiceMemoryClass, TimelineEvent } from '$lib/types';
	import { MemoryStick, Thermometer, CircleGauge, HardDriveDownload } from '@lucide/svelte';

	const obs = $derived(live.observability);

	// --- history -------------------------------------------------------------
	let hours = $state(24);
	let history = $state<{
		cgroup: {
			t: number;
			currentAvg: number | null;
			currentMax: number | null;
			anonAvg: number | null;
			fileAvg: number | null;
			kernelAvg: number | null;
		}[];
		thermal: { at: number; maxC: number | null; packageC: number | null }[];
	} | null>(null);
	let historyLoading = $state(false);

	async function loadHistory() {
		historyLoading = true;
		try {
			const res = await fetch(`/api/observability/history?hours=${hours}`);
			if (res.ok) history = await res.json();
		} finally {
			historyLoading = false;
		}
	}

	$effect(() => {
		void hours;
		void loadHistory();
	});

	// --- timeline -------------------------------------------------------------
	let timelineHours = $state(24);
	let timeline = $state<TimelineEvent[]>([]);
	let timelineLoading = $state(false);

	async function loadTimeline() {
		timelineLoading = true;
		try {
			const res = await fetch(`/api/observability/timeline?hours=${timelineHours}&limit=150`);
			if (res.ok) {
				const data = (await res.json()) as { events: TimelineEvent[] };
				timeline = data.events;
			}
		} finally {
			timelineLoading = false;
		}
	}

	$effect(() => {
		void timelineHours;
		void loadTimeline();
	});

	// --- helpers --------------------------------------------------------------
	const GIB = 1024 ** 3;
	const toGiB = (b: number | null | undefined): number | null =>
		b === null || b === undefined ? null : b / GIB;
	const fmtGiB = (b: number | null | undefined): string =>
		b === null || b === undefined ? '—' : `${(b / GIB).toFixed(2)} GiB`;
	function signed(bytes: number | null): string {
		if (bytes === null) return '—';
		const sign = bytes >= 0 ? '+' : '−';
		return `${sign}${formatBytes(Math.abs(bytes))}`;
	}

	function classStyle(c: ServiceMemoryClass): string {
		switch (c) {
			case 'possible-leak':
				return 'bg-[color-mix(in_srgb,var(--critical)_18%,transparent)] text-[var(--critical)] border-[color-mix(in_srgb,var(--critical)_40%,transparent)]';
			case 'elevated-plateau':
			case 'workload-driven':
			case 'sawtooth':
				return 'bg-[color-mix(in_srgb,var(--degraded)_16%,transparent)] text-[var(--degraded)] border-[color-mix(in_srgb,var(--degraded)_40%,transparent)]';
			case 'stable':
				return 'bg-[color-mix(in_srgb,var(--healthy)_14%,transparent)] text-[var(--healthy)] border-[color-mix(in_srgb,var(--healthy)_40%,transparent)]';
			default:
				return 'bg-surface-2 text-text-muted border-border-subtle';
		}
	}
	const CLASS_LABELS: Record<ServiceMemoryClass, string> = {
		stable: 'stable',
		'elevated-plateau': 'elevated plateau',
		'workload-driven': 'workload-driven',
		sawtooth: 'sawtooth / GC',
		'possible-leak': 'possible leak',
		'insufficient-history': 'insufficient history'
	};

	function pressureState(i: CgroupMemoryInterpretation | undefined): {
		label: string;
		color: string;
	} {
		if (!i) return { label: 'unknown', color: 'var(--unknown)' };
		if (i.oom) return { label: 'OOM', color: 'var(--critical)' };
		if (i.pressure) return { label: 'memory pressure', color: 'var(--critical)' };
		if (i.hardLimitHit) return { label: 'hard limit hit', color: 'var(--critical)' };
		if (i.softReclaimActive) return { label: 'soft reclaim active', color: 'var(--degraded)' };
		return { label: 'no limit activity', color: 'var(--healthy)' };
	}

	function timelineColor(kind: TimelineEvent['kind']): string {
		switch (kind) {
			case 'oom':
				return 'var(--critical)';
			case 'thermal':
			case 'cgroup-max':
				return 'var(--critical)';
			case 'repair-loop':
			case 'memory-anomaly':
			case 'download-failure':
			case 'mount':
				return 'var(--degraded)';
			case 'cgroup-high':
				return 'var(--degraded)';
			default:
				return 'var(--accent)';
		}
	}

	// --- cgroup derived -------------------------------------------------------
	const cg = $derived(obs?.cgroup);
	const breakdownTotal = $derived(
		cg
			? (cg.breakdown.applicationsBytes || 0) +
					(cg.breakdown.sharedBytes || 0) +
					(cg.breakdown.cacheBytes || 0) +
					(cg.breakdown.kernelBytes || 0)
			: 0
	);
	const pct = (bytes: number) => (breakdownTotal > 0 ? (bytes / breakdownTotal) * 100 : 0);
	const currentVsHigh = $derived(
		cg && cg.breakdown.currentBytes !== null && cg.highBytes
			? (cg.breakdown.currentBytes / cg.highBytes) * 100
			: null
	);
	const currentVsMax = $derived(
		cg && cg.breakdown.currentBytes !== null && cg.maxBytes
			? (cg.breakdown.currentBytes / cg.maxBytes) * 100
			: null
	);

	const cgroupChart = $derived.by(() => {
		const points = history?.cgroup ?? [];
		if (points.length < 2) return null;
		let maxSeen = 0;
		for (const p of points) maxSeen = Math.max(maxSeen, p.currentMax ?? 0, p.currentAvg ?? 0);
		const limit = Math.max(cg?.highBytes ?? 0, maxSeen);
		const maxY = Math.ceil((toGiB(limit) ?? 10) * 1.15 * 10) / 10;
		return {
			series: [
				{
					name: 'current',
					color: 'var(--accent)',
					points: points.map((p) => ({ t: p.t, v: toGiB(p.currentAvg) }))
				},
				{
					name: 'anon',
					color: 'var(--healthy)',
					points: points.map((p) => ({ t: p.t, v: toGiB(p.anonAvg) }))
				},
				{
					name: 'file cache',
					color: 'var(--degraded)',
					points: points.map((p) => ({ t: p.t, v: toGiB(p.fileAvg) }))
				},
				{
					name: 'kernel',
					color: 'var(--text-faint)',
					points: points.map((p) => ({ t: p.t, v: toGiB(p.kernelAvg) }))
				}
			],
			maxY
		};
	});

	const thermalChart = $derived.by(() => {
		const points = history?.thermal ?? [];
		if (points.length < 2) return null;
		return {
			series: [
				{
					name: 'hottest zone °C',
					color: 'var(--degraded)',
					points: points.map((p) => ({ t: p.at, v: p.maxC }))
				},
				...(points.some((p) => p.packageC !== null)
					? [
							{
								name: 'package °C',
								color: 'var(--accent)',
								points: points.map((p) => ({ t: p.at, v: p.packageC }))
							}
						]
					: [])
			]
		};
	});

	const infinidysk = $derived(obs?.infiniDysk);
	const routing = $derived(obs?.routing);
	const thermal = $derived(obs?.thermal);
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-lg font-semibold tracking-tight">Observability</h1>
			<p class="text-xs text-text-muted">
				DUMB cgroup memory · per-service baselines · InfiniDysk · routing · thermal · timeline
			</p>
		</div>
		<label class="flex items-center gap-2 text-xs text-text-muted">
			Range
			<select
				class="rounded-lg border border-border-subtle bg-surface-1 px-2 py-1.5 text-xs"
				bind:value={hours}
			>
				<option value={1}>1h</option>
				<option value={6}>6h</option>
				<option value={24}>24h</option>
				<option value={24 * 7}>7d</option>
				<option value={24 * 30}>30d</option>
			</select>
		</label>
	</div>

	{#if !obs}
		<EmptyState
			title="Observability is starting up"
			description="The first cgroup sample, service classification and thermal reading land within a minute of start."
			neutral
		/>
	{:else}
		<!-- Headline tiles -->
		<div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
			<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-4">
				<p
					class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint"
				>
					<MemoryStick size={12} aria-hidden="true" /> DUMB memory
				</p>
				<p class="tnum mt-1 text-2xl font-semibold">{fmtGiB(cg?.breakdown.currentBytes)}</p>
				<p class="mt-0.5 text-[11px] text-text-muted">
					{#if cg?.highBytes}
						high {fmtGiB(cg.highBytes)} · {currentVsHigh === null
							? '—'
							: `${currentVsHigh.toFixed(0)}%`}
						{#if cg.maxBytes}· max {fmtGiB(cg.maxBytes)}{/if}
					{:else}
						no cgroup source configured
					{/if}
				</p>
				<p class="mt-1.5 text-[11px] font-medium" style={pressureState(cg?.interpretation).color}>
					{pressureState(cg?.interpretation).label}
				</p>
			</div>
			<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-4">
				<p
					class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint"
				>
					<CircleGauge size={12} aria-hidden="true" /> Anon (applications)
				</p>
				<p class="tnum mt-1 text-2xl font-semibold">{fmtGiB(cg?.breakdown.applicationsBytes)}</p>
				<p class="mt-0.5 text-[11px] text-text-muted">
					cache {fmtGiB(cg?.breakdown.cacheBytes)} · shared {fmtGiB(cg?.breakdown.sharedBytes)} · kernel
					{fmtGiB(cg?.breakdown.kernelBytes)}
				</p>
				<p class="mt-1.5 text-[11px] text-text-faint">
					high memory alone is not a problem — watch the flags
				</p>
			</div>
			<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-4">
				<p
					class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint"
				>
					<Thermometer size={12} aria-hidden="true" /> Thermal
				</p>
				<p class="tnum mt-1 text-2xl font-semibold">
					{thermal?.maxTempC !== null && thermal?.maxTempC !== undefined
						? `${thermal.maxTempC.toFixed(0)}°C`
						: '—'}
				</p>
				<p class="mt-0.5 text-[11px] text-text-muted">
					{thermal?.maxZoneType ?? 'no zones'}
					{#if thermal?.packageTempC != null}
						· package {thermal.packageTempC.toFixed(0)}°C
					{/if}
				</p>
				<p
					class="mt-1.5 text-[11px] font-medium"
					style={thermal?.spikeLevel ? 'var(--critical)' : 'var(--text-muted)'}
				>
					{thermal?.spikeLevel ? `spike ≥ ${thermal.spikeLevel}°C` : 'within thresholds'}
				</p>
			</div>
			<div class="rounded-[14px] border border-border-subtle bg-surface-1 p-4">
				<p
					class="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-faint"
				>
					<HardDriveDownload size={12} aria-hidden="true" /> InfiniDysk
				</p>
				<p class="tnum mt-1 text-2xl font-semibold">{infinidysk?.version ?? '—'}</p>
				<p class="mt-0.5 text-[11px] text-text-muted">
					{infinidysk?.available ? 'via DUMB registry' : (infinidysk?.unavailableReason ?? '')}
				</p>
				<p
					class="mt-1.5 text-[11px] font-medium"
					style={infinidysk?.repairActive ? 'var(--degraded)' : 'var(--healthy)'}
				>
					{infinidysk?.repairActive ? 'repair active' : 'no repair running'}
					{#if infinidysk}
						· {infinidysk.repairs1h} repairs/h
					{/if}
				</p>
			</div>
		</div>

		<!-- Cgroup memory -->
		<Card
			title="DUMB cgroup memory (v2)"
			subtitle={cg?.source
				? `source: ${cg.source}${cg.at ? ` · sampled ${relativeTime(cg.at)}` : ''}`
				: (cg?.unavailableReason ?? 'waiting for first sample')}
		>
			{#if cg?.highBytes === null && cg?.unavailableReason}
				<p class="text-xs text-text-muted">{cg.unavailableReason}</p>
			{:else}
				<div class="space-y-4">
					<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
						<div>
							<div class="flex h-4 overflow-hidden rounded-md bg-surface-2">
								<div
									class="h-full"
									style={`width:${pct(cg?.breakdown.applicationsBytes ?? 0)}%;background:var(--accent)`}
									title="applications (anon)"
								></div>
								<div
									class="h-full"
									style={`width:${pct(cg?.breakdown.sharedBytes ?? 0)}%;background:var(--degraded)`}
									title="shared / tmpfs"
								></div>
								<div
									class="h-full"
									style={`width:${pct(cg?.breakdown.cacheBytes ?? 0)}%;background:var(--healthy)`}
									title="reclaimable file cache"
								></div>
								<div
									class="h-full"
									style={`width:${pct(cg?.breakdown.kernelBytes ?? 0)}%;background:var(--text-faint)`}
									title="kernel"
								></div>
							</div>
							<dl class="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
								<div class="flex items-center justify-between gap-2">
									<dt class="flex items-center gap-1.5 text-text-muted">
										<span class="h-2 w-2 rounded-sm" style="background:var(--accent)"></span>
										applications / anon
									</dt>
									<dd class="tnum">{fmtGiB(cg?.breakdown.applicationsBytes)}</dd>
								</div>
								<div class="flex items-center justify-between gap-2">
									<dt class="flex items-center gap-1.5 text-text-muted">
										<span class="h-2 w-2 rounded-sm" style="background:var(--healthy)"></span>
										reclaimable file cache
									</dt>
									<dd class="tnum">{fmtGiB(cg?.breakdown.cacheBytes)}</dd>
								</div>
								<div class="flex items-center justify-between gap-2">
									<dt class="flex items-center gap-1.5 text-text-muted">
										<span class="h-2 w-2 rounded-sm" style="background:var(--degraded)"></span>
										shared / tmpfs
									</dt>
									<dd class="tnum">{fmtGiB(cg?.breakdown.sharedBytes)}</dd>
								</div>
								<div class="flex items-center justify-between gap-2">
									<dt class="flex items-center gap-1.5 text-text-muted">
										<span class="h-2 w-2 rounded-sm" style="background:var(--text-faint)"></span>
										kernel (slab+)
									</dt>
									<dd class="tnum">{fmtGiB(cg?.breakdown.kernelBytes)}</dd>
								</div>
							</dl>
							<p class="mt-2 text-[11px] text-text-faint">
								reclaimable slab {fmtGiB(cg?.breakdown.slabReclaimableBytes)} · usage is
								{currentVsHigh === null ? '—' : `${currentVsHigh.toFixed(0)}%`} of memory.high
								{#if cg?.maxBytes}
									· {currentVsMax === null ? '—' : `${currentVsMax.toFixed(0)}%`} of memory.max
								{/if}
							</p>
						</div>
						<ul class="space-y-2 text-xs">
							<li class="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
								<span class="text-text-muted">soft-limit reclaim (memory.high)</span>
								<span
									class="tnum font-medium"
									style={cg?.interpretation.softReclaimActive
										? 'var(--degraded)'
										: 'var(--text-muted)'}
									>{cg?.interpretation.softReclaimActive ? 'active now' : 'idle'}</span
								>
							</li>
							<li class="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
								<span class="text-text-muted">hard-limit hits (memory.max)</span>
								<span
									class="tnum font-medium"
									style={cg?.interpretation.hardLimitHit ? 'var(--critical)' : 'var(--text-muted)'}
									>{cg?.interpretation.hardLimitHit
										? 'hit this interval'
										: 'none this interval'}</span
								>
							</li>
							<li class="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
								<span class="text-text-muted">OOM / OOM-kill (cumulative)</span>
								<span class="tnum font-medium">
									{cg?.interpretation.events.oom ?? '—'} / {cg?.interpretation.events.oomKill ??
										'—'}
								</span>
							</li>
							<li class="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
								<span class="text-text-muted">memory.events high / max (cumulative)</span>
								<span class="tnum font-medium">
									{cg?.interpretation.events.high ?? '—'} / {cg?.interpretation.events.max ?? '—'}
								</span>
							</li>
							<li class="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
								<span class="text-text-muted">direct reclaim (pgscan_direct)</span>
								<span class="tnum font-medium">{cg?.interpretation.pgscanDirect ?? '—'}</span>
							</li>
							<li class="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
								<span class="text-text-muted">file refaults (workingset)</span>
								<span class="tnum font-medium">{cg?.interpretation.refaultFile ?? '—'}</span>
							</li>
						</ul>
					</div>
					{#if cgroupChart}
						<AreaChart
							series={cgroupChart.series}
							maxY={cgroupChart.maxY}
							formatValue={(v) => `${v.toFixed(2)} GiB`}
							height={190}
						/>
					{:else}
						<div class="flex h-[120px] items-center justify-center text-xs text-text-muted">
							{historyLoading ? 'Loading cgroup history…' : 'Collecting cgroup history…'}
						</div>
					{/if}
				</div>
			{/if}
		</Card>

		<!-- Per-service memory -->
		<Card
			title="Per-service memory"
			subtitle="24h p50/p95 baseline, deltas and deterministic classification — high ≠ leak"
		>
			<div class="overflow-x-auto">
				<table class="w-full min-w-[860px] text-left text-xs">
					<thead class="text-[11px] uppercase tracking-wider text-text-faint">
						<tr>
							<th class="pb-2 font-semibold">Service</th>
							<th class="pb-2 text-right font-semibold">Current</th>
							<th class="pb-2 text-right font-semibold">24h p50</th>
							<th class="pb-2 text-right font-semibold">p95</th>
							<th class="pb-2 text-right font-semibold">Δ1h</th>
							<th class="pb-2 text-right font-semibold">Δ6h</th>
							<th class="pb-2 text-right font-semibold">Δ24h</th>
							<th class="pb-2 text-right font-semibold">Trend</th>
							<th class="pb-2 font-semibold">Classification</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-border-subtle">
						{#each obs.services as s (s.key)}
							<tr class="align-top">
								<td class="py-2 pr-3">
									<p class="font-medium text-text-primary">{s.name}</p>
									<p class="text-[11px] text-text-faint">
										{s.version ?? 'version unknown'}
										{#if s.uptimeSeconds !== null}· up {formatDuration(s.uptimeSeconds * 1000)}{/if}
										{#if s.threads !== null}· {s.threads} threads{/if}
									</p>
									{#if s.baselineShift}
										<p class="mt-0.5 text-[11px] text-[var(--degraded)]">
											baseline shift: {formatBytes(s.baselineShift.fromBytes)} →
											{formatBytes(s.baselineShift.toBytes)} ({s.baselineShift.percent > 0
												? '+'
												: ''}{s.baselineShift.percent}%,
											{s.baselineShift.direction}, since {relativeTime(
												s.baselineShift.startedAt ?? Date.now()
											)})
										</p>
									{/if}
								</td>
								<td class="tnum py-2 text-right">{formatBytes(s.currentBytes)}</td>
								<td class="tnum py-2 text-right text-text-muted">{formatBytes(s.p50Bytes)}</td>
								<td class="tnum py-2 text-right text-text-muted">{formatBytes(s.p95Bytes)}</td>
								<td class="tnum py-2 text-right">{signed(s.delta1hBytes)}</td>
								<td class="tnum py-2 text-right">{signed(s.delta6hBytes)}</td>
								<td class="tnum py-2 text-right">{signed(s.delta24hBytes)}</td>
								<td class="tnum py-2 text-right text-text-muted">
									{s.slopeBytesPerHour === null ? '—' : `${signed(s.slopeBytesPerHour)}/h`}
								</td>
								<td class="py-2">
									<span
										class="inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium {classStyle(
											s.classification
										)}">{CLASS_LABELS[s.classification]}</span
									>
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="9" class="py-4 text-center text-text-muted">
									No classified services yet — baselines need a few hours of samples.
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</Card>

		<div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
			<!-- InfiniDysk -->
			<Card
				title="InfiniDysk / NzbWebDAV"
				subtitle={infinidysk?.available
					? `${infinidysk.version ?? '?'}${infinidysk.baseVersion ? ` (NZBDAV base ${infinidysk.baseVersion})` : ''}${infinidysk.autoUpdate === false ? ' · pinned, auto-update off' : ''}`
					: (infinidysk?.unavailableReason ?? '')}
			>
				{#if infinidysk?.available}
					<div class="space-y-3">
						<div class="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
							<div class="rounded-lg bg-surface-2 px-3 py-2">
								<p class="text-[11px] text-text-faint">RSS</p>
								<p class="tnum font-medium">{formatBytes(infinidysk.rss)}</p>
							</div>
							<div class="rounded-lg bg-surface-2 px-3 py-2">
								<p class="text-[11px] text-text-faint">Growth (24h trend)</p>
								<p class="tnum font-medium">
									{infinidysk.growthBytesPerHour === null
										? '—'
										: `${signed(infinidysk.growthBytesPerHour)}/h`}
								</p>
							</div>
							<div class="rounded-lg bg-surface-2 px-3 py-2">
								<p class="text-[11px] text-text-faint">Threads / CPU</p>
								<p class="tnum font-medium">
									{infinidysk.threads ?? '—'} · {formatPercent(infinidysk.cpuPercent)}
								</p>
							</div>
							<div class="rounded-lg bg-surface-2 px-3 py-2">
								<p class="text-[11px] text-text-faint">GC heap hard limit</p>
								<p class="tnum font-medium">{fmtGiB(infinidysk.gcHeapHardLimitBytes)}</p>
							</div>
							<div class="rounded-lg bg-surface-2 px-3 py-2">
								<p class="text-[11px] text-text-faint">Repairs 1h / 24h</p>
								<p class="tnum font-medium">{infinidysk.repairs1h} / {infinidysk.repairs24h}</p>
							</div>
							<div class="rounded-lg bg-surface-2 px-3 py-2">
								<p class="text-[11px] text-text-faint">430 No Such Article 1h / 24h</p>
								<p class="tnum font-medium">
									{infinidysk.article430_1h} / {infinidysk.article430_24h}
								</p>
							</div>
							<div class="rounded-lg bg-surface-2 px-3 py-2">
								<p class="text-[11px] text-text-faint">Missing segments 1h / 24h</p>
								<p class="tnum font-medium">
									{infinidysk.missingSegments1h} / {infinidysk.missingSegments24h}
								</p>
							</div>
							<div class="rounded-lg bg-surface-2 px-3 py-2">
								<p class="text-[11px] text-text-faint">Mount / uptime</p>
								<p class="tnum font-medium">
									{infinidysk.mountState ?? '—'}
									{#if infinidysk.uptimeSeconds !== null}
										· {formatDuration(infinidysk.uptimeSeconds * 1000)}
									{/if}
								</p>
							</div>
						</div>
						<p class="text-[11px] text-text-muted">
							provider fallbacks 24h: {infinidysk.providerFallbacks24h} · restarts (attempts):
							{infinidysk.restarts24h}
							{#if infinidysk.lastRepairAt}
								· last repair {relativeTime(infinidysk.lastRepairAt)}{/if}
						</p>
						{#if infinidysk.files.length > 0}
							<div class="overflow-x-auto">
								<table class="w-full min-w-[420px] text-left text-xs">
									<thead class="text-[11px] uppercase tracking-wider text-text-faint">
										<tr>
											<th class="pb-1.5 font-semibold">File (repair loop)</th>
											<th class="pb-1.5 text-right font-semibold">1h</th>
											<th class="pb-1.5 text-right font-semibold">24h</th>
											<th class="pb-1.5 text-right font-semibold">days</th>
											<th class="pb-1.5 font-semibold">Last event</th>
										</tr>
									</thead>
									<tbody class="divide-y divide-border-subtle">
										{#each infinidysk.files.slice(0, 10) as f (f.file)}
											<tr>
												<td class="max-w-[240px] truncate py-1.5 pr-3" title={f.file}>{f.file}</td>
												<td class="tnum py-1.5 text-right">{f.repairs1h}</td>
												<td class="tnum py-1.5 text-right">{f.repairs24h}</td>
												<td class="tnum py-1.5 text-right">{f.activeDays}</td>
												<td class="py-1.5 text-[11px] text-text-muted">
													{f.lastError ?? '—'}
													{#if f.lastRepairAt}
														· {relativeTime(f.lastRepairAt)}
													{/if}
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{:else}
							<p class="text-xs text-text-muted">
								No repair activity observed in the trailing window.
							</p>
						{/if}
					</div>
				{:else}
					<EmptyState
						title="InfiniDysk not found"
						description={infinidysk?.unavailableReason ?? ''}
						neutral
					/>
				{/if}
			</Card>

			<!-- Routing -->
			<Card
				title="Download routing"
				subtitle={routing?.fetchedAt
					? `${routing.windowHours}h window · Decypharr vs InfiniDysk · fetched ${relativeTime(routing.fetchedAt)}`
					: 'Waiting for the first routing poll from Sonarr/Radarr…'}
			>
				{#if routing && routing.clients.length > 0}
					<div class="space-y-3">
						<p class="text-xs text-text-muted">
							Preferred protocol — Sonarr: <span class="font-medium text-text-primary"
								>{routing.preferredProtocol.sonarr ?? '—'}</span
							>
							· Radarr:
							<span class="font-medium text-text-primary"
								>{routing.preferredProtocol.radarr ?? '—'}</span
							>
						</p>
						<div class="overflow-x-auto">
							<table class="w-full min-w-[520px] text-left text-xs">
								<thead class="text-[11px] uppercase tracking-wider text-text-faint">
									<tr>
										<th class="pb-1.5 font-semibold">Client</th>
										<th class="pb-1.5 font-semibold">Protocol</th>
										<th class="pb-1.5 text-right font-semibold">Grabs</th>
										<th class="pb-1.5 text-right font-semibold">Imports</th>
										<th class="pb-1.5 text-right font-semibold">Failures</th>
										<th class="pb-1.5 text-right font-semibold">Success</th>
									</tr>
								</thead>
								<tbody class="divide-y divide-border-subtle">
									{#each routing.clients as c (c.client)}
										<tr>
											<td class="py-1.5 pr-3">
												{c.client}
												{#if c.primary}
													<span
														class="ml-1 rounded-full border border-[color-mix(in_srgb,var(--healthy)_40%,transparent)] bg-[color-mix(in_srgb,var(--healthy)_14%,transparent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--healthy)]"
														>primary</span
													>
												{/if}
												{#if !c.enabled}
													<span class="ml-1 text-[10px] text-text-faint">disabled</span>
												{/if}
											</td>
											<td class="py-1.5 text-text-muted">{c.protocol ?? '—'}</td>
											<td class="tnum py-1.5 text-right">{c.grabs}</td>
											<td class="tnum py-1.5 text-right">{c.imports}</td>
											<td
												class="tnum py-1.5 text-right"
												style={c.failures > 0 ? 'var(--degraded)' : ''}
											>
												{c.failures}
											</td>
											<td class="tnum py-1.5 text-right">
												{c.successRate === null ? '—' : `${(c.successRate * 100).toFixed(0)}%`}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				{:else}
					<EmptyState
						title="No routing data yet"
						description="Add Sonarr or Radarr integrations; the routing poller runs every 10 minutes."
						neutral
					/>
				{/if}
			</Card>
		</div>

		<div class="grid grid-cols-1 gap-4 xl:grid-cols-2">
			<!-- Arr stack facts -->
			<Card
				title="Sonarr / Radarr"
				subtitle="Queue, blocklist, history and DB size from each instance"
			>
				{#if obs.ars.length > 0}
					<div class="space-y-3">
						{#each obs.ars as arr (arr.integrationId)}
							<div class="rounded-lg bg-surface-2 px-3 py-2.5 text-xs">
								<div class="flex items-center justify-between gap-2">
									<p class="font-medium uppercase text-text-primary">{arr.type}</p>
									<p class="text-[11px] text-text-muted">
										{arr.version ?? '—'}
										{#if arr.uptimeSeconds !== null}· up {formatDuration(
												arr.uptimeSeconds * 1000
											)}{/if}
									</p>
								</div>
								{#if arr.connected}
									<dl
										class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-text-muted sm:grid-cols-3"
									>
										<div>
											queue: <span class="tnum text-text-primary">{arr.queue ?? '—'}</span
											>{#if arr.queueFailures}<span class="text-[var(--degraded)]">
													({arr.queueFailures} failed)</span
												>{/if}
										</div>
										<div>
											blocklist: <span class="tnum text-text-primary"
												>{arr.blocklistSize ?? '—'}</span
											>
										</div>
										<div>
											history: <span class="tnum text-text-primary">{arr.historyEvents ?? '—'}</span
											>
										</div>
										<div>grabs 24h: <span class="tnum text-text-primary">{arr.grabs24h}</span></div>
										<div>
											imports 24h: <span class="tnum text-text-primary">{arr.imports24h}</span>
										</div>
										<div>
											failures 24h: <span
												class="tnum"
												style={arr.failures24h > 0 ? 'var(--degraded)' : ''}>{arr.failures24h}</span
											>
										</div>
										<div>
											RSS sync 24h: <span class="tnum text-text-primary"
												>{arr.rssSync.count24h}</span
											>
											{#if arr.rssSync.lastAt}· {relativeTime(arr.rssSync.lastAt)}{/if}
										</div>
										<div>
											searches 24h: <span class="tnum text-text-primary"
												>{arr.searches.count24h}</span
											>
										</div>
										<div>
											DB (backup size): <span class="tnum text-text-primary"
												>{formatBytes(arr.dbBytes)}</span
											>
										</div>
									</dl>
								{:else}
									<p class="mt-1 text-[11px] text-text-faint">{arr.unavailableReason}</p>
								{/if}
							</div>
						{/each}
					</div>
				{:else}
					<EmptyState
						title="No Arr integrations"
						description="Configure Sonarr or Radarr under Settings."
						neutral
					/>
				{/if}
			</Card>

			<!-- Thermal -->
			<Card
				title="Thermal correlation"
				subtitle="Host temperature with spike snapshots — limited scope, no causality claimed"
			>
				<div class="space-y-3">
					{#if thermalChart}
						<AreaChart
							series={thermalChart.series}
							height={140}
							formatValue={(v) => `${v.toFixed(0)}°C`}
						/>
					{:else}
						<div class="flex h-[100px] items-center justify-center text-xs text-text-muted">
							{historyLoading ? 'Loading thermal history…' : 'Collecting thermal history…'}
						</div>
					{/if}
					{#if obs.thermal.zones.length > 0}
						<ul class="flex flex-wrap gap-2 text-[11px]">
							{#each obs.thermal.zones.filter((z) => z.tempC !== null) as z (z.zone)}
								<li class="rounded-lg bg-surface-2 px-2.5 py-1.5">
									<span class="text-text-muted">{z.type || z.zone}</span>
									<span class="tnum ml-1.5 font-medium">{z.tempC?.toFixed(0)}°C</span>
								</li>
							{/each}
						</ul>
					{/if}
					{#if obs.thermal.lastSpike}
						<div class="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2.5 text-xs">
							<p class="font-medium text-text-primary">
								Last spike: ≥{obs.thermal.lastSpike.level}°C at {relativeTime(
									obs.thermal.lastSpike.at
								)}
							</p>
							<p class="mt-1 text-[11px] text-text-muted">
								{obs.thermal.lastSpike.tempC.toFixed(0)}°C · load
								{obs.thermal.lastSpike.hostLoad?.toFixed(2) ?? '—'} · DUMB CPU
								{obs.thermal.lastSpike.dumbCpuPercent?.toFixed(0) ?? '—'}% · top:
								{obs.thermal.lastSpike.topProcesses
									.map((p) => `${p.name} ${p.cpuPercent?.toFixed(0) ?? '?'}%`)
									.join(', ') || '—'}
								· InfiniDysk repair active: {obs.thermal.lastSpike.infiniDyskRepairActive
									? 'yes'
									: 'no'}
								{#if obs.thermal.lastSpike.recoveredAt}
									· recovered {relativeTime(obs.thermal.lastSpike.recoveredAt)}
								{/if}
							</p>
						</div>
					{/if}
				</div>
			</Card>
		</div>

		<!-- Versions -->
		<Card
			title="Versions & updates"
			subtitle="From the DUMB registry — the runtime is pinned, it does not follow DUMB:latest"
		>
			<div class="overflow-x-auto">
				<table class="w-full min-w-[640px] text-left text-xs">
					<thead class="text-[11px] uppercase tracking-wider text-text-faint">
						<tr>
							<th class="pb-2 font-semibold">Service</th>
							<th class="pb-2 font-semibold">Version</th>
							<th class="pb-2 font-semibold">Update</th>
							<th class="pb-2 font-semibold">Policy</th>
							<th class="pb-2 font-semibold">This version since</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-border-subtle">
						{#each obs.versions as v (v.key)}
							<tr>
								<td class="py-1.5 pr-3 font-medium text-text-primary">{v.name}</td>
								<td class="py-1.5 pr-3">
									{v.version ?? '—'}
									{#if v.commit}<span class="text-[10px] text-text-faint">
											· {v.commit.slice(0, 7)}</span
										>{/if}
								</td>
								<td class="py-1.5 pr-3">
									{#if v.updateAvailable}
										<span class="text-[var(--degraded)]">{v.availableVersion ?? 'available'}</span>
									{:else if v.updateStatus}
										<span class="text-text-muted">{v.updateStatus}</span>
									{:else}
										—
									{/if}
								</td>
								<td class="py-1.5 pr-3 text-text-muted">
									{v.autoUpdate === true ? 'auto-update' : v.pinned ? 'pinned / manual' : '—'}
								</td>
								<td class="py-1.5 text-text-muted">
									{v.since ? relativeTime(v.since) : '—'}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</Card>

		<!-- Timeline -->
		<Card
			title="Incident timeline"
			subtitle="Merged DUMB events — correlation display only, no causality claimed"
		>
			<div class="mb-3 flex items-center gap-2 text-xs">
				<label class="flex items-center gap-2 text-text-muted">
					Window
					<select
						class="rounded-lg border border-border-subtle bg-surface-1 px-2 py-1.5 text-xs"
						bind:value={timelineHours}
					>
						<option value={6}>6h</option>
						<option value={24}>24h</option>
						<option value={24 * 3}>3d</option>
						<option value={24 * 7}>7d</option>
						<option value={24 * 30}>30d</option>
					</select>
				</label>
				{#if timelineLoading}<span class="text-text-faint">loading…</span>{/if}
			</div>
			{#if timeline.length > 0}
				<ol class="space-y-1.5 text-xs">
					{#each timeline.slice(0, 80) as e (e.id)}
						<li class="flex items-start gap-2.5 rounded-lg bg-surface-2 px-3 py-2">
							<span class="tnum mt-0.5 w-14 shrink-0 text-[11px] text-text-faint">
								{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
							</span>
							<span
								class="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
								style={`background:${timelineColor(e.kind)}`}
								title={e.kind}
							></span>
							<div class="min-w-0 flex-1">
								<p class="font-medium text-text-primary">{e.title}</p>
								{#if e.detail}<p class="text-[11px] text-text-muted">{e.detail}</p>{/if}
							</div>
							<span class="shrink-0 text-[10px] uppercase tracking-wider text-text-faint"
								>{e.kind}</span
							>
						</li>
					{/each}
				</ol>
			{:else}
				<EmptyState
					title="No events in this window"
					description="Restarts, repair loops, cgroup hits, thermal spikes, deploys and download failures appear here."
					neutral
				/>
			{/if}
		</Card>
	{/if}
</div>
