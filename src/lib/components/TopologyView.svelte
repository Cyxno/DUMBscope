<script lang="ts">
	/**
	 * DUMBscope topology: custom SVG dependency graph laid out in category
	 * columns (request → discovery → manager → … → media server). Health is
	 * expressed by node accents and edge colors; healthy flow gets a subtle
	 * moving highlight. Click a node to open its service drawer.
	 */
	import type { TopologyGraph, TopologyNode } from '$lib/types';
	import { CATEGORY_ORDER } from '$lib/shared/catalog';
	import { fade } from 'svelte/transition';

	let {
		graph,
		compact = false,
		onselect
	}: {
		graph: TopologyGraph;
		compact?: boolean;
		onselect?: (key: string) => void;
	} = $props();

	const NODE_W = $derived(compact ? 128 : 148);
	const NODE_H = $derived(compact ? 44 : 56);
	const COL_GAP = $derived(compact ? 150 : 190);
	const ROW_GAP = $derived(compact ? 58 : 76);
	const PAD = 18;

	let svgEl = $state<SVGSVGElement | null>(null);
	let hovered = $state<string | null>(null);

	const columns = $derived.by(() => {
		const byCategory = new Map<string, TopologyNode[]>();
		for (const node of graph.nodes) {
			const list = byCategory.get(node.category) ?? [];
			list.push(node);
			byCategory.set(node.category, list);
		}
		const present = CATEGORY_ORDER.filter((c) => byCategory.has(c));
		return present.map((category, index) => ({
			category,
			x: PAD + index * COL_GAP,
			nodes: byCategory.get(category) ?? []
		}));
	});

	const posByKey = $derived.by(() => {
		const map = new Map<string, { x: number; y: number }>();
		for (const col of columns) {
			const totalH = col.nodes.length * NODE_H + (col.nodes.length - 1) * ROW_GAP;
			const startY = PAD + Math.max(0, (maxGraphHeight - PAD * 2 - totalH) / 2);
			col.nodes.forEach((node, i) => {
				map.set(node.key, { x: col.x, y: startY + i * (NODE_H + ROW_GAP) });
			});
		}
		return map;
	});

	const maxGraphHeight = $derived.by(() => {
		const maxRows = Math.max(1, ...columns.map((c) => c.nodes.length));
		return PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP;
	});

	const width = $derived(PAD * 2 + Math.max(1, columns.length) * COL_GAP - (COL_GAP - NODE_W));
	const height = $derived(maxGraphHeight);

	function anchor(edge: { from: string; to: string }) {
		const a = posByKey.get(edge.from);
		const b = posByKey.get(edge.to);
		if (!a || !b) return null;
		const x1 = a.x + NODE_W;
		const y1 = a.y + NODE_H / 2;
		const x2 = b.x;
		const y2 = b.y + NODE_H / 2;
		const mid = (x1 + x2) / 2;
		return { x1, y1, x2, y2, d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}` };
	}

	const EDGE_COLORS: Record<string, string> = {
		healthy: 'var(--border-strong)',
		degraded: 'var(--degraded)',
		failed: 'var(--critical)',
		unknown: 'var(--border-subtle)'
	};

	function nodeAccent(node: TopologyNode): string {
		switch (node.health) {
			case 'healthy':
				return 'var(--healthy)';
			case 'degraded':
			case 'starting':
				return 'var(--degraded)';
			case 'unhealthy':
				return 'var(--critical)';
			default:
				return node.runState === 'stopped' ? 'var(--unknown)' : 'var(--unknown)';
		}
	}
</script>

<div class="topology-scroll w-full overflow-x-auto">
	<div class="min-w-full" style="width: max({width}px, 100%)">
		<svg
			bind:this={svgEl}
			viewBox="0 0 {width} {height}"
			width="100%"
			{height}
			role="list"
			aria-label="Media pipeline topology"
		>
			{#each columns as col (col.category)}
				<text x={col.x} y={11} class="col-label">{col.category.replace('-', ' ')}</text>
			{/each}

			{#each graph.edges as edge (edge.from + '->' + edge.to)}
				{@const a = anchor(edge)}
				{#if a}
					<g
						class="edge"
						class:failed={edge.health === 'failed'}
						class:degraded={edge.health === 'degraded'}
					>
						<path d={a.d} class="edge-hit" />
						<path d={a.d} class="edge-line" style="stroke: {EDGE_COLORS[edge.health]}" />
						{#if edge.health === 'healthy' && !compact}
							<path d={a.d} class="edge-flow" style="stroke: var(--accent)" />
						{/if}
						{#if edge.health === 'failed'}
							{@const mx = (a.x1 + a.x2) / 2}
							{@const my = (a.y1 + a.y2) / 2}
							<path d="M{mx - 4},{my - 4} l8,8 M{mx + 4},{my - 4} l-8,8" class="edge-cross" />
						{/if}
					</g>
				{/if}
			{/each}

			{#each graph.nodes as node, i (node.key)}
				{@const pos = posByKey.get(node.key)}
				{#if pos}
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
					<g
						class="node"
						class:hovered={hovered === node.key}
						tabindex="0"
						role="listitem"
						aria-label="{node.name}: {node.health}"
						onclick={() => onselect?.(node.key)}
						onkeydown={(e) =>
							(e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onselect?.(node.key))}
						onpointerenter={() => (hovered = node.key)}
						onpointerleave={() => (hovered = null)}
						in:fade={{ delay: i * 40, duration: 220 }}
					>
						<rect x={pos.x} y={pos.y} width={NODE_W} height={NODE_H} rx="12" class="node-box" />
						<rect
							x={pos.x}
							y={pos.y + 10}
							width="3"
							height={NODE_H - 20}
							rx="1.5"
							fill={nodeAccent(node)}
						/>
						<foreignObject x={pos.x + 10} y={pos.y + (NODE_H - 28) / 2} width="28" height="28">
							<div
								class="pointer-events-none"
								style="width:28px;height:28px"
								aria-hidden="true"
							></div>
						</foreignObject>
						<circle
							cx={pos.x + 24}
							cy={pos.y + NODE_H / 2}
							r="11"
							fill="var(--surface-3)"
							stroke="var(--border-subtle)"
						/>
						<text
							x={pos.x + 24}
							y={pos.y + NODE_H / 2 + 4}
							text-anchor="middle"
							class="node-glyph"
							fill={nodeAccent(node)}
						>
							{node.name.charAt(0).toUpperCase()}
						</text>
						<text x={pos.x + 44} y={pos.y + (compact ? NODE_H / 2 + 4 : 24)} class="node-name">
							{node.name.length > 16 ? node.name.slice(0, 15) + '…' : node.name}
						</text>
						{#if !compact}
							<text x={pos.x + 44} y={pos.y + 40} class="node-sub" fill={nodeAccent(node)}>
								{node.health}{node.runState === 'stopped' ? ' · stopped' : ''}
							</text>
						{/if}
					</g>
				{/if}
			{/each}
		</svg>
	</div>
</div>

<style>
	.col-label {
		fill: var(--text-faint);
		font-size: 10px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.12em;
	}
	.node {
		cursor: pointer;
		outline: none;
	}
	.node-box {
		fill: var(--surface-1);
		stroke: var(--border-subtle);
		transition: stroke var(--speed-fast) var(--ease-out);
	}
	.node.hovered .node-box,
	.node:focus-visible .node-box {
		stroke: var(--border-focus);
	}
	.node-name {
		fill: var(--text-primary);
		font-size: 12px;
		font-weight: 600;
	}
	.node-sub {
		font-size: 10px;
	}
	.node-glyph {
		font-size: 11px;
		font-weight: 700;
	}
	.edge-line {
		fill: none;
		stroke-width: 1.5;
		transition: stroke var(--speed-normal) var(--ease-out);
	}
	.edge-flow {
		fill: none;
		stroke-width: 1.5;
		stroke-dasharray: 6 90;
		animation: flow 3.2s linear infinite;
		opacity: 0.85;
	}
	.edge-cross {
		stroke: var(--critical);
		stroke-width: 1.75;
		stroke-linecap: round;
	}
	.edge-hit {
		fill: none;
		stroke: transparent;
		stroke-width: 12;
	}
	@keyframes flow {
		from {
			stroke-dashoffset: 96;
		}
		to {
			stroke-dashoffset: 0;
		}
	}
</style>
