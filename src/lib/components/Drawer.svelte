<script lang="ts">
	/**
	 * Slide-in detail drawer: desktop → right sheet, mobile → full screen.
	 * Handles focus trapping, Escape, scroll lock and backdrop click.
	 */
	import type { Snippet } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { X } from '@lucide/svelte';

	let {
		open = false,
		title,
		subtitle,
		onclose,
		children,
		footer
	}: {
		open: boolean;
		title: string;
		subtitle?: string;
		onclose: () => void;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	let panel: HTMLElement | undefined = $state();
	let previouslyFocused: Element | null = null;

	$effect(() => {
		if (open) {
			previouslyFocused = document.activeElement;
			document.body.style.overflow = 'hidden';
			const raf = requestAnimationFrame(() => {
				panel?.focus({ preventScroll: true });
			});
			return () => {
				cancelAnimationFrame(raf);
				document.body.style.overflow = '';
				(previouslyFocused as HTMLElement | null)?.focus?.();
			};
		}
	});

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.stopPropagation();
			onclose();
			return;
		}
		if (event.key === 'Tab' && panel) {
			const focusables = panel.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
			);
			if (focusables.length === 0) return;
			const first = focusables[0]!;
			const last = focusables[focusables.length - 1]!;
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		}
	}
</script>

<svelte:window onkeydown={open ? onKeydown : undefined} />

{#if open}
	<div class="fixed inset-0 z-40" role="presentation">
		<div
			class="absolute inset-0 bg-black/55 backdrop-blur-[2px]"
			transition:fade={{ duration: 150 }}
			onclick={onclose}
			aria-hidden="true"
		></div>
		<div
			bind:this={panel}
			role="dialog"
			aria-modal="true"
			aria-label={title}
			tabindex="-1"
			class="absolute inset-y-0 right-0 flex w-full max-w-[560px] flex-col border-l border-border-subtle bg-surface-1 shadow-[var(--shadow-3)] outline-none max-md:inset-x-0 max-md:max-w-none"
			transition:fly={{ x: 560, duration: 260, opacity: 1 }}
		>
			<header
				class="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4"
			>
				<div class="min-w-0">
					<h2 class="truncate text-[15px] font-semibold tracking-tight text-text-primary">
						{title}
					</h2>
					{#if subtitle}
						<p class="mt-0.5 truncate text-xs text-text-muted">{subtitle}</p>
					{/if}
				</div>
				<button
					type="button"
					class="rounded-md border border-transparent p-1.5 text-text-muted transition-colors hover:border-border-subtle hover:bg-surface-2 hover:text-text-primary"
					onclick={onclose}
					aria-label="Close drawer"
				>
					<X size={18} />
				</button>
			</header>

			<div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				{@render children()}
			</div>

			{#if footer}
				<footer class="border-t border-border-subtle px-5 py-3.5">
					{@render footer()}
				</footer>
			{/if}
		</div>
	</div>
{/if}
