<script lang="ts">
	import { live } from '$lib/stores/live.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import { formatTime } from '$lib/utils/format';
	import { page } from '$app/state';
	import { Pause, Play, ArrowDownToLine, Copy, Check, ScrollText } from '@lucide/svelte';
	import { fly } from 'svelte/transition';
	import type { LogLevel, LogLine } from '$lib/types';

	type LevelFilter = 'all' | LogLevel;

	let paused = $state(false);
	let autoscroll = $state(true);
	let query = $state('');
	let level = $state<LevelFilter>('all');
	let processFilter = $state('all');
	let copied = $state(-1);
	let incidentContext = $state(false);

	let listEl = $state<HTMLElement | null>(null);
	let stickToBottom = $state(true);

	// Incident deep-link context: /logs?incidents=<id>&from=<ts>&to=<ts>&services=A,B
	let historyLines = $state<LogLine[]>([]);
	$effect(() => {
		const incidentParam = page.url.searchParams.get('incidents');
		const fromParam = page.url.searchParams.get('from');
		if (incidentParam && fromParam) {
			incidentContext = true;
			paused = true;
			const services = (page.url.searchParams.get('services') ?? '').split(',').filter(Boolean);
			void loadHistoryWindow(Number(fromParam), services);
		}
	});

	async function loadHistoryWindow(from: number, services: string[]) {
		// Prefill from DUMB's REST logs (redacted server-side by DUMB) for the
		// services involved in the incident; falls back to the live buffer.
		const all: LogLine[] = [];
		const targets =
			services.length > 0 ? services : live.discovered.slice(0, 5).map((d) => d.processName);
		await Promise.all(
			targets.map(async (processName) => {
				try {
					const response = await fetch(
						`/api/logs/history?process_name=${encodeURIComponent(processName)}`
					);
					if (!response.ok) return;
					const data = (await response.json()) as { lines: LogLine[] };
					all.push(...data.lines);
				} catch {
					// Skip unreachable history; live buffer still applies.
				}
			})
		);
		historyLines = all.sort((a, b) => (a.ts ?? a.receivedAt) - (b.ts ?? b.receivedAt));
	}

	const processes = $derived.by(() => {
		const set = new Set<string>();
		for (const line of live.logs) {
			if (line.process) set.add(line.process);
		}
		return [...set].sort();
	});

	const filtered = $derived.by(() => {
		const q = query.trim().toLowerCase();
		const lines = incidentContext ? [...historyLines, ...live.logs] : live.logs;
		if (incidentContext) {
			const from = Number(page.url.searchParams.get('from') ?? 0);
			const to = Number(page.url.searchParams.get('to') ?? Date.now());
			return lines
				.filter((l) => (l.ts ?? l.receivedAt) >= from && (l.ts ?? l.receivedAt) <= to)
				.filter((line) => {
					if (level !== 'all' && line.level !== level) return false;
					if (processFilter !== 'all' && line.process !== processFilter) return false;
					if (
						q &&
						!line.message.toLowerCase().includes(q) &&
						!line.process.toLowerCase().includes(q)
					)
						return false;
					return true;
				});
		}
		return lines.filter((line) => {
			if (level !== 'all' && line.level !== level) return false;
			if (processFilter !== 'all' && line.process !== processFilter) return false;
			if (q && !line.message.toLowerCase().includes(q) && !line.process.toLowerCase().includes(q))
				return false;
			return true;
		});
	});

	const LEVELS: { id: LevelFilter; label: string }[] = [
		{ id: 'all', label: 'ALL' },
		{ id: 'error', label: 'ERROR' },
		{ id: 'warn', label: 'WARN' },
		{ id: 'info', label: 'INFO' },
		{ id: 'debug', label: 'DEBUG' }
	];

	function levelColor(level: LogLevel): string {
		switch (level) {
			case 'error':
				return 'var(--critical)';
			case 'warn':
				return 'var(--degraded)';
			case 'debug':
				return 'var(--text-faint)';
			case 'raw':
				return 'var(--text-muted)';
			default:
				return 'var(--text-secondary)';
		}
	}

	function togglePause() {
		paused = !paused;
		if (!paused) {
			// Drop buffered lines while paused to jump back to live.
			autoscroll = true;
		}
	}

	$effect(() => {
		// When paused we snapshot: freeze the view by remembering the cut.
		if (paused && live.logs.length > 0) {
			pausedAt = live.logs[live.logs.length - 1]!.id;
		}
	});
	let pausedAt = $state(0);

	const visible = $derived(
		paused && pausedAt > 0 ? filtered.filter((l) => l.id <= pausedAt) : filtered
	);

	function onScroll() {
		if (!listEl) return;
		const atBottom = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 40;
		stickToBottom = atBottom;
		autoscroll = atBottom;
	}

	$effect(() => {
		if (autoscroll && visible.length > 0 && listEl) {
			listEl.scrollTop = listEl.scrollHeight;
		}
	});

	async function copyLine(index: number, line: (typeof visible)[number]) {
		const text =
			`${line.ts ? new Date(line.ts).toISOString() : ''} ${line.level.toUpperCase()} ${line.process} ${line.message}`.trim();
		try {
			await navigator.clipboard.writeText(text);
			copied = index;
			setTimeout(() => (copied = -1), 1200);
		} catch {
			// Clipboard unavailable.
		}
	}
</script>

