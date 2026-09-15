<script lang="ts">
	/**
	 * In-app browser notification client (§9): polls the browser-delivery
	 * endpoint while the app is open and raises desktop notifications for new
	 * entries. A desktop notification is only ever shown after the user has
	 * explicitly granted the Notification permission from Settings — no
	 * permission prompts anywhere else. Clicking a notification focuses the
	 * app and opens the deep link.
	 */
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	const POLL_MS = 15_000;
	let lastId = 0;
	let timer: ReturnType<typeof setInterval> | null = null;

	function permissionGranted(): boolean {
		return typeof Notification !== 'undefined' && Notification.permission === 'granted';
	}

	function show(delivery: {
		id: number;
		title: string;
		summary: string | null;
		deepLink: string | null;
	}): void {
		if (!permissionGranted()) return;
		try {
			const notification = new Notification(`DUMBscope · ${delivery.title}`, {
				body: delivery.summary ?? '',
				tag: `dumbscope-${delivery.id}`
			});
			notification.onclick = () => {
				window.focus();
				if (delivery.deepLink) void goto(delivery.deepLink);
				notification.close();
			};
		} catch {
			// Notification constructor can throw on some platforms; never fatal.
		}
	}

	async function poll(): Promise<void> {
		if (!permissionGranted()) return;
		try {
			const response = await fetch(`/api/notifications/browser?since=${lastId}`);
			if (!response.ok) return;
			const body = (await response.json()) as {
				deliveries: {
					id: number;
					title: string;
					summary: string | null;
					deepLink: string | null;
				}[];
			};
			for (const delivery of body.deliveries ?? []) {
				if (delivery.id > lastId) {
					lastId = delivery.id;
					show(delivery);
				}
			}
		} catch {
			// offline / logged out — retry on the next tick
		}
	}

	onMount(() => {
		if (!permissionGranted()) return;
		// Start from the newest existing entry: only notifications that arrive
		// while this tab is open are shown (no backlog pop on load).
		fetch('/api/notifications/browser?since=0')
			.then((response) => (response.ok ? response.json() : { deliveries: [] }))
			.then((body: { deliveries: { id: number }[] }) => {
				const deliveries = body.deliveries ?? [];
				lastId = deliveries.length > 0 ? deliveries[deliveries.length - 1]!.id : 0;
			})
			.catch(() => {})
			.finally(() => {
				timer = setInterval(() => void poll(), POLL_MS);
				timer.unref?.();
			});
		return () => {
			if (timer) clearInterval(timer);
		};
	});
</script>
