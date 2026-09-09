<script lang="ts">
	/**
	 * Lightweight SVG area/line chart with a hover crosshair + tooltip.
	 * Series: array of points {t, v}; multiple series allowed.
	 */
	import { formatTime } from '$lib/utils/format';

	interface ChartSeries {
		name: string;
		color: string;
		points: { t: number; v: number | null }[];
	}

	let {
		series,
		height = 180,
		maxY = 100,
		yTicks = [0, 25, 50, 75, 100],
		formatValue = (v: number) => `${v.toFixed(1)}%`
	}: {
		series: ChartSeries[];
		height?: number;
		maxY?: number;
		yTicks?: number[];
		formatValue?: (v: number) => string;
	} = $props();

	const W = 600;
	const H = $derived(height);
	const PAD_L = 34;
	const PAD_R = 8;
	const PAD_T = 8;
	const PAD_B = 18;

	let hoverX: number | null = $state(null);

	const allPoints = $derived(series.flatMap((s) => s.points).filter((p) => p.v !== null));
	const tMin = $derived(allPoints.length > 0 ? Math.min(...allPoints.map((p) => p.t)) : 0);
	const tMax = $derived(allPoints.length > 0 ? Math.max(...allPoints.map((p) => p.t)) : 1);

	function xOf(t: number): number {
		const span = tMax - tMin || 1;
		return PAD_L + ((t - tMin) / span) * (W - PAD_L - PAD_R);
	}
	function yOf(v: number): number {
		const clamped = Math.max(0, Math.min(maxY, v));
		return PAD_T + (1 - clamped / maxY) * (height - PAD_T - PAD_B);
	}

	function pathFor(points: { t: number; v: number | null }[]): string {
		let d = '';
		let pen = false;
		for (const p of points) {
			if (p.v === null || !Number.isFinite(p.v)) {
				pen = false;
				continue;
			}
			const x = xOf(p.t);
			const y = yOf(p.v);
			d += pen ? ` L${x.toFixed(1)},${y.toFixed(1)}` : ` M${x.toFixed(1)},${y.toFixed(1)}`;
			pen = true;
		}
		return d.trim();
	}

	function areaFor(points: { t: number; v: number | null }[]): string {
		const line = pathFor(points);
		if (!line || points.length === 0) return '';
		const first = points.find((p) => p.v !== null)!;
		const last = [...points].reverse().find((p) => p.v !== null)!;
		return `${line} L${xOf(last.t).toFixed(1)},${yOf(0).toFixed(1)} L${xOf(first.t).toFixed(1)},${yOf(0).toFixed(1)} Z`;
	}

	const hoverInfo = $derived.by(() => {
		if (hoverX === null || allPoints.length === 0) return null;
		const span = tMax - tMin || 1;
		const t = tMin + ((hoverX - PAD_L) / (W - PAD_L - PAD_R)) * span;
		const rows = series.map((s) => {
			let best: { t: number; v: number | null } | null = null;
			let bestDist = Infinity;
			for (const p of s.points) {
				const dist = Math.abs(p.t - t);
				if (dist < bestDist) {
					bestDist = dist;
					best = p;
				}
			}
			return { name: s.name, color: s.color, point: best };
		});
		return { t, rows };
	});

	function onPointerMove(event: PointerEvent & { currentTarget: EventTarget & SVGSVGElement }) {
		const rect = event.currentTarget.getBoundingClientRect();
		const x = ((event.clientX - rect.left) / rect.width) * W;
		hoverX = Math.max(PAD_L, Math.min(W - PAD_R, x));
	}
</script>

<div class="relative">
	<svg
		viewBox="0 0 {W} {height}"
		width="100%"
		{height}
		role="img"
		aria-label="Chart"
		onpointermove={onPointerMove}
		onpointerleave={() => (hoverX = null)}
		class="block touch-none"
	>
		{#each yTicks as tick (tick)}
			<g>
				<line x1={PAD_L} x2={W - PAD_R} y1={yOf(tick)} y2={yOf(tick)} class="gridline" />
				<text x={PAD_L - 6} y={yOf(tick) + 3} class="tick tnum" text-anchor="end">{tick}</text>
			</g>
		{/each}

		{#each series as s (s.name)}
			<defs>
				<linearGradient id="area-{s.name.replace(/\W/g, '')}" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color={s.color} stop-opacity="0.22" />
					<stop offset="100%" stop-color={s.color} stop-opacity="0" />
				</linearGradient>
			</defs>
			<path d={areaFor(s.points)} fill="url(#area-{s.name.replace(/\W/g, '')})" />
			<path
				d={pathFor(s.points)}
				fill="none"
				stroke={s.color}
				stroke-width="1.75"
				stroke-linejoin="round"
				stroke-linecap="round"
			/>
		{/each}

		{#if hoverInfo}
			<line
				x1={xOf(hoverInfo.t)}
				x2={xOf(hoverInfo.t)}
				y1={PAD_T}
				y2={height - PAD_B}
				class="crosshair"
			/>
			{#each hoverInfo.rows as row, i (i)}
				{#if row.point && row.point.v !== null}
					<circle
						cx={xOf(row.point.t)}
						cy={yOf(row.point.v)}
						r="3"
						fill={row.color}
						stroke="var(--surface-1)"
						stroke-width="1.5"
					/>
				{/if}
			{/each}
		{/if}

		<text x={PAD_L} y={H - 4} class="tick tnum" text-anchor="start">{formatTime(tMin)}</text>
		<text x={W - PAD_R} y={H - 4} class="tick tnum" text-anchor="end">{formatTime(tMax)}</text>
	</svg>

	{#if hoverInfo}
		<div
			class="pointer-events-none absolute top-2 rounded-lg border border-border-subtle bg-surface-2/95 px-2.5 py-1.5 text-[11px] shadow-[var(--shadow-2)] backdrop-blur"
			style="left: {(xOf(hoverInfo.t) / W) * 100}%; transform: translateX({xOf(hoverInfo.t) / W >
			0.7
				? '-105%'
				: '8px'})"
		>
			<div class="tnum mb-1 text-text-muted">{formatTime(hoverInfo.t)}</div>
			{#each hoverInfo.rows as row, i (i)}
				{#if row.point && row.point.v !== null}
					<div class="flex items-center gap-1.5 whitespace-nowrap">
						<span class="h-1.5 w-1.5 rounded-full" style="background:{row.color}"></span>
						<span class="text-text-secondary">{row.name}</span>
						<span class="tnum ml-auto pl-3 font-medium text-text-primary"
							>{formatValue(row.point.v)}</span
						>
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	svg {
		--grid: var(--border-subtle);
	}
	.gridline {
		stroke: var(--grid);
		stroke-dasharray: 3 4;
	}
	.crosshair {
		stroke: var(--border-strong);
	}
	.tick {
		fill: var(--text-faint);
		font-size: 9.5px;
		font-family: var(--font-mono);
	}
</style>
