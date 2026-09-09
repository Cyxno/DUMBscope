<script lang="ts">
	import Card from '$lib/components/Card.svelte';
	import Logo from '$lib/components/Logo.svelte';
	import { live } from '$lib/stores/live.svelte';
	import { appInfoClient } from '$lib/utils/app-info-client';
	import { copyText } from '$lib/utils/clipboard';

	let dumbUrl = $state('');
	let dumbUsername = $state('');
	let dumbPassword = $state('');
	let hasCredentials = $state(false);
	let theme = $state<'dark' | 'oled' | 'light'>('dark');
	let accent = $state<'cyan' | 'blue' | 'indigo' | 'violet'>('cyan');
	let reducedMotion = $state(false);
	let statusInterval = $state(2);
	let metricsInterval = $state(2);

	let saving = $state(false);
	let message = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	let diagnostics = $state<string | null>(null);
	let copiedDiagnostics = $state(false);

	$effect(() => {
		void load();
	});

	async function load() {
		const response = await fetch('/api/settings');
		if (!response.ok) return;
		const data = (await response.json()) as {
			dumbUrl: string | null;
			hasDumbCredentials: boolean;
			theme: typeof theme;
			accent: typeof accent;
			reducedMotion: boolean;
			statusInterval: number;
			metricsInterval: number;
		};
		dumbUrl = data.dumbUrl ?? '';
		hasCredentials = data.hasDumbCredentials;
		theme = data.theme;
		accent = data.accent;
		reducedMotion = data.reducedMotion;
		statusInterval = data.statusInterval;
		metricsInterval = data.metricsInterval;
	}

	async function saveDisplay() {
		saving = true;
		message = null;
		try {
			const response = await fetch('/api/settings', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ theme, accent, reducedMotion, statusInterval, metricsInterval })
			});
			if (response.ok) {
				message = { kind: 'ok', text: 'Display preferences saved.' };
				applyTheme();
			} else {
				const data = (await response.json()) as { error?: string };
				message = { kind: 'error', text: data.error ?? 'Could not save settings.' };
			}
		} finally {
			saving = false;
		}
	}

	function applyTheme() {
		document.documentElement.dataset.theme = theme;
		document.documentElement.dataset.accent = accent;
		document.documentElement.dataset.reducedMotion = String(reducedMotion);
	}

	async function saveConnection() {
		saving = true;
		message = null;
		try {
			const body: Record<string, unknown> = {};
			if (dumbUrl) body.dumbUrl = dumbUrl;
			if (dumbUsername && dumbPassword) {
				body.dumbUsername = dumbUsername;
				body.dumbPassword = dumbPassword;
			}
			const response = await fetch('/api/settings', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const data = (await response.json()) as { error?: string; warning?: string };
			if (response.ok) {
				message = {
					kind: data.warning ? 'error' : 'ok',
					text: data.warning ?? 'Connection updated. Streams are reconnecting.'
				};
				dumbPassword = '';
				void live.reconnect();
			} else {
				message = { kind: 'error', text: data.error ?? 'Could not save the connection.' };
			}
		} finally {
			saving = false;
		}
	}

	async function loadDiagnostics() {
		const response = await fetch('/api/diagnostics');
		if (response.ok) {
			diagnostics = JSON.stringify(await response.json(), null, 2);
		}
	}

	async function copyDiagnostics() {
		if (!diagnostics) await loadDiagnostics();
		if (diagnostics) {
			copiedDiagnostics = await copyText(diagnostics);
			setTimeout(() => (copiedDiagnostics = false), 1500);
		}
	}

	const conn = $derived(live.connection);
</script>

<div class="mx-auto max-w-[900px] space-y-5 px-4 py-6 md:px-8">
	<header>
		<h2 class="text-lg font-semibold tracking-tight">Settings</h2>
		<p class="mt-0.5 text-[13px] text-text-muted">
			Connection, appearance and diagnostics. Changes apply immediately.
		</p>
	</header>

	{#if message}
		<div
			class="rounded-lg border px-3.5 py-2.5 text-xs {message.kind === 'ok'
				? 'border-healthy/40 bg-healthy-soft text-text-primary'
				: 'border-critical/40 bg-critical-soft text-text-primary'}"
			role="status"
		>
			{message.text}
		</div>
	{/if}

	<Card title="DUMB connection">
		<div class="space-y-3.5">
			<label class="block">
				<span class="mb-1 block text-xs font-medium text-text-secondary">Gateway URL</span>
				<input
					type="url"
					bind:value={dumbUrl}
					placeholder="http://<server-ip>:3005"
					class="h-9 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 text-[13px] outline-none focus:border-border-focus"
				/>
			</label>
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
				<label class="block">
					<span class="mb-1 block text-xs font-medium text-text-secondary">
						Username {#if hasCredentials}<span class="text-text-faint"
								>(stored — fill both fields to change)</span
							>{/if}
					</span>
					<input
						type="text"
						bind:value={dumbUsername}
						autocomplete="off"
						class="h-9 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 text-[13px] outline-none focus:border-border-focus"
					/>
				</label>
				<label class="block">
					<span class="mb-1 block text-xs font-medium text-text-secondary">Password</span>
					<input
						type="password"
						bind:value={dumbPassword}
						autocomplete="new-password"
						class="h-9 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 text-[13px] outline-none focus:border-border-focus"
					/>
				</label>
			</div>
			<p class="text-[11px] text-text-faint">
				Credentials are AES-256-GCM encrypted at rest and never sent to the browser. DUMBscope talks
				to DUMB server-side only.
			</p>
			<button
				type="button"
				disabled={saving}
				class="rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
				onclick={saveConnection}
			>
				{saving ? 'Saving…' : 'Save connection'}
			</button>
		</div>
	</Card>

	<Card title="Appearance">
		<div class="space-y-4">
			<div>
				<p class="mb-1.5 text-xs font-medium text-text-secondary">Theme</p>
				<div class="flex gap-1.5">
					{#each ['dark', 'oled', 'light'] as t (t)}
						<button
							type="button"
							class="rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition-colors {theme ===
							t
								? 'border-accent bg-accent-soft text-text-primary'
								: 'border-border-subtle text-text-muted hover:border-border-strong'}"
							onclick={() => {
								theme = t as typeof theme;
								applyTheme();
							}}
							aria-pressed={theme === t}
						>
							{t}
						</button>
					{/each}
				</div>
			</div>
			<div>
				<p class="mb-1.5 text-xs font-medium text-text-secondary">Accent</p>
				<div class="flex gap-1.5">
					{#each ['cyan', 'blue', 'indigo', 'violet'] as a (a)}
						<button
							type="button"
							class="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition-colors {accent ===
							a
								? 'border-accent bg-accent-soft text-text-primary'
								: 'border-border-subtle text-text-muted hover:border-border-strong'}"
							onclick={() => {
								accent = a as typeof accent;
								applyTheme();
							}}
							aria-pressed={accent === a}
						>
							<span class="h-2 w-2 rounded-full" style="background: var(--accent)"></span>
							{a}
						</button>
					{/each}
				</div>
			</div>
			<label class="flex items-center gap-2.5 text-xs text-text-secondary">
				<input
					type="checkbox"
					bind:checked={reducedMotion}
					class="h-4 w-4 accent-[var(--accent)]"
				/>
				Reduce motion (disables animations)
			</label>
			<div class="grid grid-cols-2 gap-3">
				<label class="block">
					<span class="mb-1 block text-xs font-medium text-text-secondary"
						>Status interval ({statusInterval}s)</span
					>
					<input
						type="range"
						min="0.5"
						max="10"
						step="0.5"
						bind:value={statusInterval}
						class="w-full accent-[var(--accent)]"
					/>
				</label>
				<label class="block">
					<span class="mb-1 block text-xs font-medium text-text-secondary"
						>Metrics interval ({metricsInterval}s)</span
					>
					<input
						type="range"
						min="0.5"
						max="10"
						step="0.5"
						bind:value={metricsInterval}
						class="w-full accent-[var(--accent)]"
					/>
				</label>
			</div>
			<button
				type="button"
				disabled={saving}
				class="rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
				onclick={saveDisplay}
			>
				{saving ? 'Saving…' : 'Save preferences'}
			</button>
		</div>
	</Card>

	<Card title="Diagnostics">
		<div class="space-y-3 text-xs">
			<dl class="grid grid-cols-2 gap-x-6 gap-y-1.5">
				{#each Object.entries(conn.streams) as [name, state] (name)}
					<div class="flex items-center justify-between">
						<dt class="capitalize text-text-muted">
							{name === 'rest' ? 'REST' : `${name} stream`}
						</dt>
						<dd
							class="font-medium capitalize"
							style="color: {state === 'live'
								? 'var(--healthy)'
								: state === 'offline' || state === 'credentials-invalid'
									? 'var(--critical)'
									: 'var(--degraded)'}"
						>
							{state}
						</dd>
					</div>
				{/each}
				<div class="flex items-center justify-between">
					<dt class="text-text-muted">Incident engine</dt>
					<dd class="font-medium text-healthy">running</dd>
				</div>
				<div class="flex items-center justify-between">
					<dt class="text-text-muted">DUMBscope DB</dt>
					<dd class="font-medium text-healthy">healthy</dd>
				</div>
			</dl>
			<div class="flex gap-2">
				<button
					type="button"
					class="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
					onclick={loadDiagnostics}
				>
					Generate diagnostics
				</button>
				<button
					type="button"
					class="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
					onclick={copyDiagnostics}
				>
					Copy diagnostics {copiedDiagnostics ? '✓' : ''}
				</button>
			</div>
			{#if diagnostics}
				<pre
					class="max-h-64 overflow-auto rounded-lg border border-border-subtle bg-surface-2 p-3 font-mono text-[11px] text-text-muted">{diagnostics}</pre>
			{/if}
			<p class="text-[11px] text-text-faint">
				The bundle is redacted: no credentials, no URLs beyond host:port, no log contents.
			</p>
		</div>
	</Card>

	<Card title="About">
		<div class="flex items-center gap-4">
			<Logo />
			<div class="text-xs">
				<p class="text-sm font-semibold text-text-primary">
					DUMBscope <span class="tnum font-normal text-text-muted">{appInfoClient.version}</span>
				</p>
				<p class="mt-0.5 text-text-muted">
					{#if appInfoClient.buildSha}build <span class="font-mono"
							>{appInfoClient.buildSha.slice(0, 10)}</span
						> ·
					{/if}
					Node {appInfoClient.nodeVersion}
					{#if live.version}· connected DUMBscope server {live.version}{/if}
				</p>
				<p class="mt-0.5 text-text-faint">
					Self-hosted observability for DUMB. No telemetry, ever.
				</p>
			</div>
		</div>
	</Card>
</div>
