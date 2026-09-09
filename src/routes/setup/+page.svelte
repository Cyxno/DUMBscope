<script lang="ts">
	import { onMount } from 'svelte';
	import Logo from '$lib/components/Logo.svelte';
	import { fade, fly } from 'svelte/transition';
	import { quintOut } from 'svelte/easing';
	import { CircleCheck, CircleX, LoaderCircle, ArrowRight, ArrowLeft } from '@lucide/svelte';

	type Step = 1 | 2 | 3 | 4 | 5 | 6;

	let step = $state<Step>(1);
	let busy = $state(false);
	let error = $state<string | null>(null);

	// Step 1: setup code
	let setupCode = $state('');

	// Step 2+3: DUMB connection
	let dumbUrl = $state('');
	let dumbUsername = $state('');
	let dumbPassword = $state('');
	let testResult = $state<{
		reachable: boolean;
		health?: string;
		authRequired?: boolean;
		credentialsOk?: boolean | null;
		serviceCount?: number | null;
		error?: string;
	} | null>(null);

	// Step 4: discovery preview

	// Step 5: admin account
	let adminUsername = $state('');
	let adminPassword = $state('');

	onMount(() => {
		void fetch('/api/setup/status')
			.then((r) => r.json())
			.then((data: { needsSetup: boolean; configured: boolean }) => {
				if (!data.needsSetup && data.configured) window.location.href = '/';
			})
			.catch(() => {});
	});

	async function verifyCode(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		try {
			const response = await fetch('/api/setup/begin', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code: setupCode })
			});
			if (response.ok) {
				const data = (await response.json()) as { defaultUrl?: string | null };
				if (data.defaultUrl) dumbUrl = data.defaultUrl;
				step = 2;
			} else {
				const data = (await response.json()) as { error?: string };
				error = data.error ?? 'Invalid setup code';
			}
		} finally {
			busy = false;
		}
	}

	async function testConnection(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		testResult = null;
		try {
			const response = await fetch('/api/setup/test-dumb', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					url: dumbUrl,
					username: dumbUsername || undefined,
					password: dumbPassword || undefined
				})
			});
			const data = (await response.json()) as typeof testResult & { error?: string };
			if (!response.ok) {
				error = (data as { error?: string }).error ?? 'Connection test failed';
				return;
			}
			testResult = data;
		} finally {
			busy = false;
		}
	}

	async function complete(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		try {
			const response = await fetch('/api/setup/complete', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					url: dumbUrl,
					username: dumbUsername || undefined,
					password: dumbPassword || undefined,
					adminUsername,
					adminPassword
				})
			});
			if (response.ok) {
				window.location.href = '/';
				return;
			}
			const data = (await response.json()) as { error?: string };
			error = data.error ?? 'Setup failed';
		} finally {
			busy = false;
		}
	}

	const STEP_TITLES: Record<Step, string> = {
		1: 'Welcome to DUMBscope',
		2: 'Connect to DUMB',
		3: 'Authentication',
		4: 'Discover your stack',
		5: 'Create your admin account',
		6: 'Finish'
	};
</script>

<svelte:head>
	<title>Setup — DUMBscope</title>
</svelte:head>

