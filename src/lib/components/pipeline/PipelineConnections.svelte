<script lang="ts">
	/**
	 * Stage-to-stage connector: a short orthogonal trunk with an arrowhead.
	 * Deterministic decoration only — the flow story lives in the model.
	 */
	let { status = 'flowing' }: { status?: 'flowing' | 'degraded' | 'broken' } = $props();
</script>

<div
	class="conn self-center {status === 'broken'
		? 'broken'
		: status === 'degraded'
			? 'degraded'
			: ''}"
	aria-hidden="true"
>
	<span class="line"></span>
	{#if status === 'broken'}
		<span class="cross"></span>
	{:else if status === 'degraded'}
		<span class="dot"></span>
	{/if}
	<span class="head"></span>
</div>

<style>
	.conn {
		position: relative;
		width: 38px;
		flex-shrink: 0;
		height: 14px;
		display: flex;
		align-items: center;
		color: var(--border-strong);
	}
	.conn.degraded {
		color: var(--degraded);
	}
	.conn.broken {
		color: var(--critical);
	}
	.line {
		flex: 1;
		height: 1.5px;
		background: currentColor;
	}
	.head {
		width: 0;
		height: 0;
		border-top: 3.5px solid transparent;
		border-bottom: 3.5px solid transparent;
		border-left: 6px solid currentColor;
	}
	.dot {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 5px;
		height: 5px;
		transform: translate(-50%, -50%);
		border-radius: 50%;
		background: var(--degraded);
	}
	.cross {
		position: absolute;
		left: 50%;
		top: 50%;
		width: 11px;
		height: 11px;
		transform: translate(-50%, -50%);
		background: var(--bg);
	}
	.cross::before,
	.cross::after {
		content: '';
		position: absolute;
		left: 50%;
		top: 50%;
		width: 12px;
		height: 2px;
		background: var(--critical);
		border-radius: 1px;
	}
	.cross::before {
		transform: translate(-50%, -50%) rotate(45deg);
	}
	.cross::after {
		transform: translate(-50%, -50%) rotate(-45deg);
	}
</style>
