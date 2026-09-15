<script lang="ts">
	/**
	 * Settings → Notifications (§10): Destinations, Rules, Quiet hours and
	 * bounded History. Secrets are write-only — the API returns masked
	 * representations and this UI never sees plaintext (§13).
	 */
	import { onMount } from 'svelte';
	import { Bell, Plus, Trash2, Send, ShieldCheck } from '@lucide/svelte';
	import { PRESETS, SEVERITIES, CATEGORIES, EVENTS } from '$lib/shared/notifications';
	import type {
		DestinationKind,
		DestinationPublic,
		NotificationRule,
		RulePreset
	} from '$lib/shared/notifications';

	interface DestinationRow extends DestinationPublic {
		lastDelivery: { at: number; result: string } | null;
		lastError: { at: number; error: string } | null;
	}

	interface HistoryEntry {
		id: number;
		at: number;
		event: string;
		destinationKind: string | null;
		ruleLabel: string | null;
		severity: string;
		category: string;
		service: string | null;
		title: string;
		result: string;
		error: string | null;
		deepLink: string | null;
	}

	let destinations: DestinationRow[] = $state([]);
	let rules: NotificationRule[] = $state([]);
	let history: HistoryEntry[] = $state([]);
	let publicBaseUrl = $state('');
	let busy = $state(false);
	let message = $state<{ text: string; ok: boolean } | null>(null);
	let browserPermission = $state<string>('unsupported');

	// Add-destination form state.
	let newKind: DestinationKind = $state('discord');
	let newLabel = $state('');
	let newWebhookUrl = $state('');
	let newBotToken = $state('');
	let newChatId = $state('');

	// Rule editor state (null = editor closed).
	interface RuleDraft {
		id: string | null;
		label: string;
		enabled: boolean;
		preset: RulePreset;
		severities: string[];
		categories: string[];
		services: string;
		events: string[];
		destinationIds: string[];
		cooldownMinutes: number;
		quietEnabled: boolean;
		quietStart: string;
		quietEnd: string;
		quietTimezone: string;
		quietBehavior: 'defer' | 'suppress';
		ratePerMinute: number | null;
	}
	let editing: RuleDraft | null = $state(null);

	const kindLabel: Record<DestinationKind, string> = {
		browser: 'Browser',
		discord: 'Discord webhook',
		telegram: 'Telegram bot'
	};

	function applyPreset(draft: RuleDraft, preset: RulePreset): void {
		draft.preset = preset;
		if (preset === 'custom') return;
		const def = PRESETS[preset];
		draft.severities = [...def.severities];
		draft.categories = [];
		draft.events = [...def.events];
		draft.cooldownMinutes = def.cooldownMinutes;
	}

	function newDraft(): RuleDraft {
		const draft: RuleDraft = {
			id: null,
			label: '',
			enabled: true,
			preset: 'warnings_critical',
			severities: [],
			categories: [],
			services: '',
			events: [],
			destinationIds: [],
			cooldownMinutes: 60,
			quietEnabled: false,
			quietStart: '22:30',
			quietEnd: '07:00',
			quietTimezone: '',
			quietBehavior: 'defer',
			ratePerMinute: null
		};
		applyPreset(draft, 'warnings_critical');
		draft.destinationIds = destinations.map((d) => d.id);
		return draft;
	}

	function toggle(list: string[], value: string): string[] {
		return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
	}

	async function refresh(): Promise<void> {
		const [destRes, ruleRes, histRes] = await Promise.all([
			fetch('/api/notifications/destinations'),
			fetch('/api/notifications/rules'),
			fetch('/api/notifications/history?limit=60')
		]);
		if (destRes.ok) destinations = (await destRes.json()).destinations ?? [];
		if (ruleRes.ok) rules = (await ruleRes.json()).rules ?? [];
		if (histRes.ok) history = (await histRes.json()).history ?? [];
	}

	onMount(() => {
		browserPermission =
			typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
		void refresh();
	});

	function flash(text: string, ok: boolean): void {
		message = { text, ok };
		setTimeout(() => (message = null), 5000);
	}

	async function addDestination(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			const config =
				newKind === 'discord'
					? { webhookUrl: newWebhookUrl }
					: newKind === 'telegram'
						? { botToken: newBotToken, chatId: newChatId }
						: undefined;
			const response = await fetch('/api/notifications/destinations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					kind: newKind,
					label: newLabel || kindLabel[newKind],
					enabled: true,
					config
				})
			});
			const body = await response.json();
			if (!response.ok) {
				flash(body.error ?? 'Could not add destination', false);
				return;
			}
			if (newKind === 'browser' && typeof Notification !== 'undefined') {
				browserPermission = Notification.permission;
			}
			flash('Destination added', true);
			newLabel = newWebhookUrl = newBotToken = newChatId = '';
			await refresh();
		} finally {
			busy = false;
		}
	}

	async function toggleDestination(destination: DestinationRow): Promise<void> {
		await fetch(`/api/notifications/destinations/${destination.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ enabled: !destination.enabled })
		});
		await refresh();
	}

	async function removeDestination(id: string): Promise<void> {
		await fetch(`/api/notifications/destinations/${id}`, { method: 'DELETE' });
		await refresh();
	}

	async function testDestination(id: string): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			const response = await fetch(`/api/notifications/destinations/${id}/test`, {
				method: 'POST'
			});
			const body = await response.json();
			flash(body.ok ? 'Test notification sent' : `Test failed: ${body.error}`, Boolean(body.ok));
			await refresh();
		} finally {
			busy = false;
		}
	}

	async function enableBrowserNotifications(): Promise<void> {
		if (typeof Notification === 'undefined') return;
		const permission = await Notification.requestPermission();
		browserPermission = permission;
		if (permission !== 'granted') return;
		const existing = destinations.find((d) => d.kind === 'browser');
		if (existing) {
			await fetch(`/api/notifications/destinations/${existing.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ enabled: true })
			});
		} else {
			newKind = 'browser';
			newLabel = 'Browser';
			await addDestination();
		}
	}

	async function saveRule(): Promise<void> {
		if (!editing || busy) return;
		busy = true;
		try {
			const payload = {
				id: editing.id ?? undefined,
				label: editing.label || 'Untitled rule',
				enabled: editing.enabled,
				preset: editing.preset,
				severities: editing.severities,
				categories: editing.categories,
				services: editing.services
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean),
				events: editing.events,
				destinationIds: editing.destinationIds,
				cooldownMinutes: editing.cooldownMinutes,
				quietEnabled: editing.quietEnabled,
				quietStart: editing.quietEnabled ? editing.quietStart : null,
				quietEnd: editing.quietEnabled ? editing.quietEnd : null,
				quietTimezone: editing.quietTimezone || null,
				quietBehavior: editing.quietBehavior,
				ratePerMinute: editing.ratePerMinute
			};
			const response = await fetch('/api/notifications/rules', {
				method: editing.id ? 'PUT' : 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload)
			});
			const body = await response.json();
			if (!response.ok) {
				flash(body.error ?? 'Could not save rule', false);
				return;
			}
			flash('Rule saved', true);
			editing = null;
			await refresh();
		} finally {
			busy = false;
		}
	}

	async function deleteRule(id: string): Promise<void> {
		await fetch('/api/notifications/rules', {
			method: 'DELETE',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id })
		});
		await refresh();
	}

	async function toggleRule(rule: NotificationRule): Promise<void> {
		await fetch('/api/notifications/rules', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ...rule, enabled: !rule.enabled })
		});
		await refresh();
	}

	async function savePublicBaseUrl(): Promise<void> {
		await fetch('/api/settings', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ notificationPublicBaseUrl: publicBaseUrl })
		});
		flash('Public base URL saved', true);
	}

	const timeFmt = (value: number) => new Date(value).toLocaleString();

	const resultTone: Record<string, string> = {
		sent: 'text-healthy',
		failed: 'text-critical',
		suppressed: 'text-text-faint',
		deferred: 'text-degraded',
		rate_limited: 'text-degraded'
	};
