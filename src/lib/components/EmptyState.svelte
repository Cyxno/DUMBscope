<script lang="ts">
	import type { Snippet, Component } from 'svelte';
	import { CircleCheck } from '@lucide/svelte';

	let {
		title,
		description,
		icon,
		action,
		neutral = false
	}: {
		title: string;
		description?: string;
		icon?: Component<{ size?: number; strokeWidth?: number; class?: string }>;
		action?: Snippet;
		neutral?: boolean;
	} = $props();

	const Icon = $derived(icon ?? CircleCheck);
</script>

<div
	class="flex flex-col items-center justify-center gap-3 rounded-[14px] border border-dashed border-border-subtle px-6 py-12 text-center"
>
	<Icon size={28} strokeWidth={1.5} class="text-unknown" aria-hidden="true" />
	<div>
		<p class="text-sm font-semibold text-text-primary {neutral ? '' : ''}">{title}</p>
		{#if description}
			<p class="mx-auto mt-1 max-w-sm text-[13px] text-text-muted">{description}</p>
		{/if}
	</div>
	{#if action}
		{@render action()}
	{/if}
</div>
