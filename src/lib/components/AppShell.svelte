<script lang="ts">
	import { page } from '$app/state';
	import { fade } from 'svelte/transition';
	import {
		House,
		Workflow,
		Boxes,
		Library,
		Siren,
		ScrollText,
		Activity,
		Settings,
		History,
		PanelLeftClose,
		PanelLeft,
		Search
	} from '@lucide/svelte';
	import Logo from './Logo.svelte';
	import ConnectionIndicator from './ConnectionIndicator.svelte';
	import CommandPalette from './CommandPalette.svelte';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	const COLLAPSE_KEY = 'dumbscope.sidebar.collapsed';

	let collapsed = $state(false);
	let mobileNavOpen = $state(false);
	let paletteOpen = $state(false);
	let clock = $state(new Date());

	$effect(() => {
		collapsed = localStorage.getItem(COLLAPSE_KEY) === 'true';
		const timer = setInterval(() => (clock = new Date()), 15_000);
		return () => clearInterval(timer);
	});

	function toggleCollapsed() {
		collapsed = !collapsed;
		localStorage.setItem(COLLAPSE_KEY, String(collapsed));
	}

	$effect(() => {
		function onKey(event: KeyboardEvent) {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
				event.preventDefault();
				paletteOpen = !paletteOpen;
			}
		}
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	});

	$effect(() => {
		// Close the mobile nav whenever navigation happens.
		void page.url.pathname;
		mobileNavOpen = false;
	});

	const NAV = [
		{
			group: 'Monitor',
			items: [
				{ href: '/', label: 'Overview', icon: House },
				{ href: '/pipeline', label: 'Pipeline', icon: Workflow },
				{ href: '/services', label: 'Services', icon: Boxes },
				{ href: '/library', label: 'Library', icon: Library }
			]
		},
		{
			group: 'Operate',
			items: [
				{ href: '/incidents', label: 'Incidents', icon: Siren },
				{ href: '/logs', label: 'Logs', icon: ScrollText },
				{ href: '/activity', label: 'Activity', icon: History },
				{ href: '/system', label: 'System', icon: Activity }
			]
		},
		{ group: '', items: [{ href: '/settings', label: 'Settings', icon: Settings }] }
	];

	const currentPath = $derived(page.url.pathname);
	function isActive(href: string): boolean {
		return href === '/' ? currentPath === '/' : currentPath.startsWith(href);
	}
</script>

