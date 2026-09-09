<script lang="ts">
	import type { HealthStatus } from '$lib/types';
	import { healthColor, healthLabel } from '$lib/utils/status';

	let { health, size = 'md' }: { health: HealthStatus; size?: 'sm' | 'md' } = $props();

	const sev = $derived(healthColor(health));
</script>

<span
	class="health-badge inline-flex items-center gap-1.5 rounded-full border font-medium"
	class:sm={size === 'sm'}
	class:critical={sev === 'critical'}
	class:degraded={sev === 'degraded'}
	class:healthy={sev === 'healthy'}
	class:unknown={sev === 'unknown'}
>
	<span class="h-1.5 w-1.5 rounded-full bg-current opacity-90"></span>
	{healthLabel(health)}
</span>

<style>
	.health-badge {
		border-color: var(--border-subtle);
		color: var(--text-secondary);
		background: var(--unknown-soft);
		padding: 0.2rem 0.6rem;
		font-size: 0.75rem;
	}
	.health-badge.sm {
		padding: 0.1rem 0.5rem;
		font-size: 0.7rem;
	}
	.health-badge.healthy {
		background: var(--healthy-soft);
		color: var(--healthy);
		border-color: color-mix(in srgb, var(--healthy) 25%, transparent);
	}
	.health-badge.degraded {
		background: var(--degraded-soft);
		color: var(--degraded);
		border-color: color-mix(in srgb, var(--degraded) 25%, transparent);
	}
	.health-badge.critical {
		background: var(--critical-soft);
		color: var(--critical);
		border-color: color-mix(in srgb, var(--critical) 25%, transparent);
	}
	.health-badge.unknown {
		background: var(--unknown-soft);
		color: var(--unknown);
	}
</style>
