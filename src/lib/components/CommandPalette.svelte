<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { quintOut } from 'svelte/easing';
	import { goto } from '$app/navigation';
	import {
		House,
		Workflow,
		Boxes,
		Siren,
		ScrollText,
		Activity,
		Settings,
		Search,
		CornerDownLeft,
		LogOut
	} from '@lucide/svelte';
	import { live } from '$lib/stores/live.svelte';

	let { open, onclose }: { open: boolean; onclose: () => void } = $props();

	type Item = {
		label: string;
		hint: string;
		icon: typeof House;
		action: () => void;
		keywords?: string;
	};

	const items: Item[] = [
		{
			label: 'Overview',
			hint: 'Go to overview',
			icon: House,
			keywords: 'home dashboard',
			action: () => goto('/')
		},
		{
			label: 'Pipeline',
			hint: 'Go to media pipeline',
			icon: Workflow,
			keywords: 'pipeline flow stages',
			action: () => goto('/pipeline')
		},
		{
			label: 'Services',
			hint: 'Go to services',
			icon: Boxes,
			keywords: 'processes',
			action: () => goto('/services')
		},
		{
			label: 'Incidents',
			hint: 'Show active incidents',
			icon: Siren,
			keywords: 'alerts problems',
			action: () => goto('/incidents')
		},
		{
			label: 'Logs',
			hint: 'Open the log viewer',
			icon: ScrollText,
			keywords: 'stream',
			action: () => goto('/logs')
		},
		{
			label: 'System',
			hint: 'Open system metrics',
			icon: Activity,
			keywords: 'cpu ram disk network',
			action: () => goto('/system')
		},
		{
			label: 'Settings',
			hint: 'Open settings',
			icon: Settings,
			keywords: 'configuration preferences',
			action: () => goto('/settings')
		},
		{
			label: 'Sign out',
			hint: 'End this session',
			icon: LogOut,
			keywords: 'logout',
			action: () => void signOut()
		}
	];

	async function signOut() {
		await fetch('/api/auth/logout', { method: 'POST' });
		window.location.href = '/login';
	}

	let query = $state('');
	let selected = $state(0);

	const results = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const serviceItems: Item[] = live.services
			.filter((s) => q.length > 0 && (s.name.toLowerCase().includes(q) || s.key.includes(q)))
			.slice(0, 6)
			.map((s) => ({
				label: s.name,
				hint: `Service — ${s.health}`,
				icon: Boxes,
				keywords: 'service',
				action: () => goto(`/services?service=${encodeURIComponent(s.key)}`)
			}));
		const navItems = items.filter(
			(item) =>
				q.length === 0 || item.label.toLowerCase().includes(q) || (item.keywords ?? '').includes(q)
		);
		return [...navItems.slice(0, 8), ...serviceItems];
	});

	$effect(() => {
		if (open) {
			query = '';
			selected = 0;
		}
	});

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			selected = Math.min(selected + 1, results.length - 1);
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			selected = Math.max(selected - 1, 0);
		} else if (event.key === 'Enter') {
			event.preventDefault();
			const item = results[selected];
			if (item) {
				onclose();
				item.action();
			}
		} else if (event.key === 'Escape') {
			onclose();
		}
	}

	// keep selection in range when the result list shrinks
	$effect(() => {
		if (selected >= results.length) selected = Math.max(0, results.length - 1);
	});
</script>

<svelte:window onkeydown={open ? onKeydown : undefined} />

{#if open}
	<div class="fixed inset-0 z-50" role="presentation">
		<div
			class="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
			transition:fade={{ duration: 120 }}
			onclick={onclose}
			aria-hidden="true"
		></div>
		<div
			class="absolute left-1/2 top-[14%] w-[min(92vw,560px)] -translate-x-1/2 overflow-hidden rounded-2xl border border-border-strong bg-surface-2 shadow-[var(--shadow-3)]"
			transition:fly={{ y: -12, duration: 180, opacity: 1, easing: quintOut }}
			role="dialog"
			aria-modal="true"
			aria-label="Command palette"
		>
			<div class="flex items-center gap-2.5 border-b border-border-subtle px-4">
				<Search size={16} class="shrink-0 text-text-muted" aria-hidden="true" />
				<!-- svelte-ignore a11y_autofocus -->
				<input
					autofocus
					bind:value={query}
					class="h-12 w-full bg-transparent text-sm text-text-primary outline-none placeholder:text-text-faint"
					placeholder="Search pages, services, actions…"
					type="text"
					role="combobox"
					aria-expanded="true"
					aria-controls="palette-list"
					aria-activedescendant="palette-item-{selected}"
				/>
				<kbd
					class="rounded border border-border-subtle px-1.5 py-0.5 font-mono text-[10px] text-text-faint"
					>esc</kbd
				>
			</div>

			<ul id="palette-list" class="max-h-[46vh] overflow-y-auto p-1.5" role="listbox">
				{#each results as item, i (item.label + i)}
					<li id="palette-item-{i}" role="option" aria-selected={i === selected}>
						<button
							type="button"
							class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors {i ===
							selected
								? 'bg-accent-soft text-text-primary'
								: 'text-text-secondary hover:bg-surface-3'}"
							onclick={() => {
								onclose();
								item.action();
							}}
							onpointerenter={() => (selected = i)}
						>
							<item.icon size={16} class="shrink-0 text-text-muted" aria-hidden="true" />
							<span class="truncate font-medium">{item.label}</span>
							<span class="ml-auto truncate pl-2 text-xs text-text-faint">{item.hint}</span>
							{#if i === selected}
								<CornerDownLeft size={13} class="shrink-0 text-text-faint" aria-hidden="true" />
							{/if}
						</button>
					</li>
				{:else}
					<li class="px-3 py-6 text-center text-sm text-text-muted">No matches for “{query}”</li>
				{/each}
			</ul>
		</div>
	</div>
{/if}
