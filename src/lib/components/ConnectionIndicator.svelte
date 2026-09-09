<script lang="ts">
	import { live } from '$lib/stores/live.svelte';
	import { CONNECTION_LABELS } from '$lib/utils/status';
	import { relativeTime } from '$lib/utils/format';
	import { fade } from 'svelte/transition';
	import { WifiOff, Radio } from '@lucide/svelte';

	let open = $state(false);

	const connState = $derived.by(() => {
		if (live.feed === 'reconnecting' && live.connection.state !== 'offline')
			return live.connection.state;
		if (live.feed === 'stale') return 'stale';
		return live.connection.state;
	});

	const label = $derived(CONNECTION_LABELS[connState] ?? connState.toUpperCase());

	const color = $derived(
		connState === 'live'
			? 'var(--live)'
			: connState === 'stale'
				? 'var(--degraded)'
				: connState === 'offline' || connState === 'credentials-invalid'
					? 'var(--critical)'
					: 'var(--unknown)'
	);

	function toggle() {
		open = !open;
	}
	function onWindowClick(event: MouseEvent) {
		if (open && !(event.target instanceof Element && event.target.closest('.conn-popover-host'))) {
			open = false;
		}
	}
</script>

<svelte:window onclick={onWindowClick} />

<div class="conn-popover-host relative">
	<button
		type="button"
		class="flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-2 px-2.5 py-1 text-[11px] font-semibold tracking-wider transition-colors hover:border-border-strong"
		style="color:{color}"
		onclick={toggle}
		aria-expanded={open}
		aria-label="Connection status: {label}"
	>
		{#if connState === 'offline' || connState === 'credentials-invalid'}
			<WifiOff size={11} aria-hidden="true" />
		{:else}
			<span class="relative flex h-1.5 w-1.5">
				{#if connState === 'live'}
					<span
						class="absolute inline-flex h-full w-full animate-ping rounded-full opacity-70"
						style="background:{color}"
					></span>
				{/if}
				<span class="relative inline-flex h-1.5 w-1.5 rounded-full" style="background:{color}"
				></span>
			</span>
		{/if}
		{label}
	</button>

	{#if open}
		<div
			class="absolute right-0 top-9 z-50 w-72 rounded-xl border border-border-subtle bg-surface-2 p-3.5 shadow-[var(--shadow-3)]"
			transition:fade={{ duration: 100 }}
			role="dialog"
			aria-label="Connection details"
		>
			<p class="mb-2.5 flex items-center gap-2 text-xs font-semibold text-text-primary">
				<Radio size={13} class="text-text-muted" aria-hidden="true" />
				DUMB connection
			</p>
			<dl class="space-y-1.5 text-xs">
				{#each Object.entries(live.connection.streams) as [name, streamState] (name)}
					<div class="flex items-center justify-between">
						<dt class="text-text-muted capitalize">
							{name === 'rest' ? 'REST' : `${name} stream`}
						</dt>
						<dd
							class="font-medium capitalize"
							style="color: {streamState === 'live'
								? 'var(--healthy)'
								: streamState === 'offline' || streamState === 'credentials-invalid'
									? 'var(--critical)'
									: 'var(--degraded)'}"
						>
							{streamState}
						</dd>
					</div>
				{/each}
				<div class="flex items-center justify-between border-t border-border-subtle pt-1.5">
					<dt class="text-text-muted">Last update</dt>
					<dd class="tnum text-text-secondary">{relativeTime(live.connection.lastUpdateAt)}</dd>
				</div>
				<div class="flex items-center justify-between">
					<dt class="text-text-muted">Reconnect attempts</dt>
					<dd class="tnum text-text-secondary">{live.connection.reconnectAttempts}</dd>
				</div>
				{#if live.connection.lastError}
					<p class="border-t border-border-subtle pt-1.5 text-[11px] text-degraded">
						{live.connection.lastError}
					</p>
				{/if}
			</dl>
		</div>
	{/if}
</div>