<div class="flex h-dvh overflow-hidden bg-bg">
	<!-- Desktop sidebar -->
	<aside
		class="z-20 hidden shrink-0 flex-col border-r border-border-subtle bg-surface-1 transition-[width] duration-200 md:flex"
		style="width: {collapsed ? '64px' : '216px'}"
		aria-label="Primary"
	>
		<div class="flex h-14 items-center gap-2.5 px-3.5 {collapsed ? 'justify-center' : ''}">
			<Logo />
			{#if !collapsed}
				<span class="truncate text-[15px] font-semibold tracking-tight text-text-primary"
					>DUMBscope</span
				>
			{/if}
		</div>

		<nav class="flex-1 space-y-5 overflow-y-auto px-2.5 py-3">
			{#each NAV as section (section.group)}
				<div>
					{#if section.group && !collapsed}
						<p
							class="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-faint"
						>
							{section.group}
						</p>
					{/if}
					<ul class="space-y-0.5">
						{#each section.items as item (item.href)}
							<li>
								<a
									href={item.href}
									class="group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors
										{isActive(item.href)
										? 'bg-surface-2 text-text-primary'
										: 'text-text-muted hover:bg-surface-2/60 hover:text-text-secondary'}"
									title={collapsed ? item.label : undefined}
									aria-current={isActive(item.href) ? 'page' : undefined}
								>
									<span
										class="absolute -left-2.5 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent transition-opacity {isActive(
											item.href
										)
											? 'opacity-100'
											: 'opacity-0'}"
										aria-hidden="true"
									></span>
									<item.icon
										size={17}
										strokeWidth={1.75}
										class="shrink-0 {isActive(item.href) ? 'text-accent' : ''}"
										aria-hidden="true"
									/>
									{#if !collapsed}
										<span class="truncate">{item.label}</span>
									{/if}
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/each}
		</nav>

		<div class="border-t border-border-subtle p-2.5">
			<button
				type="button"
				class="flex w-full items-center justify-center gap-2 rounded-lg px-2.5 py-2 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-secondary"
				onclick={toggleCollapsed}
				aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
			>
				{#if collapsed}<PanelLeft size={17} strokeWidth={1.75} />{:else}<PanelLeftClose
						size={17}
						strokeWidth={1.75}
					/><span class="text-[13px]">Collapse</span>{/if}
			</button>
		</div>
	</aside>

	<!-- Mobile nav drawer -->
	{#if mobileNavOpen}
		<div class="fixed inset-0 z-40 md:hidden" role="presentation">
			<div
				class="absolute inset-0 bg-black/55"
				transition:fade={{ duration: 120 }}
				onclick={() => (mobileNavOpen = false)}
				aria-hidden="true"
			></div>
			<aside
				class="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-border-subtle bg-surface-1 shadow-[var(--shadow-3)]"
				transition:fade={{ duration: 140 }}
			>
				<div class="flex h-14 items-center gap-2.5 px-4">
					<Logo />
					<span class="text-[15px] font-semibold tracking-tight">DUMBscope</span>
				</div>
				<nav class="flex-1 space-y-4 overflow-y-auto px-3 py-3">
					{#each NAV as section (section.group)}
						<div>
							<ul class="space-y-0.5">
								{#each section.items as item (item.href)}
									<li>
										<a
											href={item.href}
											class="flex items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm font-medium {isActive(
												item.href
											)
												? 'bg-surface-2 text-text-primary'
												: 'text-text-muted'}"
										>
											<item.icon
												size={17}
												strokeWidth={1.75}
												class={isActive(item.href) ? 'text-accent' : ''}
												aria-hidden="true"
											/>
											{item.label}
										</a>
									</li>
								{/each}
							</ul>
						</div>
					{/each}
				</nav>
			</aside>
		</div>
	{/if}

	<!-- Main column -->
	<div class="flex min-w-0 flex-1 flex-col">
		<header
			class="flex h-14 shrink-0 items-center gap-3 border-b border-border-subtle bg-surface-1/80 px-4 backdrop-blur md:px-6"
		>
			<button
				type="button"
				class="rounded-lg border border-border-subtle p-1.5 text-text-muted md:hidden"
				onclick={() => (mobileNavOpen = true)}
				aria-label="Open navigation"
			>
				<Boxes size={16} />
			</button>

			<h1 class="min-w-0 truncate text-sm font-semibold tracking-tight text-text-primary">
				{#each NAV.flatMap((s) => s.items) as item (item.href)}
					{#if isActive(item.href)}{item.label}{/if}
				{/each}
			</h1>

			<div class="ml-auto flex items-center gap-2.5">
				<button
					type="button"
					class="hidden items-center gap-2 rounded-lg border border-border-subtle bg-surface-2 px-2.5 py-1.5 text-xs text-text-faint transition-colors hover:border-border-strong hover:text-text-muted sm:flex"
					onclick={() => (paletteOpen = true)}
					aria-label="Open command palette (Ctrl+K)"
				>
					<Search size={13} aria-hidden="true" />
					<span>Search…</span>
					<kbd class="rounded border border-border-subtle px-1 py-px font-mono text-[10px]">⌘K</kbd>
				</button>
				<ConnectionIndicator />
				<span class="tnum hidden text-xs text-text-muted md:inline"
					>{clock.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span
				>
			</div>
		</header>

		<main class="min-h-0 flex-1 overflow-y-auto">
			{@render children()}
		</main>
	</div>
</div>

<CommandPalette open={paletteOpen} onclose={() => (paletteOpen = false)} />
