<script lang="ts">
	import type { HealthStatus } from '$lib/types';
	import { healthColor } from '$lib/utils/status';

	let { health, pulse = false }: { health: HealthStatus; pulse?: boolean } = $props();

	const colorVar = $derived.by(() => {
		switch (healthColor(health)) {
			case 'healthy':
				return 'var(--healthy)';
			case 'degraded':
				return 'var(--degraded)';
			case 'critical':
				return 'var(--critical)';
			default:
				return 'var(--unknown)';
		}
	});
</script>

<span class="relative inline-flex h-2 w-2 shrink-0" role="presentation">
	{#if pulse && (health === 'unhealthy' || health === 'starting')}
		<span
			class="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
			style="background:{colorVar}"
		></span>
	{/if}
	<span class="relative inline-flex h-2 w-2 rounded-full" style="background:{colorVar}"></span>
</span>
