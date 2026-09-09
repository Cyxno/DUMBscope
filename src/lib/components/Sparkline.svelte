<script lang="ts">
	/** Compact SVG sparkline with an optional soft area fill. */
	let {
		data,
		width = 120,
		height = 32,
		color = 'var(--accent)',
		fill = true,
		strokeWidth = 1.5
	}: {
		data: number[];
		width?: number;
		height?: number;
		color?: string;
		fill?: boolean;
		strokeWidth?: number;
	} = $props();

	const points = $derived.by(() => {
		const values = data.filter((v) => Number.isFinite(v));
		if (values.length < 2) return null;
		const min = Math.min(...values);
		const max = Math.max(...values);
		const range = max - min || 1;
		const stepX = width / (values.length - 1);
		const coords = values.map((v, i) => {
			const x = i * stepX;
			const y = height - 2 - ((v - min) / range) * (height - 4);
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});
		return {
			line: `M${coords.join(' L')}`,
			area: `M0,${height} L${coords.join(' L')} L${width},${height} Z`
		};
	});

	const gradientId = $props.id();
</script>

<svg
	viewBox="0 0 {width} {height}"
	width="100%"
	{height}
	preserveAspectRatio="none"
	aria-hidden="true"
	role="presentation"
>
	<defs>
		<linearGradient id="spark-{gradientId}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stop-color={color} stop-opacity="0.25" />
			<stop offset="100%" stop-color={color} stop-opacity="0" />
		</linearGradient>
	</defs>
	{#if points}
		{#if fill}<path d={points.area} fill="url(#spark-{gradientId})" />{/if}
		<path
			d={points.line}
			fill="none"
			stroke={color}
			stroke-width={strokeWidth}
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	{/if}
</svg>