<div class="mx-auto flex h-full max-w-[1500px] flex-col gap-4 px-4 py-6 md:px-8">
	<header class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h2 class="text-lg font-semibold tracking-tight">Logs</h2>
			<p class="mt-0.5 text-[13px] text-text-muted">
				Realtime stream from DUMB · {live.connection.streams.logs === 'live'
					? 'connected'
					: live.connection.streams.logs}
				{#if incidentContext}
					· <span class="text-degraded"
						>incident context — showing the window around the incident</span
					>
					<button
						type="button"
						class="ml-1 underline hover:text-text-primary"
						onclick={() => {
							incidentContext = false;
							paused = false;
						}}>clear</button
					>
				{/if}
			</p>
		</div>
		<div class="flex items-center gap-2">
			<input
				type="search"
				bind:value={query}
				placeholder="Search logs…"
				class="h-9 w-48 rounded-lg border border-border-subtle bg-surface-1 px-3 text-[13px] outline-none placeholder:text-text-faint focus:border-border-focus"
				aria-label="Search logs"
			/>
			<button
				type="button"
				class="flex items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-1 px-2.5 py-1.5 text-xs font-medium {paused
					? 'text-degraded'
					: 'text-text-secondary'} transition-colors hover:border-border-strong"
				onclick={togglePause}
				aria-pressed={paused}
			>
				{#if paused}<Play size={13} aria-label="Resume live stream" /> Resume{:else}<Pause
						size={13}
						aria-label="Pause live stream"
					/> Pause{/if}
			</button>
			<button
				type="button"
				class="rounded-lg border border-border-subtle bg-surface-1 p-1.5 text-text-muted transition-colors hover:border-border-strong hover:text-text-primary {stickToBottom
					? 'opacity-0'
					: ''}"
				onclick={() => {
					autoscroll = true;
					stickToBottom = true;
					if (listEl) listEl.scrollTop = listEl.scrollHeight;
				}}
				aria-label="Jump to bottom"
			>
				<ArrowDownToLine size={15} />
			</button>
		</div>
	</header>

	<div class="flex flex-wrap items-center gap-1.5">
		{#each LEVELS as l (l.id)}
			<button
				type="button"
				class="rounded-full border px-3 py-1 font-mono text-[11px] font-semibold transition-colors {level ===
				l.id
					? 'border-accent bg-accent-soft text-text-primary'
					: 'border-border-subtle text-text-muted hover:border-border-strong'}"
				onclick={() => (level = l.id)}
				aria-pressed={level === l.id}
			>
				{l.label}
			</button>
		{/each}
		<select
			bind:value={processFilter}
			class="ml-1 h-8 rounded-lg border border-border-subtle bg-surface-1 px-2 text-xs text-text-secondary"
			aria-label="Filter by service"
		>
			<option value="all">All services</option>
			{#each processes as proc (proc)}
				<option value={proc}>{proc}</option>
			{/each}
		</select>
		<span class="tnum ml-auto text-[11px] text-text-faint">{visible.length} lines</span>
	</div>

	<div
		bind:this={listEl}
		class="min-h-[300px] flex-1 overflow-y-auto rounded-[14px] border border-border-subtle bg-surface-1 p-1 font-mono text-[12px] leading-[1.7]"
		onscroll={onScroll}
		role="log"
		aria-label="Log stream"
	>
		{#if visible.length === 0}
			<div class="flex h-full items-center justify-center p-8">
				<EmptyState
					icon={ScrollText}
					title={live.connection.streams.logs === 'live'
						? 'Waiting for log lines…'
						: 'Log stream offline'}
					description={live.connection.streams.logs === 'live'
						? 'Lines will appear here as services log output.'
						: 'Reconnect DUMB to stream logs. History is available per service from DUMB once connected.'}
					neutral
				/>
			</div>
		{:else}
			{#each visible.slice(-400) as line, i (line.id)}
				<div
					class="group flex items-start gap-2.5 rounded px-2 py-px hover:bg-surface-2"
					in:fly={{ y: 3, duration: 90 }}
				>
					<span class="tnum shrink-0 pt-px text-text-faint"
						>{formatTime(line.ts ?? line.receivedAt)}</span
					>
					<button
						type="button"
						class="w-[52px] shrink-0 text-left font-bold uppercase {line.level === 'error'
							? 'text-critical'
							: line.level === 'warn'
								? 'text-degraded'
								: line.level === 'debug'
									? 'text-text-faint'
									: 'text-text-muted'}"
						style="color: {level === 'all' ? undefined : levelColor(line.level)}"
						onclick={() => (level = level === line.level ? 'all' : (line.level as LevelFilter))}
						title="Filter on {line.level}"
					>
						{line.level}
					</button>
					{#if line.process}
						<span class="w-36 shrink-0 truncate text-text-muted">{line.process}</span>
					{/if}
					<span
						class="min-w-0 break-words text-text-secondary"
						style="color: {line.level === 'error' ? 'var(--critical)' : undefined}"
					>
						{line.message}
					</span>
					<button
						type="button"
						class="ml-auto shrink-0 p-0.5 text-text-faint opacity-0 transition-opacity hover:text-text-primary group-hover:opacity-100"
						onclick={() => copyLine(i, line)}
						aria-label="Copy line"
					>
						{#if copied === i}<Check size={12} class="text-healthy" />{:else}<Copy size={12} />{/if}
					</button>
				</div>
			{/each}
		{/if}
	</div>
</div>
