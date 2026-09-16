<script lang="ts">
	/**
	 * One Safe Action button with honest execution UX (docs/ACTIONS.md §11):
	 * click → executing → accepted → (bounded follow) completed/unconfirmed/
	 * failed. "Requested" is never rendered as "found". All state transitions
	 * come from the server via runAction(); this component only renders them.
	 */
	import { runAction, type ActionRunState } from '$lib/utils/actions-client';
	import { Loader2, CircleCheck, CircleX } from '@lucide/svelte';

	let {
		actionId,
		integrationId,
		target,
		label,
		onAccepted,
		disabled = false,
		compact = false,
		ariaLabel
	}: {
		actionId: string;
		integrationId: string;
		target: Record<string, unknown>;
		label: string;
		/** Fired once the upstream accepted the command (views refresh data). */
		onAccepted?: () => void;
		disabled?: boolean;
		compact?: boolean;
		ariaLabel?: string;
	} = $props();

	let runState = $state<ActionRunState | null>(null);
	let message = $state<string | null>(null);

	const busy = $derived(runState === 'executing');

	// Reset when the target changes (e.g. drawer reopened on another item).
	$effect(() => {
		void actionId;
		void integrationId;
		void target;
		runState = null;
		message = null;
	});

	async function click(): Promise<void> {
		if (busy || disabled) return;
		const result = await runAction(actionId, integrationId, target, (update) => {
			runState = update.state;
			message = update.message;
			if (update.state === 'accepted') onAccepted?.();
		});
		runState = result.state;
		message = result.message;
	}

	function stateSuffix(): string {
		switch (runState) {
			case 'executing':
				return '…';
			case 'accepted':
				return ' ✓';
			case 'completed':
				return ' ✓';
			case 'unconfirmed':
				return ' ✓';
			case 'failed':
			case 'rejected':
				return ' ✗';
			default:
				return '';
		}
	}
</script>

<span class="inline-flex flex-col gap-0.5">
	<button
		type="button"
		class="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 font-medium text-text-secondary transition-colors hover:bg-surface-3 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 {compact
			? 'px-2 py-1 text-[10.5px]'
			: 'px-2.5 py-1.5 text-[11.5px]'} {runState === 'failed' || runState === 'rejected'
			? 'text-degraded'
			: ''}"
		{disabled}
		aria-label={ariaLabel ?? label}
		aria-busy={busy}
		title={message ?? undefined}
		data-action={actionId}
		onclick={click}
	>
		{#if busy}
			<Loader2 size={12} class="animate-spin" aria-hidden="true" />
		{:else if runState === 'completed' || runState === 'accepted' || runState === 'unconfirmed'}
			<CircleCheck size={12} class="text-healthy" aria-hidden="true" />
		{:else if runState === 'failed' || runState === 'rejected'}
			<CircleX size={12} aria-hidden="true" />
		{/if}
		{label}{stateSuffix()}
	</button>
	{#if !compact && message && (runState === 'failed' || runState === 'rejected')}
		<span class="max-w-64 text-[10.5px] leading-tight text-degraded">{message}</span>
	{/if}
</span>
