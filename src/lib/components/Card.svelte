<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		title,
		subtitle,
		actions,
		flat = false,
		padding = true,
		children,
		...rest
	}: {
		title?: string;
		subtitle?: string;
		actions?: Snippet;
		flat?: boolean;
		padding?: boolean;
		children: Snippet;
	} & HTMLAttributes<HTMLElement> = $props();
</script>

<section
	class="card rounded-[14px] border border-border-subtle bg-surface-1"
	class:!bg-transparent={flat}
	{...rest}
>
	{#if title || actions}
		<header class="flex items-center justify-between gap-3 px-4 pt-3.5 pb-1">
			<div class="min-w-0">
				{#if title}<h2 class="truncate text-[13px] font-semibold tracking-tight text-text-primary">
						{title}
					</h2>{/if}
				{#if subtitle}<p class="truncate text-xs text-text-muted">{subtitle}</p>{/if}
			</div>
			{#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
		</header>
	{/if}
	<div class={padding ? 'p-4' : ''}>
		{@render children()}
	</div>
</section>

<style>
	.card {
		box-shadow: var(--shadow-1);
	}
</style>