</script>

<div class="space-y-4">
	{#if message}
		<p
			class="rounded-lg border px-3 py-2 text-xs {message.ok
				? 'border-healthy/40 text-healthy'
				: 'border-critical/40 text-critical'}"
		>
			{message.text}
		</p>
	{/if}

	<!-- Destinations (§11) -->
	<section
		class="rounded-[14px] border border-border-subtle bg-surface-1 p-4"
		aria-label="Destinations"
	>
		<h3
			class="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.1em] text-text-faint"
		>
			<Bell size={13} /> Destinations
		</h3>
		{#if destinations.length === 0}
			<p class="mt-2 text-xs text-text-muted">No destinations configured yet.</p>
		{:else}
			<ul class="mt-3 space-y-2">
				{#each destinations as destination (destination.id)}
					<li
						class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border-subtle px-3 py-2.5"
					>
						<span class="text-[13px] font-medium text-text-primary">{destination.label}</span>
						<span class="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] text-text-muted"
							>{kindLabel[destination.kind]}</span
						>
						<span class="text-[11px] {destination.enabled ? 'text-healthy' : 'text-text-faint'}">
							{destination.enabled ? 'Enabled' : 'Disabled'}
						</span>
						{#if !destination.configured}
							<span class="text-[11px] text-critical">Not configured</span>
						{:else if destination.configMasked}
							<span class="truncate font-mono text-[10.5px] text-text-faint">
								{Object.entries(destination.configMasked)
									.map(([k, v]) => `${k}=${v}`)
									.join(' · ')}
							</span>
						{/if}
						<span class="text-[11px] text-text-muted">
							{#if destination.lastDelivery}
								Last {destination.lastDelivery.result} {timeFmt(destination.lastDelivery.at)}
							{:else}
								No deliveries yet
							{/if}
						</span>
						{#if destination.lastError}
							<span
								class="w-full truncate text-[11px] text-critical"
								title={destination.lastError.error}
							>
								{destination.lastError.error}
							</span>
						{/if}
						<div class="ml-auto flex items-center gap-1.5">
							<button
								type="button"
								class="rounded-lg border border-border-subtle px-2.5 py-1 text-[11px] text-text-muted hover:border-border-strong hover:text-text-primary"
								onclick={() => toggleDestination(destination)}
							>
								{destination.enabled ? 'Disable' : 'Enable'}
							</button>
							<button
								type="button"
								class="flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1 text-[11px] text-text-muted hover:border-border-strong hover:text-text-primary disabled:opacity-40"
								disabled={!destination.enabled || !destination.configured}
								onclick={() => testDestination(destination.id)}
							>
								<Send size={11} /> Test
							</button>
							<button
								type="button"
								class="rounded-lg border border-border-subtle px-2.5 py-1 text-[11px] text-text-muted hover:border-critical/50 hover:text-critical"
								aria-label={`Delete ${destination.label}`}
								onclick={() => removeDestination(destination.id)}
							>
								<Trash2 size={11} />
							</button>
						</div>
					</li>
				{/each}
			</ul>
		{/if}

		{#if newKind === 'browser' || browserPermission === 'granted'}
			<!-- Browser destination needs an explicit permission grant (§9) -->
		{/if}
		<div class="mt-3 flex flex-wrap items-end gap-2">
			<label class="flex flex-col gap-1 text-[11px] text-text-muted">
				Type
				<select
					class="rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs text-text-primary"
					bind:value={newKind}
				>
					<option value="discord">Discord webhook</option>
					<option value="telegram">Telegram bot</option>
					<option value="browser">Browser</option>
				</select>
			</label>
			{#if newKind !== 'browser'}
				<label class="flex flex-col gap-1 text-[11px] text-text-muted">
					Label
					<input
						class="w-40 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs text-text-primary"
						bind:value={newLabel}
						placeholder="Ops room"
					/>
				</label>
			{/if}
			{#if newKind === 'discord'}
				<label class="flex flex-1 flex-col gap-1 text-[11px] text-text-muted">
					Webhook URL
					<input
						class="w-full min-w-64 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs text-text-primary"
						type="url"
						bind:value={newWebhookUrl}
						placeholder="https://discord.com/api/webhooks/…"
					/>
				</label>
			{:else if newKind === 'telegram'}
				<label class="flex flex-col gap-1 text-[11px] text-text-muted">
					Bot token
					<input
						class="w-56 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs text-text-primary"
						type="password"
						bind:value={newBotToken}
						placeholder="123456:ABC…"
					/>
				</label>
				<label class="flex flex-col gap-1 text-[11px] text-text-muted">
					Chat ID
					<input
						class="w-32 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs text-text-primary"
						bind:value={newChatId}
						placeholder="-100…"
					/>
				</label>
			{:else}
				<p class="text-[11px] text-text-muted">
					Browser notifications require this app to be open. Permission:
					<span class={browserPermission === 'granted' ? 'text-healthy' : 'text-degraded'}
						>{browserPermission}</span
					>
					{#if browserPermission !== 'granted' && browserPermission !== 'unsupported'}
						<button
							type="button"
							class="ml-1 text-accent-text hover:underline"
							onclick={enableBrowserNotifications}
						>
							Grant permission
						</button>
					{/if}
				</p>
			{/if}
			<button
				type="button"
				class="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
				disabled={busy ||
					(newKind === 'discord' && !newWebhookUrl) ||
					(newKind === 'telegram' && (!newBotToken || !newChatId))}
				onclick={addDestination}
			>
				<Plus size={12} /> Add
			</button>
		</div>
	</section>

	<!-- Rules (§3/§4) -->
	<section class="rounded-[14px] border border-border-subtle bg-surface-1 p-4" aria-label="Rules">
		<div class="flex items-center justify-between">
			<h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-text-faint">Rules</h3>
			{#if !editing}
				<button
					type="button"
					class="flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1 text-[11px] text-text-muted hover:border-border-strong hover:text-text-primary"
					onclick={() => (editing = newDraft())}
				>
					<Plus size={11} /> New rule
				</button>
			{/if}
		</div>

		{#if editing}
			<div class="mt-3 space-y-3 rounded-xl border border-border-subtle p-3">
				<div class="flex flex-wrap items-end gap-2">
					<label class="flex flex-col gap-1 text-[11px] text-text-muted">
						Label
						<input
							class="w-44 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs"
							bind:value={editing.label}
							placeholder="Ops paging"
						/>
					</label>
					<label class="flex flex-col gap-1 text-[11px] text-text-muted">
						Preset
						<select
							class="rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs"
							value={editing.preset}
							onchange={(e) =>
								applyPreset(editing!, (e.currentTarget as HTMLSelectElement).value as RulePreset)}
						>
							{#each Object.entries(PRESETS) as [id, preset] (id)}
								<option value={id}>{preset.label}</option>
							{/each}
							<option value="custom">Custom</option>
						</select>
					</label>
					<label class="flex items-center gap-1.5 pb-1.5 text-[11px] text-text-muted">
						<input type="checkbox" bind:checked={editing.enabled} /> Enabled
					</label>
				</div>

				<div class="flex flex-wrap gap-x-5 gap-y-2 text-[11px] text-text-muted">
					<fieldset>
						<legend class="mb-1">Severities</legend>
						{#each SEVERITIES as severity (severity)}
							<label class="mr-2 inline-flex items-center gap-1">
								<input
									type="checkbox"
									checked={editing.severities.includes(severity)}
									onchange={() =>
										editing && (editing.severities = toggle(editing.severities, severity))}
								/>
								{severity}
							</label>
						{/each}
					</fieldset>
					<fieldset>
						<legend class="mb-1">Events</legend>
						{#each EVENTS as event (event)}
							<label class="mr-2 inline-flex items-center gap-1">
								<input
									type="checkbox"
									checked={editing.events.includes(event)}
									onchange={() => editing && (editing.events = toggle(editing.events, event))}
								/>
								{event}
							</label>
						{/each}
					</fieldset>
					<fieldset>
						<legend class="mb-1">Categories (empty = all)</legend>
						{#each CATEGORIES as category (category)}
							<label class="mr-2 inline-flex items-center gap-1">
								<input
									type="checkbox"
									checked={editing.categories.includes(category)}
									onchange={() =>
										editing && (editing.categories = toggle(editing.categories, category))}
								/>
								{category}
							</label>
						{/each}
					</fieldset>
					<label class="flex flex-col gap-1">
						Destinations
						<span class="flex flex-wrap gap-x-3">
							{#each destinations as destination (destination.id)}
								<label class="inline-flex items-center gap-1">
									<input
										type="checkbox"
										checked={editing.destinationIds.includes(destination.id)}
										onchange={() =>
											editing &&
											(editing.destinationIds = toggle(editing.destinationIds, destination.id))}
									/>
									{destination.label}
								</label>
							{/each}
						</span>
					</label>
				</div>

				<div class="flex flex-wrap items-end gap-3 text-[11px] text-text-muted">
					<label class="flex flex-col gap-1">
						Cooldown (min)
						<input
							type="number"
							min="0"
							max="10080"
							class="w-24 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs"
							bind:value={editing.cooldownMinutes}
						/>
					</label>
					<label class="flex flex-col gap-1">
						Rate cap (per min)
						<input
							type="number"
							min="1"
							max="60"
							class="w-24 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs"
							bind:value={editing.ratePerMinute}
							placeholder="10"
						/>
					</label>
					<label class="flex flex-col gap-1">
						Service allowlist (comma separated, empty = all)
						<input
							class="w-64 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs"
							bind:value={editing.services}
							placeholder="sonarr, radarr"
						/>
					</label>
				</div>

				<!-- Quiet hours for this rule (§6) -->
				<div class="rounded-lg border border-border-subtle p-2.5">
					<label class="flex items-center gap-1.5 text-[11px] text-text-muted">
						<input type="checkbox" bind:checked={editing.quietEnabled} /> Quiet hours
					</label>
					{#if editing.quietEnabled}
						<div class="mt-2 flex flex-wrap items-end gap-2 text-[11px] text-text-muted">
							<label class="flex flex-col gap-1">
								Start
								<input
									type="time"
									class="rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs"
									bind:value={editing.quietStart}
								/>
							</label>
							<label class="flex flex-col gap-1">
								End
								<input
									type="time"
									class="rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs"
									bind:value={editing.quietEnd}
								/>
							</label>
							<label class="flex flex-col gap-1">
								Timezone (empty = server)
								<input
									class="w-40 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs"
									bind:value={editing.quietTimezone}
									placeholder="Europe/Amsterdam"
								/>
							</label>
							<label class="flex flex-col gap-1">
								Non-critical during quiet hours
								<select
									class="rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs"
									bind:value={editing.quietBehavior}
								>
									<option value="defer">Defer until quiet hours end</option>
									<option value="suppress">Suppress</option>
								</select>
							</label>
							<p class="pb-1.5 text-text-faint">Critical always delivers.</p>
						</div>
					{/if}
				</div>

				<div class="flex gap-2">
					<button
						type="button"
						class="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
						disabled={busy || editing.destinationIds.length === 0}
						onclick={saveRule}
					>
						Save rule
					</button>
					<button
						type="button"
						class="rounded-lg border border-border-subtle px-3 py-1.5 text-xs text-text-muted"
						onclick={() => (editing = null)}
					>
						Cancel
					</button>
					{#if editing.destinationIds.length === 0}
						<p class="self-center text-[11px] text-critical">Pick at least one destination.</p>
					{/if}
				</div>
			</div>
		{/if}

		{#if rules.length === 0 && !editing}
			<p class="mt-2 text-xs text-text-muted">
				No rules yet — adding the first destination creates a “Warnings + Critical” rule
				automatically.
			</p>
		{:else}
			<ul class="mt-3 space-y-2">
				{#each rules as rule (rule.id)}
					<li
						class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border-subtle px-3 py-2.5 text-[12px]"
					>
						<span class="font-medium text-text-primary">{rule.label}</span>
						<span class="rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] text-text-muted"
							>{rule.preset.replace('_', ' ')}</span
						>
						<span class={rule.enabled ? 'text-healthy' : 'text-text-faint'}
							>{rule.enabled ? 'Enabled' : 'Disabled'}</span
						>
						<span class="text-text-muted">{rule.severities.join(', ') || 'any severity'}</span>
						<span class="text-text-faint">{rule.events.join(' · ')}</span>
						<span class="text-text-faint">cooldown {rule.cooldownMinutes}m</span>
						{#if rule.quietEnabled}
							<span class="text-text-faint"
								>quiet {rule.quietStart}–{rule.quietEnd} ({rule.quietBehavior})</span
							>
						{/if}
						<div class="ml-auto flex gap-1.5">
							<button
								type="button"
								class="rounded-lg border border-border-subtle px-2.5 py-1 text-[11px] text-text-muted hover:border-border-strong hover:text-text-primary"
								onclick={() => toggleRule(rule)}
							>
								{rule.enabled ? 'Disable' : 'Enable'}
							</button>
							<button
								type="button"
								class="rounded-lg border border-border-subtle px-2.5 py-1 text-[11px] text-text-muted hover:border-border-strong hover:text-text-primary"
								onclick={() => {
									editing = {
										id: rule.id,
										label: rule.label,
										enabled: rule.enabled,
										preset: rule.preset,
										severities: [...rule.severities],
										categories: [...rule.categories],
										services: rule.services.join(', '),
										events: [...rule.events],
										destinationIds: [...rule.destinationIds],
										cooldownMinutes: rule.cooldownMinutes,
										quietEnabled: rule.quietEnabled,
										quietStart: rule.quietStart ?? '22:30',
										quietEnd: rule.quietEnd ?? '07:00',
										quietTimezone: rule.quietTimezone ?? '',
										quietBehavior: rule.quietBehavior,
										ratePerMinute: rule.ratePerMinute
									};
								}}
							>
								Edit
							</button>
							<button
								type="button"
								class="rounded-lg border border-border-subtle px-2.5 py-1 text-[11px] text-text-muted hover:border-critical/50 hover:text-critical"
								aria-label={`Delete ${rule.label}`}
								onclick={() => deleteRule(rule.id)}
							>
								<Trash2 size={11} />
							</button>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<!-- Quiet hours & delivery defaults (§6) -->
	<section
		class="rounded-[14px] border border-border-subtle bg-surface-1 p-4"
		aria-label="Delivery defaults"
	>
		<h3
			class="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.1em] text-text-faint"
		>
			<ShieldCheck size={13} /> Quiet hours & delivery
		</h3>
		<p class="mt-2 text-[11.5px] text-text-muted">
			Quiet hours are configured per rule (see Rules). Critical findings always deliver; warnings
			defer by default; attention/info defer or suppress per rule. Outbound messages include deep
			links — set this app's public origin so they open from Discord or Telegram.
		</p>
		<div class="mt-2 flex items-end gap-2">
			<label class="flex flex-1 flex-col gap-1 text-[11px] text-text-muted">
				Public base URL (optional)
				<input
					class="w-full max-w-md rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs"
					type="url"
					placeholder="https://dumbscope.example.com"
					bind:value={publicBaseUrl}
				/>
			</label>
			<button
				type="button"
				class="rounded-lg border border-border-subtle px-3 py-1.5 text-xs text-text-muted hover:border-border-strong hover:text-text-primary"
				onclick={savePublicBaseUrl}
			>
				Save
			</button>
		</div>
	</section>

	<!-- History (§12) -->
	<section
		class="rounded-[14px] border border-border-subtle bg-surface-1 p-4"
		aria-label="Notification history"
	>
		<h3 class="text-[11px] font-bold uppercase tracking-[0.1em] text-text-faint">
			History — last 30 days
		</h3>
		{#if history.length === 0}
			<p class="mt-2 text-xs text-text-muted">Nothing yet.</p>
		{:else}
			<div class="mt-2 max-h-72 overflow-y-auto">
				<table class="w-full text-left text-[11.5px]">
					<thead class="text-text-faint">
						<tr>
							<th class="py-1 pr-2 font-medium">Time</th>
							<th class="py-1 pr-2 font-medium">Event</th>
							<th class="py-1 pr-2 font-medium">Rule</th>
							<th class="py-1 pr-2 font-medium">Destination</th>
							<th class="py-1 pr-2 font-medium">Title</th>
							<th class="py-1 font-medium">Result</th>
						</tr>
					</thead>
					<tbody class="text-text-secondary">
						{#each history as entry (entry.id)}
							<tr class="border-t border-border-subtle/60">
								<td class="py-1 pr-2 align-top text-text-muted">{timeFmt(entry.at)}</td>
								<td class="py-1 pr-2 align-top">{entry.event}</td>
								<td class="py-1 pr-2 align-top text-text-muted">{entry.ruleLabel ?? '—'}</td>
								<td class="py-1 pr-2 align-top text-text-muted">{entry.destinationKind ?? '—'}</td>
								<td class="max-w-72 truncate py-1 pr-2 align-top" title={entry.error ?? entry.title}
									>{entry.title}</td
								>
								<td class="py-1 align-top {resultTone[entry.result] ?? ''}">{entry.result}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>
