<script lang="ts">
	import { onMount } from 'svelte';
	import Card from '$lib/components/Card.svelte';
	import ServiceDrawer from '$lib/components/ServiceDrawer.svelte';
	import PipelineView from '$lib/components/pipeline/PipelineView.svelte';

	let drawerKey = $state<string | null>(null);
	// Selection is page-owned so closing the drawer restores a clean state.
	let selectedKey = $state<string | null>(null);

	// Library metrics (§84): one quiet metric line per service when deep
	// integration data exists. Keyed by integration type; cards match by
	// service-key prefix.
	let metrics = $state<Record<string, string> | null>(null);
	let timer: ReturnType<typeof setInterval> | undefined;

	onMount(() => {
		const load = async () => {
			const response = await fetch('/api/library');
			if (!response.ok) return;
			const payload = (await response.json()) as {
				summary: {
					tv: { missing: number } | null;
					movies: { missing: number } | null;
					subtitles: { gaps: number } | null;
				};
			};
			const next: Record<string, string> = {};
			if (payload.summary.tv) next['sonarr'] = `${payload.summary.tv.missing} missing`;
			if (payload.summary.movies) next['radarr'] = `${payload.summary.movies.missing} missing`;
			if (payload.summary.subtitles)
				next['bazarr'] = `${payload.summary.subtitles.gaps} subtitle gaps`;
			metrics = next;
		};
		void load();
		timer = setInterval(() => void load(), 60_000);
		return () => clearInterval(timer);
	});
</script>

<div class="mx-auto max-w-[1500px] space-y-5 px-4 py-6 md:px-8">
	<header>
		<h2 class="text-lg font-semibold tracking-tight">Media pipeline</h2>
		<p class="mt-0.5 text-[13px] text-text-muted">
			How media flows through your stack — from request to playback. Click a service for details.
		</p>
	</header>

	<Card padding={false}>
		<div class="p-5">
			<PipelineView
				{selectedKey}
				{metrics}
				onselect={(key) => {
					selectedKey = key === selectedKey ? null : key;
					drawerKey = selectedKey;
				}}
			/>
		</div>
	</Card>
</div>

<ServiceDrawer
	serviceKey={drawerKey}
	onclose={() => {
		drawerKey = null;
		selectedKey = null;
	}}
/>
