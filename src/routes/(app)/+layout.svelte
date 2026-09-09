<script lang="ts">
	import '../../app.css';
	import AppShell from '$lib/components/AppShell.svelte';
	import { live } from '$lib/stores/live.svelte';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	$effect(() => {
		document.documentElement.dataset.theme = data.prefs.theme;
		document.documentElement.dataset.accent = data.prefs.accent;
		document.documentElement.dataset.reducedMotion = String(data.prefs.reducedMotion);
	});

	$effect(() => {
		live.start();
	});
</script>

<AppShell>
	{@render children()}
</AppShell>
