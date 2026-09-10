<script lang="ts">
	/**
	 * Settings → Integrations (v0.2): add, test, enable/disable and remove
	 * deep-integration connections. API keys are replace-only and never
	 * echoed back (brief §34).
	 */
	import { onMount } from 'svelte';
	import Card from '$lib/components/Card.svelte';

	interface IntegrationConfig {
		id: string;
		type: string;
		url: string;
		hasApiKey: boolean;
		enabled: boolean;
		lastTestAt: number | null;
		lastTestOk: boolean | null;
		lastTestError: string | null;
	}
	interface PollerStatus {
		name: string;
		intervalMs: number;
		lastOkAt: number | null;
		lastError: string | null;
		nextRunAt: number | null;
	}
	interface IntegrationStatus {
		id: string;
		state: string;
		version: string | null;
		lastSuccessAt: number | null;
		lastError: string | null;
		pollers: PollerStatus[];
	}

	const TYPES = [
		'sonarr',
		'radarr',
		'prowlarr',
		'seerr',
		'bazarr',
		'plex',
		'tautulli',
		'decypharr',
		'infinidysk'
	];

	let configs = $state<IntegrationConfig[]>([]);
	let statuses = $state<Record<string, IntegrationStatus | null>>({});
	let message = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	let busy = $state(false);

	// add-form state
	let newType = $state('sonarr');
	let newUrl = $state('');
	let newKey = $state('');

	// replace-key state per id
	let keyEditId = $state<string | null>(null);
	let keyDraft = $state('');

	async function load() {
		const response = await fetch('/api/integrations');
		if (!response.ok) return;
		const data = (await response.json()) as {
			integrations: { config: IntegrationConfig; status: IntegrationStatus | null }[];
		};
		configs = data.integrations.map((i) => i.config);
		statuses = Object.fromEntries(data.integrations.map((i) => [i.config.id, i.status]));
	}

	onMount(() => {
		void load();
	});

	async function add(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		message = null;
		try {
			const response = await fetch('/api/integrations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ type: newType, url: newUrl })
			});
			const data = (await response.json()) as { error?: string; config?: IntegrationConfig };
			if (!response.ok || !data.config) {
				message = { kind: 'error', text: data.error ?? 'Could not save integration' };
				return;
			}
			if (newKey.trim()) {
				await fetch(`/api/integrations/${data.config.id}/key`, {
					method: 'PUT',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ apiKey: newKey.trim() })
				});
			}
			newUrl = '';
			newKey = '';
			message = { kind: 'ok', text: 'Integration saved.' };
			await load();
		} finally {
			busy = false;
		}
	}

	async function test(id: string) {
		busy = true;
		message = null;
		try {
			const response = await fetch(`/api/integrations/${id}/test`, { method: 'POST' });
			const data = (await response.json()) as { ok?: boolean; version?: string; error?: string };
			message = data.ok
				? { kind: 'ok', text: `Connection OK${data.version ? ` — v${data.version}` : ''}` }
				: { kind: 'error', text: data.error ?? 'Connection test failed' };
			await load();
		} finally {
			busy = false;
		}
	}

	async function toggleEnabled(config: IntegrationConfig) {
		await fetch(`/api/integrations/${config.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ url: config.url, enabled: !config.enabled })
		});
		await load();
	}

	async function remove(id: string) {
		await fetch(`/api/integrations/${id}`, { method: 'DELETE' });
		message = { kind: 'ok', text: 'Integration removed.' };
		await load();
	}

	async function saveKey(id: string) {
		if (!keyDraft.trim()) return;
		await fetch(`/api/integrations/${id}/key`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ apiKey: keyDraft.trim() })
		});
		keyDraft = '';
		keyEditId = null;
		message = { kind: 'ok', text: 'API key updated.' };
		await load();
	}

	function ago(ts: number | null): string {
		if (!ts) return 'never';
		const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
		if (s < 60) return `${s}s ago`;
		if (s < 3600) return `${Math.round(s / 60)}m ago`;
		return `${Math.round(s / 3600)}h ago`;
	}

	function stateColor(state: string | undefined): string {
		if (state === 'connected') return 'var(--healthy)';
		if (!state || state === 'not_configured' || state === 'disabled') return 'var(--text-faint)';
		if (state === 'auth_error' || state === 'error') return 'var(--critical)';
		return 'var(--degraded)';
	}
</script>

<Card title="Integrations">
	<div class="space-y-3 text-xs">
		<p class="text-text-muted">
			Deep monitoring connections. Read-only: DUMBscope never sends commands to your services. The
			underlying service health comes from DUMB regardless.
		</p>

		{#if configs.length === 0}
			<p class="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-text-muted">
				No integrations configured yet. Add one below — generic DUMB monitoring keeps working either
				way.
			</p>
		{/if}

		{#each configs as config (config.id)}
			{@const status = statuses[config.id]}
			<div class="rounded-lg border border-border-subtle bg-surface-2 p-3">
				<div class="flex items-center justify-between gap-2">
					<div class="min-w-0">
						<p class="flex items-center gap-1.5 font-medium capitalize text-text-primary">
							<span
								class="inline-block size-1.5 rounded-full"
								style="background: {stateColor(status?.state)}"
							></span>
							{config.id}
						</p>
						<p class="truncate text-[11px] text-text-faint">{config.url}</p>
					</div>
					<div class="flex shrink-0 items-center gap-1.5">
						<button
							type="button"
							disabled={busy}
							class="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-secondary hover:border-border-strong hover:text-text-primary"
							onclick={() => void test(config.id)}>Test</button
						>
						<button
							type="button"
							disabled={busy}
							class="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-secondary hover:border-border-strong hover:text-text-primary"
							onclick={() => void toggleEnabled(config)}
						>
							{config.enabled ? 'Disable' : 'Enable'}
						</button>
						<button
							type="button"
							disabled={busy}
							class="rounded-md border border-critical/30 px-2 py-1 text-[11px] text-critical hover:bg-critical-soft"
							onclick={() => void remove(config.id)}>Remove</button
						>
					</div>
				</div>
				<p class="mt-1 text-[11px] text-text-faint">
					{config.hasApiKey ? 'API key configured' : 'No API key'}
					{#if status?.version}
						· v{status.version}
					{/if}
					{#if status?.lastSuccessAt}
						· last OK {ago(status.lastSuccessAt)}
					{/if}
					{#if status?.lastError}
						· <span class="text-critical">{status.lastError}</span>
					{/if}
				</p>
				{#if status?.pollers && status.pollers.length > 0}
					<div class="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-text-faint">
						{#each status.pollers as p (p.name)}
							<span>
								{p.name}:{#if p.lastError}<span class="text-critical"> {p.lastError}</span>{:else}
									<span class="text-healthy">fresh</span>{/if}
								{#if p.lastOkAt}
									({ago(p.lastOkAt)})
								{/if}
							</span>
						{/each}
					</div>
				{/if}
				<div class="mt-2 flex items-center gap-1.5">
					{#if keyEditId === config.id}
						<input
							type="password"
							bind:value={keyDraft}
							placeholder="New API key"
							autocomplete="new-password"
							class="h-7 flex-1 rounded-md border border-border-subtle bg-surface-1 px-2 text-[11px] outline-none focus:border-border-focus"
						/>
						<button
							type="button"
							class="rounded-md bg-accent px-2 py-1 text-[11px] font-semibold text-bg"
							onclick={() => void saveKey(config.id)}>Save</button
						>
						<button
							type="button"
							class="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-muted"
							onclick={() => (keyEditId = null)}>Cancel</button
						>
					{:else}
						<button
							type="button"
							class="text-[11px] text-text-muted hover:text-text-primary"
							onclick={() => {
								keyEditId = config.id;
								keyDraft = '';
							}}
						>
							{config.hasApiKey ? 'Replace API key' : 'Add API key'}
						</button>
					{/if}
				</div>
			</div>
		{/each}

		<form onsubmit={add} class="space-y-2 border-t border-border-subtle pt-3">
			<div class="grid grid-cols-[130px_1fr] gap-2">
				<select
					bind:value={newType}
					class="h-9 rounded-lg border border-border-subtle bg-surface-2 px-2 text-xs outline-none focus:border-border-focus"
				>
					{#each TYPES as t (t)}
						<option value={t} class="capitalize">{t}</option>
					{/each}
				</select>
				<input
					type="url"
					bind:value={newUrl}
					placeholder="http://<server-ip>:<port>"
					required
					class="h-9 rounded-lg border border-border-subtle bg-surface-2 px-3 text-xs outline-none focus:border-border-focus"
				/>
			</div>
			<input
				type="password"
				bind:value={newKey}
				placeholder="API key (optional)"
				autocomplete="new-password"
				class="h-9 w-full rounded-lg border border-border-subtle bg-surface-2 px-3 text-xs outline-none focus:border-border-focus"
			/>
			<button
				type="submit"
				disabled={busy}
				class="h-9 w-full rounded-lg bg-accent text-xs font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
			>
				Add integration
			</button>
		</form>

		{#if message}
			<p
				role="alert"
				class="rounded-lg border px-3 py-2 {message.kind === 'ok'
					? 'border-healthy/40 bg-healthy-soft text-healthy'
					: 'border-critical/40 bg-critical-soft text-critical'}"
			>
				{message.text}
			</p>
		{/if}
	</div>
</Card>
