<script lang="ts">
	import '../../app.css';
	import AppShell from '$lib/components/AppShell.svelte';
	import BrowserNotifications from '$lib/components/BrowserNotifications.svelte';
	import { live } from '$lib/stores/live.svelte';
	import { initPreferences } from '$lib/stores/prefs.svelte';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let { data, children }: { data: LayoutData; children: Snippet } = $props();

	$effect(() => {
		// Account theme/accent seed the browser-local preferences on first run;
		// after that the local customization is authoritative (§96/§100).
		initPreferences({ theme: data.prefs.theme, accent: data.prefs.accent });
		live.start();
	});
</script>

<BrowserNotifications />
<AppShell>
	{@render children()}
</AppShell>