<div class="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
	<div class="w-full max-w-md" in:fly={{ y: 10, duration: 240, easing: quintOut }}>
		<div class="mb-6 flex flex-col items-center gap-2.5">
			<Logo />
			<h1 class="text-lg font-semibold tracking-tight">DUMBscope setup</h1>
		</div>

		<!-- Progress dots -->
		<div class="mb-5 flex items-center justify-center gap-1.5" aria-label="Setup progress">
			{#each [1, 2, 3, 4, 5] as s (s)}
				<span
					class="h-1.5 rounded-full transition-all duration-300 {step >= s
						? 'w-6 bg-accent'
						: 'w-1.5 bg-surface-3'}"
				></span>
			{/each}
		</div>

		<div class="rounded-2xl border border-border-subtle bg-surface-1 p-6 shadow-[var(--shadow-2)]">
			<h2 class="mb-4 text-sm font-semibold text-text-primary">{STEP_TITLES[step]}</h2>

			{#key step}
				<div in:fade={{ duration: 160 }}>
					{#if step === 1}
						<p class="mb-4 text-[13px] leading-relaxed text-text-muted">
							Enter the setup code printed in the container log (<code
								class="rounded bg-surface-2 px-1 font-mono text-[11px]">docker logs dumbscope</code
							>). It is valid for 30 minutes after startup.
						</p>
						<form onsubmit={verifyCode} class="space-y-3.5">
							<input
								type="text"
								bind:value={setupCode}
								placeholder="XXXX-XXXX"
								required
								maxlength="9"
								autocomplete="off"
								class="h-10 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 text-center font-mono text-lg tracking-[0.3em] uppercase outline-none focus:border-border-focus"
								aria-label="Setup code"
							/>
							{#if error}<p
									class="rounded-lg border border-critical/40 bg-critical-soft px-3 py-2 text-xs"
									role="alert"
								>
									{error}
								</p>{/if}
							<button
								type="submit"
								disabled={busy}
								class="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
							>
								Begin setup <ArrowRight size={15} />
							</button>
						</form>
					{:else if step === 2}
						<form onsubmit={testConnection} class="space-y-3.5">
							<label class="block">
								<span class="mb-1 block text-xs font-medium text-text-secondary"
									>DUMB gateway URL</span
								>
								<input
									type="url"
									bind:value={dumbUrl}
									placeholder="http://<server-ip>:3005"
									required
									class="h-10 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 text-sm outline-none focus:border-border-focus"
								/>
							</label>
							<p class="text-[11px] text-text-faint">
								This is the published DUMB frontend/API gateway — usually port 3005 of the host
								running DUMB.
							</p>
							{#if error}<p
									class="rounded-lg border border-critical/40 bg-critical-soft px-3 py-2 text-xs"
									role="alert"
								>
									{error}
								</p>{/if}
							<div class="flex gap-2">
								<button
									type="submit"
									disabled={busy}
									class="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
								>
									{#if busy}<LoaderCircle size={15} class="animate-spin" /> Testing…{:else}Test
										connection{/if}
								</button>
							</div>
						</form>
					{:else if step === 3}
						<div class="space-y-4">
							{#if testResult?.reachable}
								<div class="space-y-1.5 text-[13px]">
									<p class="flex items-center gap-2 text-healthy">
										<CircleCheck size={15} /> DUMB gateway reachable
									</p>
									<p class="flex items-center gap-2 text-text-secondary">
										{testResult.authRequired
											? 'Authentication is enabled on DUMB'
											: 'DUMB has no authentication enabled'}
									</p>
									{#if testResult.authRequired}
										{#if testResult.credentialsOk === true}
											<p class="flex items-center gap-2 text-healthy">
												<CircleCheck size={15} /> Credentials accepted
											</p>
										{:else if testResult.credentialsOk === false}
											<p class="flex items-center gap-2 text-critical">
												<CircleX size={15} /> Credentials rejected — try again
											</p>
										{/if}
									{/if}
								</div>
							{/if}

							{#if testResult?.reachable && (!testResult.authRequired || testResult.credentialsOk === true)}
								<button
									type="button"
									class="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-bg transition-opacity hover:opacity-90"
									onclick={() => (step = 4)}
								>
									Continue <ArrowRight size={15} />
								</button>
							{:else}
								<form onsubmit={testConnection} class="space-y-3.5">
									<label class="block">
										<span class="mb-1 block text-xs font-medium text-text-secondary"
											>DUMB username</span
										>
										<input
											type="text"
											bind:value={dumbUsername}
											autocomplete="off"
											required
											class="h-10 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 text-sm outline-none focus:border-border-focus"
										/>
									</label>
									<label class="block">
										<span class="mb-1 block text-xs font-medium text-text-secondary"
											>DUMB password</span
										>
										<input
											type="password"
											bind:value={dumbPassword}
											autocomplete="new-password"
											required
											class="h-10 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 text-sm outline-none focus:border-border-focus"
										/>
									</label>
									<p class="text-[11px] text-text-faint">
										Used server-side only; encrypted at rest before anything is stored.
									</p>
									{#if error}<p
											class="rounded-lg border border-critical/40 bg-critical-soft px-3 py-2 text-xs"
											role="alert"
										>
											{error}
										</p>{/if}
									<button
										type="submit"
										disabled={busy}
										class="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
									>
										{#if busy}<LoaderCircle size={15} class="animate-spin" /> Verifying…{:else}Verify
											credentials{/if}
									</button>
									<button
										type="button"
										class="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-border-subtle text-xs text-text-muted hover:text-text-primary"
										onclick={() => (step = 2)}
									>
										<ArrowLeft size={13} /> Back
									</button>
								</form>
							{/if}
						</div>
					{:else if step === 4}
						<div class="space-y-4">
							{#if testResult?.serviceCount !== null && testResult?.serviceCount !== undefined}
								<p class="text-[13px] text-text-secondary">
									<span class="font-semibold text-text-primary">{testResult.serviceCount}</span>
									services discovered
									{#if testResult.health}· gateway reports <span class="capitalize"
											>{testResult.health}</span
										>{/if}
								</p>
								<p class="text-[11px] text-text-faint">
									All services appear automatically on the dashboard — including ones added to DUMB
									later.
								</p>
							{:else}
								<p class="text-[13px] text-text-muted">
									Services will be discovered automatically once monitoring starts.
								</p>
							{/if}
							<button
								type="button"
								class="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-bg transition-opacity hover:opacity-90"
								onclick={() => (step = 5)}
							>
								Continue <ArrowRight size={15} />
							</button>
						</div>
					{:else if step === 5}
						<form onsubmit={complete} class="space-y-3.5">
							<label class="block">
								<span class="mb-1 block text-xs font-medium text-text-secondary"
									>Admin username</span
								>
								<input
									type="text"
									bind:value={adminUsername}
									required
									minlength={3}
									autocomplete="username"
									class="h-10 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 text-sm outline-none focus:border-border-focus"
								/>
							</label>
							<label class="block">
								<span class="mb-1 block text-xs font-medium text-text-secondary"
									>Admin password (min. 10 characters)</span
								>
								<input
									type="password"
									bind:value={adminPassword}
									required
									minlength={10}
									autocomplete="new-password"
									class="h-10 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 text-sm outline-none focus:border-border-focus"
								/>
							</label>
							<p class="text-[11px] text-text-faint">
								Stored as a salted scrypt hash — the password itself never touches disk.
							</p>
							{#if error}<p
									class="rounded-lg border border-critical/40 bg-critical-soft px-3 py-2 text-xs"
									role="alert"
								>
									{error}
								</p>{/if}
							<button
								type="submit"
								disabled={busy}
								class="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-accent text-sm font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
							>
								{#if busy}<LoaderCircle size={15} class="animate-spin" /> Finishing…{:else}Finish
									setup{/if}
							</button>
						</form>
					{/if}
				</div>
			{/key}
		</div>

		<p class="mt-4 text-center text-[11px] text-text-faint">
			Read-only monitoring: DUMBscope never changes your DUMB configuration.
		</p>
	</div>
</div>
