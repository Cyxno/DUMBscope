<script lang="ts">
	import Card from '$lib/components/Card.svelte';
	import NotificationsSettings from '$lib/components/NotificationsSettings.svelte';
	import IntegrationsCard from '$lib/components/IntegrationsCard.svelte';
	import Logo from '$lib/components/Logo.svelte';
	import { live } from '$lib/stores/live.svelte';
	import { prefs, updatePreference, resetPreferences } from '$lib/stores/prefs.svelte';
	import {
		DEFAULT_PREFERENCES,
		DASHBOARD_PRESETS,
		DASHBOARD_WIDGETS,
		WIDGET_LABELS,
		LANDING_OPTIONS,
		applyPreset,
		type DashboardPreset,
		type LandingPage
	} from '$lib/utils/preferences';
	import { appInfoClient } from '$lib/utils/app-info-client';
	import { copyText } from '$lib/utils/clipboard';

	// ---------------------------------------------------------------------------
	// Settings sections (DEEL 3 information architecture, brief §5)
	// ---------------------------------------------------------------------------
	const SECTIONS = [
		{ id: 'connection', label: 'Connection' },
		{ id: 'appearance', label: 'Appearance' },
		{ id: 'dashboard', label: 'Dashboard' },
		{ id: 'navigation', label: 'Navigation' },
		{ id: 'library', label: 'Library' },
		{ id: 'reliability', label: 'Reliability' },
		{ id: 'notifications', label: 'Notifications' },
		{ id: 'display', label: 'Data display' },
		{ id: 'accessibility', label: 'Accessibility' },
		{ id: 'integrations', label: 'Integrations' },
		{ id: 'about', label: 'About' }
	] as const;
	type SectionId = (typeof SECTIONS)[number]['id'];
	let section = $state<SectionId>('appearance');

	// Account-scoped state (persisted in the database).
	let dumbUrl = $state('');
	let dumbUsername = $state('');
	let dumbPassword = $state('');
	let hasCredentials = $state(false);
	let theme = $state<'system' | 'dark' | 'oled' | 'light'>(prefs.theme);
	let accent = $state<
		| 'cyan'
		| 'blue'
		| 'indigo'
		| 'violet'
		| 'teal'
		| 'emerald'
		| 'amber'
		| 'rose'
		| 'orange'
		| 'slate'
	>(prefs.accent);
	let statusInterval = $state(2);
	let metricsInterval = $state(2);
	let mountMonitoring = $state(true);
	let memoryMonitoring = $state(true);
	let memoryWarningGb = $state(3.5);
	let memoryCriticalGb = $state(4.5);

	let saving = $state(false);
	let message = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
	let diagnostics = $state<string | null>(null);
	let copiedDiagnostics = $state(false);
	let reliabilityAdvanced = $state(false);
	let autoRecovery = $state<'off' | 'ask' | 'automatic'>('off');

	$effect(() => {
		void load();
	});

	async function load() {
		const response = await fetch('/api/settings');
		if (!response.ok) return;
		const data = (await response.json()) as {
			dumbUrl: string | null;
			hasDumbCredentials: boolean;

			statusInterval: number;
			metricsInterval: number;
			mountMonitoring: boolean;
			memoryMonitoring: boolean;
			memoryWarningGb: number;
			memoryCriticalGb: number;
		};
		dumbUrl = data.dumbUrl ?? '';
		hasCredentials = data.hasDumbCredentials;
		statusInterval = data.statusInterval;
		metricsInterval = data.metricsInterval;
		mountMonitoring = data.mountMonitoring;
		memoryMonitoring = data.memoryMonitoring;
		memoryWarningGb = data.memoryWarningGb;
		memoryCriticalGb = data.memoryCriticalGb;
	}

	// Account appearance + stream settings apply immediately (brief §97/§98):
	// patched debounced, no save button.
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	function queueAccountSave() {
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			void fetch('/api/settings', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					statusInterval,
					metricsInterval,
					mountMonitoring,
					memoryMonitoring,
					memoryWarningGb,
					memoryCriticalGb
				})
			});
		}, 400);
	}

	function applyTheme() {
		// Theme/accent are browser-local preferences (§96): applied through the
		// prefs store, no save button.
		updatePreference('theme', theme);
		updatePreference('accent', accent);
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
					kind: 'ok',
					text: 'Connection updated. Streams are reconnecting.'
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

	const conn = $derived(live.connection);

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

	// ---------------------------------------------------------------------------
	// Dashboard customization helpers
	// ---------------------------------------------------------------------------
	let dashboardCustomized = $derived(prefs.dashboardPreset === 'custom');
	function applyDashboardPreset(preset: Exclude<DashboardPreset, 'custom'>) {
		const { order, hidden } = applyPreset(preset);
		updatePreference('dashboardOrder', order);
		updatePreference('dashboardHidden', hidden);
		updatePreference('dashboardPreset', preset);
	}
	function markDashboardCustom() {
		if (prefs.dashboardPreset !== 'custom') updatePreference('dashboardPreset', 'custom');
	}
	function toggleWidget(id: string) {
		const hidden = new Set(prefs.dashboardHidden);
		if (hidden.has(id)) hidden.delete(id);
		else hidden.add(id);
		updatePreference('dashboardHidden', [...hidden]);
		markDashboardCustom();
	}
	function moveWidget(id: string, delta: -1 | 1) {
		const order = [...prefs.dashboardOrder];
		const idx = order.indexOf(id);
		const target = idx + delta;
		if (idx < 0 || target < 0 || target >= order.length) return;
		[order[idx], order[target]] = [order[target]!, order[idx]!];
		updatePreference('dashboardOrder', order);
		markDashboardCustom();
	}

	// Navigation helpers (§21-§24)
	function toggleNavItem(id: string) {
		if (id === '/settings') return; // Settings must stay reachable (§21)
		const hidden = new Set(prefs.navHidden);
		if (hidden.has(id)) hidden.delete(id);
		else hidden.add(id);
		updatePreference('navHidden', [...hidden]);
	}
	function moveNavItem(id: string, delta: -1 | 1) {
		const order = [...prefs.navOrder];
		const idx = order.indexOf(id);
		const target = idx + delta;
		if (idx < 0 || target < 0 || target >= order.length) return;
		[order[idx], order[target]] = [order[target]!, order[idx]!];
		updatePreference('navOrder', order);
	}
	function resetNavigation() {
		updatePreference('navOrder', [...DEFAULT_PREFERENCES.navOrder]);
		updatePreference('navHidden', []);
		updatePreference('landingPage', '/' as LandingPage);
		updatePreference('sidebarMode', DEFAULT_PREFERENCES.sidebarMode);
	}

	const NAV_LABELS: Record<string, string> = {
		'/': 'Overview',
		'/pipeline': 'Pipeline',
		'/services': 'Services',
		'/library': 'Library',
		'/incidents': 'Incidents',
		'/logs': 'Logs',
		'/activity': 'Activity',
		'/system': 'System'
	};
</script>

<div class="mx-auto max-w-[1100px] space-y-5 px-4 py-6 md:px-8">
	<header>
		<h2 class="text-lg font-semibold tracking-tight">Settings</h2>
		<p class="mt-0.5 text-[13px] text-text-muted">
			Interface customization is per-browser and applies immediately.
		</p>
	</header>

	<!-- Section navigation (brief §5) -->
	<nav
		class="flex flex-wrap gap-1.5 rounded-xl border border-border-subtle bg-surface-1 p-2"
		aria-label="Settings sections"
	>
		{#each SECTIONS as s (s.id)}
			<button
				type="button"
				class="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors {section === s.id
					? 'bg-accent-soft text-text-primary'
					: 'text-text-muted hover:bg-surface-2 hover:text-text-secondary'}"
				onclick={() => (section = s.id)}
				aria-pressed={section === s.id}
			>
				{s.label}
			</button>
		{/each}
	</nav>

	{#if message}
		<p
			class="rounded-lg px-3 py-2 text-xs {message.kind === 'ok'
				? 'bg-healthy-soft text-text-secondary'
				: 'bg-critical-soft text-text-secondary'}"
		>
			{message.text}
		</p>
	{/if}

	{#if section === 'connection'}
		<Card title="DUMB connection">
			<div class="space-y-4">
				<label class="block">
					<span class="mb-1 block text-xs font-medium text-text-secondary">DUMB URL</span>
					<input
						type="url"
						bind:value={dumbUrl}
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
					Credentials are AES-256-GCM encrypted at rest and never sent to the browser. DUMBscope
					talks to DUMB server-side only.
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
	{/if}

	{#if section === 'appearance'}
		<Card
			title="Theme"
			subtitle="Applied immediately — previews show background, surface and accent"
		>
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{#each ['system', 'dark', 'oled', 'light'] as t (t)}
					<button
						type="button"
						class="rounded-xl border p-3 text-left transition-colors {theme === t
							? 'border-accent ring-1 ring-accent'
							: 'border-border-subtle hover:border-border-strong'}"
						onclick={() => {
							theme = t as typeof theme;
							applyTheme();
						}}
						aria-pressed={theme === t}
					>
						<span
							class="mb-2 flex h-8 overflow-hidden rounded-lg border border-border-subtle"
							aria-hidden="true"
						>
							<span
								class="w-1/2"
								style="background: {t === 'light'
									? '#f4f5f7'
									: t === 'oled'
										? '#000000'
										: '#08090b'}"
							></span>
							<span
								class="w-1/2"
								style="background: {t === 'light'
									? '#ffffff'
									: t === 'oled'
										? '#0b0d10'
										: '#13161b'}"
							></span>
						</span>
						<span class="text-xs font-medium capitalize text-text-primary">{t}</span>
					</button>
				{/each}
			</div>
		</Card>

		<Card title="Accent" subtitle="Semantic status colors are never affected by the accent">
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
				{#each ['cyan', 'blue', 'teal', 'emerald', 'indigo', 'violet', 'amber', 'orange', 'rose', 'slate'] as a (a)}
					<button
						type="button"
						class="rounded-xl border p-2.5 text-left transition-colors {accent === a
							? 'border-accent ring-1 ring-accent'
							: 'border-border-subtle hover:border-border-strong'}"
						onclick={() => {
							accent = a as typeof accent;
							applyTheme();
						}}
						aria-pressed={accent === a}
					>
						<span class="mb-1.5 flex h-6 overflow-hidden rounded-md" aria-hidden="true">
							<span class="w-2/3" style="background: var(--surface-2)"></span>
							<span
								class="w-1/3"
								style="background: {a === 'cyan'
									? '#38c7ff'
									: a === 'blue'
										? '#4d9fff'
										: a === 'teal'
											? '#2fd4b5'
											: a === 'emerald'
												? '#48d597'
												: a === 'indigo'
													? '#8b8dff'
													: a === 'violet'
														? '#b07aff'
														: a === 'amber'
															? '#f5b544'
															: a === 'orange'
																? '#f59044'
																: a === 'rose'
																	? '#f56d8d'
																	: '#9fb2cc'}"
							></span>
						</span>
						<span class="text-xs font-medium capitalize text-text-secondary">{a}</span>
					</button>
				{/each}
			</div>
		</Card>

		<Card title="Density" subtitle="Affects card padding, base type size and list rhythm">
			<div class="grid grid-cols-3 gap-2">
				{#each ['comfortable', 'compact', 'dense'] as d (d)}
					<button
						type="button"
						class="rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors {prefs.density ===
						d
							? 'border-accent bg-accent-soft text-text-primary'
							: 'border-border-subtle text-text-muted hover:border-border-strong'}"
						onclick={() => updatePreference('density', d as 'comfortable')}
						aria-pressed={prefs.density === d}
					>
						{d}
					</button>
				{/each}
			</div>
			<p class="mt-2 text-[11px] text-text-faint">
				Mobile keeps comfortable touch targets regardless of density.
			</p>
		</Card>

		<Card title="Charts" subtitle="Series colors for charts — status colors are untouched">
			<div class="grid grid-cols-3 gap-2">
				{#each ['default', 'colorblind', 'monochrome'] as palette (palette)}
					<button
						type="button"
						class="rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors {prefs.chartPalette ===
						palette
							? 'border-accent bg-accent-soft text-text-primary'
							: 'border-border-subtle text-text-muted hover:border-border-strong'}"
						onclick={() => updatePreference('chartPalette', palette as 'default')}
						aria-pressed={prefs.chartPalette === palette}
					>
						{palette === 'colorblind' ? 'Colorblind-friendly' : palette}
					</button>
				{/each}
			</div>
		</Card>

		<Card title="Motion" subtitle="System follows your operating-system preference">
			<div class="grid grid-cols-3 gap-2">
				{#each ['system', 'reduced', 'full'] as m (m)}
					<button
						type="button"
						class="rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors {prefs.motion ===
						m
							? 'border-accent bg-accent-soft text-text-primary'
							: 'border-border-subtle text-text-muted hover:border-border-strong'}"
						onclick={() => updatePreference('motion', m as 'system')}
						aria-pressed={prefs.motion === m}
					>
						{m}
					</button>
				{/each}
			</div>
			<p class="mt-2 text-[11px] text-text-faint">
				Reduced disables animations; no status information depends on motion.
			</p>
		</Card>

		<Card title="Reset interface" subtitle="Restores every customization to shipped defaults">
			<button
				type="button"
				class="rounded-lg border border-border-subtle bg-surface-2 px-3.5 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-critical hover:text-critical"
				onclick={() => {
					if (confirm('Reset all interface customization to defaults?')) resetPreferences();
				}}
			>
				Reset interface settings
			</button>
		</Card>
	{/if}

	{#if section === 'dashboard'}
		<Card
			title="Dashboard presets"
			subtitle="A starting point — fine-tune below, presets may be customized"
		>
			<div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{#each Object.entries(DASHBOARD_PRESETS) as [id, def] (id)}
					<button
						type="button"
						class="rounded-xl border p-3 text-left transition-colors {prefs.dashboardPreset === id
							? 'border-accent ring-1 ring-accent'
							: 'border-border-subtle hover:border-border-strong'}"
						onclick={() => applyDashboardPreset(id as Exclude<DashboardPreset, 'custom'>)}
						aria-pressed={prefs.dashboardPreset === id}
					>
						<span class="block text-xs font-semibold text-text-primary">{def.label}</span>
						<span class="mt-0.5 block text-[10px] leading-snug text-text-muted"
							>{def.description}</span
						>
					</button>
				{/each}
			</div>
			{#if dashboardCustomized}
				<p class="mt-2 text-[11px] text-degraded">Custom — modified from the selected preset.</p>
			{/if}
		</Card>

		<Card title="Widgets" subtitle="Visibility and order on the Overview page">
			<ul class="space-y-1.5 text-xs">
				{#each prefs.dashboardOrder as id, i (id)}
					<li class="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
						<label class="flex min-w-0 flex-1 items-center gap-2.5">
							<input
								type="checkbox"
								class="h-4 w-4 accent-[var(--accent)]"
								checked={!prefs.dashboardHidden.includes(id)}
								onchange={() => toggleWidget(id)}
							/>
							<span class="truncate font-medium text-text-primary">{WIDGET_LABELS[id] ?? id}</span>
						</label>
						<span class="flex shrink-0 gap-1">
							<button
								type="button"
								class="rounded border border-border-subtle px-2 py-0.5 text-text-muted hover:text-text-primary disabled:opacity-30"
								disabled={i === 0}
								onclick={() => moveWidget(id, -1)}
								aria-label="Move {WIDGET_LABELS[id] ?? id} up"
							>
								↑
							</button>
							<button
								type="button"
								class="rounded border border-border-subtle px-2 py-0.5 text-text-muted hover:text-text-primary disabled:opacity-30"
								disabled={i === prefs.dashboardOrder.length - 1}
								onclick={() => moveWidget(id, 1)}
								aria-label="Move {WIDGET_LABELS[id] ?? id} down"
							>
								↓
							</button>
						</span>
					</li>
				{/each}
			</ul>
			{#each DASHBOARD_WIDGETS as wid (wid)}
				{#if !prefs.dashboardOrder.includes(wid)}
					<button
						type="button"
						class="mt-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-[11px] text-text-muted hover:text-text-primary"
						onclick={() => {
							updatePreference('dashboardOrder', [...prefs.dashboardOrder, wid]);
							toggleWidget(wid);
						}}
					>
						Add {WIDGET_LABELS[wid] ?? wid}
					</button>
				{/if}
			{/each}
		</Card>
	{/if}

	{#if section === 'navigation'}
		<Card title="Sidebar" subtitle="Desktop sidebar mode — mobile keeps its own navigation">
			<div class="grid grid-cols-3 gap-2">
				{#each ['expanded', 'compact', 'icons'] as mode (mode)}
					<button
						type="button"
						class="rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors {prefs.sidebarMode ===
						mode
							? 'border-accent bg-accent-soft text-text-primary'
							: 'border-border-subtle text-text-muted hover:border-border-strong'}"
						onclick={() => updatePreference('sidebarMode', mode as 'expanded')}
						aria-pressed={prefs.sidebarMode === mode}
					>
						{mode === 'icons' ? 'Icons only' : mode}
					</button>
				{/each}
			</div>
			<p class="mt-2 text-[11px] text-text-faint">
				Icons only keeps accessible labels and tooltips; keyboard focus is preserved.
			</p>
		</Card>

		<Card title="Landing page" subtitle="Opens after login and on root navigation">
			<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
				{#each LANDING_OPTIONS as option (option.value)}
					<button
						type="button"
						class="rounded-lg border px-3 py-2 text-xs font-medium transition-colors {prefs.landingPage ===
						option.value
							? 'border-accent bg-accent-soft text-text-primary'
							: 'border-border-subtle text-text-muted hover:border-border-strong'}"
						onclick={() => updatePreference('landingPage', option.value)}
						aria-pressed={prefs.landingPage === option.value}
					>
						{option.label}
					</button>
				{/each}
			</div>
		</Card>

		<Card
			title="Navigation items"
			subtitle="Hidden items keep working via deep links — Settings stays"
		>
			<ul class="space-y-1.5 text-xs">
				{#each prefs.navOrder as id, i (id)}
					<li class="flex items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
						<label class="flex min-w-0 flex-1 items-center gap-2.5">
							<input
								type="checkbox"
								class="h-4 w-4 accent-[var(--accent)]"
								checked={!prefs.navHidden.includes(id)}
								disabled={id === '/settings'}
								onchange={() => toggleNavItem(id)}
							/>
							<span class="truncate font-medium text-text-primary"
								>{NAV_LABELS[id] ?? id}{id === '/settings' ? ' (always visible)' : ''}</span
							>
						</label>
						<span class="flex shrink-0 gap-1">
							<button
								type="button"
								class="rounded border border-border-subtle px-2 py-0.5 text-text-muted hover:text-text-primary disabled:opacity-30"
								disabled={i === 0}
								onclick={() => moveNavItem(id, -1)}
								aria-label="Move {NAV_LABELS[id] ?? id} up"
							>
								↑
							</button>
							<button
								type="button"
								class="rounded border border-border-subtle px-2 py-0.5 text-text-muted hover:text-text-primary disabled:opacity-30"
								disabled={i === prefs.navOrder.length - 1}
								onclick={() => moveNavItem(id, 1)}
								aria-label="Move {NAV_LABELS[id] ?? id} down"
							>
								↓
							</button>
						</span>
					</li>
				{/each}
			</ul>
			<button
				type="button"
				class="mt-3 rounded-lg border border-border-subtle bg-surface-2 px-3.5 py-2 text-xs font-medium text-text-secondary transition-colors hover:border-border-strong hover:text-text-primary"
				onclick={resetNavigation}
			>
				Reset navigation
			</button>
		</Card>
	{/if}

	{#if section === 'library'}
		<Card title="Default library tab" subtitle="Which view opens with the Library">
			<div class="grid grid-cols-2 gap-2 sm:grid-cols-5">
				{#each ['overview', 'tv', 'movies', 'subtitles', 'queue'] as tab (tab)}
					<button
						type="button"
						class="rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors {prefs.libraryTab ===
						tab
							? 'border-accent bg-accent-soft text-text-primary'
							: 'border-border-subtle text-text-muted hover:border-border-strong'}"
						onclick={() => updatePreference('libraryTab', tab as 'overview')}
						aria-pressed={prefs.libraryTab === tab}
					>
						{tab}
					</button>
				{/each}
			</div>
		</Card>

		<Card title="TV default view" subtitle="Grid or list for the TV browser">
			<div class="grid grid-cols-2 gap-2">
				{#each ['grid', 'list'] as v (v)}
					<button
						type="button"
						class="rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors {prefs.libraryView ===
						v
							? 'border-accent bg-accent-soft text-text-primary'
							: 'border-border-subtle text-text-muted hover:border-border-strong'}"
						onclick={() => updatePreference('libraryView', v as 'grid')}
						aria-pressed={prefs.libraryView === v}
					>
						{v}
					</button>
				{/each}
			</div>
		</Card>

		<Card title="Poster size" subtitle="Density of the poster grids">
			<div class="grid grid-cols-3 gap-2">
				{#each ['small', 'medium', 'large'] as size (size)}
					<button
						type="button"
						class="rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors {prefs.posterSize ===
						size
							? 'border-accent bg-accent-soft text-text-primary'
							: 'border-border-subtle text-text-muted hover:border-border-strong'}"
						onclick={() => updatePreference('posterSize', size as 'medium')}
						aria-pressed={prefs.posterSize === size}
					>
						{size}
					</button>
				{/each}
			</div>
		</Card>
	{/if}

	{#if section === 'reliability'}
		<Card
			title="Monitoring"
			subtitle="Read-only monitoring — DUMBscope never restarts or repairs anything"
		>
			<div class="space-y-4">
				<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
					<label class="flex items-center gap-2.5 text-xs text-text-secondary">
						<input
							type="checkbox"
							bind:checked={mountMonitoring}
							class="h-4 w-4 accent-[var(--accent)]"
						/>
						Mount monitoring (stat + bounded symlink sampling)
					</label>
					<label class="flex items-center gap-2.5 text-xs text-text-secondary">
						<input
							type="checkbox"
							bind:checked={memoryMonitoring}
							class="h-4 w-4 accent-[var(--accent)]"
						/>
						Memory anomaly detection (per-process RSS)
					</label>
				</div>
				<p class="text-[11px] text-text-faint">
					Monitoring and correlation remain read-only. Automatic recovery is disabled by default.
				</p>
			</div>
		</Card>

		<Card
			title="Recovery"
			subtitle="Single-service restart actions, executed only after explicit confirmation"
		>
			<div class="space-y-3">
				<div>
					<p class="mb-1.5 text-xs font-medium text-text-secondary">Automatic recovery</p>
					<div class="grid grid-cols-3 gap-2">
						{#each ['off', 'ask', 'automatic'] as mode (mode)}
							<button
								type="button"
								class="rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors {(mode ===
								'off'
									? autoRecovery === 'off'
									: true) && mode === 'off'
									? 'border-accent bg-accent-soft text-text-primary'
									: 'border-border-subtle text-text-faint'}"
								disabled={mode !== 'off'}
								aria-pressed={mode === 'off'}
							>
								{mode}
							</button>
						{/each}
					</div>
					<p class="mt-2 text-[11px] text-text-faint">
						Off is the only mode in this release: recovery actions always require explicit
						administrator confirmation. Ask and Automatic unlock in a future release once their
						safety proofs land.
					</p>
				</div>
				<details bind:open={reliabilityAdvanced}>
					<summary class="cursor-pointer text-xs font-medium text-text-muted">
						Advanced thresholds
					</summary>
					<div class="mt-3 space-y-3">
						<div class="grid grid-cols-2 gap-3">
							<label class="block">
								<span class="mb-1 block text-xs font-medium text-text-secondary"
									>Memory warning at {memoryWarningGb} GB</span
								>
								<input
									type="range"
									min="1"
									max="12"
									step="0.5"
									bind:value={memoryWarningGb}
									onchange={queueAccountSave}
									class="w-full accent-[var(--accent)]"
								/>
							</label>
							<label class="block">
								<span class="mb-1 block text-xs font-medium text-text-secondary"
									>Memory critical at {memoryCriticalGb} GB</span
								>
								<input
									type="range"
									min="1"
									max="12"
									step="0.5"
									bind:value={memoryCriticalGb}
									onchange={queueAccountSave}
									class="w-full accent-[var(--accent)]"
								/>
							</label>
						</div>
						<p class="text-[11px] text-text-faint">
							Persistence window: 10 minutes — a warning must hold that long before a finding opens;
							recovery must hold it before one resolves.
						</p>
						<button
							type="button"
							class="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-xs font-medium text-text-secondary hover:border-border-strong hover:text-text-primary"
							onclick={() => {
								memoryWarningGb = 3.5;
								memoryCriticalGb = 4.5;
								mountMonitoring = true;
								memoryMonitoring = true;
								queueAccountSave();
							}}
						>
							Reset reliability defaults
						</button>
					</div>
				</details>
			</div>
		</Card>
	{/if}

	{#if section === 'display'}
		<Card title="Dates & time" subtitle="How timestamps render across the app">
			<div class="space-y-3">
				<div>
					<p class="mb-1.5 text-xs font-medium text-text-secondary">Date style</p>
					<div class="grid grid-cols-3 gap-2">
						{#each ['relative', 'absolute', 'both'] as v (v)}
							<button
								type="button"
								class="rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors {prefs.dateStyle ===
								v
									? 'border-accent bg-accent-soft text-text-primary'
									: 'border-border-subtle text-text-muted hover:border-border-strong'}"
								onclick={() => updatePreference('dateStyle', v as 'relative')}
								aria-pressed={prefs.dateStyle === v}
							>
								{v}
							</button>
						{/each}
					</div>
				</div>
				<div>
					<p class="mb-1.5 text-xs font-medium text-text-secondary">Time format</p>
					<div class="grid grid-cols-3 gap-2">
						{#each ['system', '24', '12'] as v (v)}
							<button
								type="button"
								class="rounded-lg border px-3 py-2 text-xs font-medium transition-colors {prefs.timeFormat ===
								v
									? 'border-accent bg-accent-soft text-text-primary'
									: 'border-border-subtle text-text-muted hover:border-border-strong'}"
								onclick={() => updatePreference('timeFormat', v as 'system')}
								aria-pressed={prefs.timeFormat === v}
							>
								{v === 'system' ? 'System' : v === '24' ? '24-hour' : '12-hour'}
							</button>
						{/each}
					</div>
				</div>
			</div>
		</Card>

		<Card title="Units" subtitle="Memory and storage formatting">
			<div class="grid grid-cols-2 gap-4">
				<div>
					<p class="mb-1.5 text-xs font-medium text-text-secondary">Memory</p>
					<div class="grid grid-cols-3 gap-1.5">
						{#each ['auto', 'gb', 'gib'] as v (v)}
							<button
								type="button"
								class="rounded-lg border px-2 py-1.5 text-xs font-medium uppercase transition-colors {prefs.memoryUnit ===
								v
									? 'border-accent bg-accent-soft text-text-primary'
									: 'border-border-subtle text-text-muted hover:border-border-strong'}"
								onclick={() => updatePreference('memoryUnit', v as 'auto')}
								aria-pressed={prefs.memoryUnit === v}
							>
								{v === 'auto' ? 'Auto' : v.toUpperCase()}
							</button>
						{/each}
					</div>
				</div>
				<div>
					<p class="mb-1.5 text-xs font-medium text-text-secondary">Storage</p>
					<div class="grid grid-cols-5 gap-1.5">
						{#each ['auto', 'gb', 'gib', 'tb', 'tib'] as v (v)}
							<button
								type="button"
								class="rounded-lg border px-1.5 py-1.5 text-[11px] font-medium uppercase transition-colors {prefs.storageUnit ===
								v
									? 'border-accent bg-accent-soft text-text-primary'
									: 'border-border-subtle text-text-muted hover:border-border-strong'}"
								onclick={() => updatePreference('storageUnit', v as 'auto')}
								aria-pressed={prefs.storageUnit === v}
							>
								{v === 'auto' ? 'Auto' : v.toUpperCase()}
							</button>
						{/each}
					</div>
				</div>
			</div>
		</Card>

		<Card title="Status detail" subtitle="How much state vocabulary the interface uses">
			<div class="grid grid-cols-2 gap-2">
				<button
					type="button"
					class="rounded-lg border px-3 py-2 text-left transition-colors {prefs.statusDetail ===
					'simple'
						? 'border-accent bg-accent-soft'
						: 'border-border-subtle hover:border-border-strong'}"
					onclick={() => updatePreference('statusDetail', 'simple')}
					aria-pressed={prefs.statusDetail === 'simple'}
				>
					<span class="block text-xs font-medium text-text-primary">Simple</span>
					<span class="block text-[10px] text-text-muted"
						>Healthy · Running · Attention · Problem</span
					>
				</button>
				<button
					type="button"
					class="rounded-lg border px-3 py-2 text-left transition-colors {prefs.statusDetail ===
					'detailed'
						? 'border-accent bg-accent-soft'
						: 'border-border-subtle hover:border-border-strong'}"
					onclick={() => updatePreference('statusDetail', 'detailed')}
					aria-pressed={prefs.statusDetail === 'detailed'}
				>
					<span class="block text-xs font-medium text-text-primary">Detailed</span>
					<span class="block text-[10px] text-text-muted"
						>Running unverified · Degraded · Stale · Reconnecting</span
					>
				</button>
			</div>
		</Card>

		<Card title="Technical identifiers" subtitle="Off by default — keeps the main UI clean">
			<label class="flex items-center gap-2.5 text-xs text-text-secondary">
				<input
					type="checkbox"
					class="h-4 w-4 accent-[var(--accent)]"
					checked={prefs.technicalIds}
					onchange={(e) => updatePreference('technicalIds', e.currentTarget.checked)}
				/>
				Show config keys, process ids and media keys in detail views
			</label>
		</Card>
	{/if}

	{#if section === 'accessibility'}
		<Card title="Contrast & focus" subtitle="Legibility aids that never change status colors">
			<div class="space-y-3">
				<div class="grid grid-cols-2 gap-2">
					<button
						type="button"
						class="rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors {prefs.contrast ===
						'standard'
							? 'border-accent bg-accent-soft text-text-primary'
							: 'border-border-subtle text-text-muted hover:border-border-strong'}"
						onclick={() => updatePreference('contrast', 'standard')}
						aria-pressed={prefs.contrast === 'standard'}
					>
						Standard contrast
					</button>
					<button
						type="button"
						class="rounded-lg border px-3 py-2 text-xs font-medium transition-colors {prefs.contrast ===
						'high'
							? 'border-accent bg-accent-soft text-text-primary'
							: 'border-border-subtle text-text-muted hover:border-border-strong'}"
						onclick={() => updatePreference('contrast', 'high')}
						aria-pressed={prefs.contrast === 'high'}
					>
						Higher contrast
					</button>
				</div>
				<div class="grid grid-cols-2 gap-2">
					<button
						type="button"
						class="rounded-lg border px-3 py-2 text-xs font-medium transition-colors {prefs.focusOutlines ===
						'standard'
							? 'border-accent bg-accent-soft text-text-primary'
							: 'border-border-subtle text-text-muted hover:border-border-strong'}"
						onclick={() => updatePreference('focusOutlines', 'standard')}
						aria-pressed={prefs.focusOutlines === 'standard'}
					>
						Standard focus outlines
					</button>
					<button
						type="button"
						class="rounded-lg border px-3 py-2 text-xs font-medium transition-colors {prefs.focusOutlines ===
						'enhanced'
							? 'border-accent bg-accent-soft text-text-primary'
							: 'border-border-subtle text-text-muted hover:border-border-strong'}"
						onclick={() => updatePreference('focusOutlines', 'enhanced')}
						aria-pressed={prefs.focusOutlines === 'enhanced'}
					>
						Enhanced focus outlines
					</button>
				</div>
			</div>
		</Card>

		<Card title="Surfaces & status" subtitle="Reduce translucency; never rely on color alone">
			<div class="space-y-3">
				<label class="flex items-center gap-2.5 text-xs text-text-secondary">
					<input
						type="checkbox"
						class="h-4 w-4 accent-[var(--accent)]"
						checked={prefs.reduceTransparency}
						onchange={(e) => updatePreference('reduceTransparency', e.currentTarget.checked)}
					/>
					Reduce transparency (opaque surfaces, no blur)
				</label>
				<label class="flex items-center gap-2.5 text-xs text-text-secondary">
					<input
						type="checkbox"
						class="h-4 w-4 accent-[var(--accent)]"
						checked={prefs.statusLabels}
						onchange={(e) => updatePreference('statusLabels', e.currentTarget.checked)}
					/>
					Always show status labels next to dots
				</label>
				<div>
					<p class="mb-1.5 text-xs font-medium text-text-secondary">Text size</p>
					<div class="grid grid-cols-2 gap-2">
						<button
							type="button"
							class="rounded-lg border px-3 py-2 text-xs font-medium transition-colors {prefs.textSize ===
							'standard'
								? 'border-accent bg-accent-soft text-text-primary'
								: 'border-border-subtle text-text-muted hover:border-border-strong'}"
							onclick={() => updatePreference('textSize', 'standard')}
							aria-pressed={prefs.textSize === 'standard'}
						>
							Standard
						</button>
						<button
							type="button"
							class="rounded-lg border px-3 py-2 text-xs font-medium transition-colors {prefs.textSize ===
							'large'
								? 'border-accent bg-accent-soft text-text-primary'
								: 'border-border-subtle text-text-muted hover:border-border-strong'}"
							onclick={() => updatePreference('textSize', 'large')}
							aria-pressed={prefs.textSize === 'large'}
						>
							Large
						</button>
					</div>
				</div>
			</div>
		</Card>
	{/if}

	{#if section === 'integrations'}
		<IntegrationsCard />
	{/if}

	{#if section === 'notifications'}
		<NotificationsSettings />
	{:else if section === 'about'}
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
	{/if}
</div>
