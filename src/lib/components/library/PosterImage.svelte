<script lang="ts">
	/**
	 * Lazy poster with skeleton + initials fallback (§65/§96/§102/§132).
	 * The browser never sees upstream URLs — only our same-origin proxy.
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

	let loaded = $state(false);
	let failed = $state(false);
	let imgEl: HTMLImageElement | undefined = $state();

	$effect(() => {
		// Reset on item change (drawer reuse).
		void itemKey;
		loaded = false;
		failed = false;
	});

	$effect(() => {
		// Browser-cached images can complete before the load handler attaches.
		if (imgEl?.complete) {
			if (imgEl.naturalWidth > 0) loaded = true;
			else failed = true;
		}
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
	{#if src && !failed}
		<img
			bind:this={imgEl}
			{src}
			alt="Poster for {title}"
			loading="lazy"
			decoding="async"
			class="h-full w-full object-cover transition-opacity duration-200 {loaded
				? 'opacity-100'
				: 'opacity-0'}"
			onload={() => (loaded = true)}
			onerror={() => (failed = true)}
		/>
	{/if}
	{#if (!src || failed) && !(src && loaded)}
		<div
			class="flex h-full w-full flex-col items-center justify-center gap-1 text-text-faint"
			aria-hidden="true"
		>
			<span class="text-xl font-semibold tracking-wide">{initials}</span>
			<span class="max-w-full truncate px-2 text-[10px]">{title}</span>
		</div>
	{/if}
	{#if src && !loaded && !failed}
		<div class="absolute inset-0 animate-pulse bg-surface-3" aria-hidden="true"></div>
	{/if}
</div>
