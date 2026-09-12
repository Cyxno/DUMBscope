<script lang="ts">
	/**
	 * Lazy poster with skeleton + initials fallback (§65/§96/§102/§132).
	 * The browser never sees upstream URLs — only our same-origin proxy.
	 *
	 * Race-free by construction: skeleton and initials render underneath, the
	 * <img> paints over them once bytes arrive — no load-state gating that can
	 * miss browser-cached or out-of-order load events.
	 */
	let {
		itemKey,
		title,
		version = null,
		wide = false
	}: {
		itemKey: string | null;
		title: string;
		version?: string | null;
		wide?: boolean;
	} = $props();

	let failed = $state(false);

	$effect(() => {
		// Reset on item change (drawer reuse).
		void itemKey;
		failed = false;
	});

	const initials = $derived(
		title
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((word) => word[0]!.toUpperCase())
			.join('')
	);
	const src = $derived(
		itemKey
			? `/api/library/poster/${itemKey}${version ? `?v=${encodeURIComponent(version)}` : ''}`
			: null
	);
</script>

<div
	class="relative overflow-hidden rounded-lg border border-border-subtle bg-surface-2 {wide
		? 'aspect-video'
		: 'aspect-[2/3]'}"
>
	<!-- Fallback layer (§65): initials tile, visible until image bytes cover it. -->
	<div
		class="absolute inset-0 flex flex-col items-center justify-center gap-1 text-text-faint"
		aria-hidden="true"
	>
		<span class="text-xl font-semibold tracking-wide">{initials}</span>
		<span class="max-w-full truncate px-2 text-[10px]">{title}</span>
	</div>
	{#if src && !failed}
		<img
			{src}
			alt="Poster for {title}"
			loading="lazy"
			decoding="async"
			class="absolute inset-0 h-full w-full object-cover"
			onerror={() => (failed = true)}
		/>
	{/if}
</div>
