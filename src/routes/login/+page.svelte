<script lang="ts">
	import Logo from '$lib/components/Logo.svelte';
	import { fade, fly } from 'svelte/transition';
	import { quintOut } from 'svelte/easing';

	let username = $state('');
	let password = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		try {
			const response = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ username, password })
			});
			if (response.ok) {
				window.location.href = '/';
				return;
			}
			const data = (await response.json()) as { error?: string };
			error = data.error ?? 'Login failed';
		} catch {
			error = 'Could not reach DUMBscope';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Sign in — DUMBscope</title>
</svelte:head>

<div class="flex min-h-dvh items-center justify-center bg-bg px-4">
	<div class="w-full max-w-sm" in:fly={{ y: 10, duration: 260, easing: quintOut }}>
		<div class="mb-7 flex flex-col items-center gap-2.5">
			<Logo />
			<h1 class="text-lg font-semibold tracking-tight">DUMBscope</h1>
			<p class="text-xs text-text-muted">Sign in to your control center</p>
		</div>

		<form
			onsubmit={submit}
			class="space-y-3.5 rounded-2xl border border-border-subtle bg-surface-1 p-6 shadow-[var(--shadow-2)]"
			in:fade={{ duration: 200 }}
		>
			<label class="block">
				<span class="mb-1 block text-xs font-medium text-text-secondary">Username</span>
				<input
					type="text"
					bind:value={username}
					autocomplete="username"
					required
					class="h-10 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 text-sm outline-none transition-colors focus:border-border-focus"
				/>
			</label>
			<label class="block">
				<span class="mb-1 block text-xs font-medium text-text-secondary">Password</span>
				<input
					type="password"
					bind:value={password}
					autocomplete="current-password"
					required
					class="h-10 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 text-sm outline-none transition-colors focus:border-border-focus"
				/>
			</label>

			{#if error}
				<p
					class="rounded-lg border border-critical/40 bg-critical-soft px-3 py-2 text-xs text-text-primary"
					role="alert"
				>
					{error}
				</p>
			{/if}

			<button
				type="submit"
				disabled={busy}
				class="h-10 w-full rounded-lg bg-accent text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
			>
				{busy ? 'Signing in…' : 'Sign in'}
			</button>
		</form>
	</div>
</div>
