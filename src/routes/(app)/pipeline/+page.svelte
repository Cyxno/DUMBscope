<script lang="ts">
	import Card from '$lib/components/Card.svelte';
	import ServiceDrawer from '$lib/components/ServiceDrawer.svelte';
	import PipelineView from '$lib/components/pipeline/PipelineView.svelte';

	let drawerKey = $state<string | null>(null);
	// Selection is page-owned so closing the drawer restores a clean state.
	let selectedKey = $state<string | null>(null);
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
