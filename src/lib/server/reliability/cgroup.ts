/**
 * DUMB container cgroup v2 memory observability (brief §3).
 *
 * DUMB runs in one container with memory.high = 6.5 GiB and memory.max = 8 GiB
 * (production). The kernel exposes the authoritative picture in cgroupfs:
 * memory.current, memory.high/max, memory.stat (anon/file/shmem/slab), the
 * memory.events counters and the pressure counters (pgscan, workingset
 * refault). None of that travels through DUMB's metrics stream.
 *
 * Two rules drive the interpretation and must survive every refactor:
 *
 *   1. A high memory.current alone is NOT a problem — the kernel uses every
 *      byte of allowance as page cache by design.
 *   2. Real pressure is rate-based: soft-limit reclaim (memory.events.high
 *      moving), hard-limit hits (memory.events.max moving), direct reclaim
 *      (pgscan_direct) and file refaults — with OOM/OOM-kill as the extreme.
 *
 * Sources, in priority order (auto-selected per sample):
 *   - cgroupfs: a read-only mount of the DUMB container's cgroup directory
 *     (env DUMBSCOPE_DUMB_CGROUP_PATH, or DUMBSCOPE_DUMB_CGROUP_PARENT plus
 *     the container id). Richest data, no extra pollers involved.
 *   - Prometheus: cadvisor container metrics via DUMBSCOPE_PROMETHEUS_URL
 *     when cgroupfs is not mounted. Fewer fields; used as the fallback so an
 *     install without the mount still gets the memory picture.
 *
 * Samples persist once per minute into cgroup_samples with 5m/30m rollups
 * (migration v10) — the same bounded three-tier shape as runtime_samples.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
	CgroupMemoryBreakdown,
	CgroupMemoryInterpretation,
	CgroupMemorySnapshot
} from '$lib/types';
import { getDb } from '../database/db';

export const CGROUP_TUNING = {
	/** Sample cadence (the hub housekeeper drives this pass). */
	sampleIntervalMs: 60_000,
	/** Raw retention (mirrors memory_samples). */
	rawRetentionMs: 26 * 60 * 60_000,
	/** Rollup buckets (migration v10 tables). */
	fiveMinBucketMs: 5 * 60_000,
	thirtyMinBucketMs: 30 * 60_000,
	/** Rollup retention. */
	fiveMinRetentionMs: 7 * 24 * 60 * 60_000,
	thirtyMinRetentionMs: 30 * 24 * 60 * 60_000,
	/** Direct-reclaim pages (in the sample interval) that indicate pressure. */
	pressurePgscanDirectMin: 1_000,
	/** File refault pages (in the sample interval) that indicate pressure. */
	pressureRefaultMin: 1_000,
	/** Usage ≥ max × this fraction counts as "at the hard limit". */
	hardLimitFraction: 0.98
} as const;

/** One parsed cgroup v2 memory state (bytes/counters, null when absent). */
export interface CgroupMemoryRaw {
	current: number | null;
	high: number | null;
	max: number | null;
	peak: number | null;
	swapCurrent: number | null;
	stat: Record<string, number>;
	events: {
		high: number | null;
		max: number | null;
		oom: number | null;
		oomKill: number | null;
	};
}

/** Parse the contents of cgroup v2 memory files (values may be "max"). */
export function parseCgroupMemory(files: Record<string, string>): CgroupMemoryRaw {
	const readBytes = (name: string): number | null => {
		const v = files[name]?.trim();
		if (v === undefined || v === '') return null;
		if (v === 'max') return null;
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	};
	const stat: Record<string, number> = {};
	for (const line of (files['memory.stat'] ?? '').split('\n')) {
		const [key, value] = line.trim().split(/\s+/);
		if (!key || value === undefined) continue;
		const n = Number(value);
		if (Number.isFinite(n)) stat[key] = n;
	}
	const events: CgroupMemoryRaw['events'] = {
		high: null,
		max: null,
		oom: null,
		oomKill: null
	};
	for (const line of (files['memory.events'] ?? '').split('\n')) {
		const [key, value] = line.trim().split(/\s+/);
		if (!key || value === undefined) continue;
		const n = Number(value);
		if (!Number.isFinite(n)) continue;
		if (key === 'high') events.high = n;
		else if (key === 'max') events.max = n;
		else if (key === 'oom') events.oom = n;
		else if (key === 'oom_kill') events.oomKill = n;
	}
	return {
		current: readBytes('memory.current'),
		high: readBytes('memory.high'),
		max: readBytes('memory.max'),
		peak: readBytes('memory.peak'),
		swapCurrent: readBytes('memory.swap.current'),
		stat,
		events
	};
}

/**
 * Split memory.current into display groups (brief §3): applications/anon vs
 * reclaimable file cache vs kernel. shmem is charged under `file` by the
 * kernel but is tmpfs — shown separately so "cache" stays honest.
 */
export function cgroupBreakdown(raw: CgroupMemoryRaw): CgroupMemoryBreakdown {
	const s = raw.stat;
	const anon = s['anon'] ?? 0;
	const file = s['file'] ?? 0;
	const shmem = s['shmem'] ?? 0;
	const slab = s['slab'] ?? 0;
	const kernel =
		(slab > 0 ? slab : (s['slab_reclaimable'] ?? 0) + (s['slab_unreclaimable'] ?? 0)) +
		(s['kernel_stack'] ?? 0) +
		(s['sock'] ?? 0);
	// Everything the kernel reports beyond the named groups (per-cgroup
	// bookkeeping etc.). percpu is reported separately by the kernel.
	const named =
		anon +
		file +
		(slab > 0 ? slab : (s['slab_reclaimable'] ?? 0) + (s['slab_unreclaimable'] ?? 0)) +
		(s['kernel_stack'] ?? 0) +
		(s['sock'] ?? 0);
	const percpu = s['percpu'] ?? 0;
	const misc =
		raw.current !== null && raw.current > named + percpu ? raw.current - named - percpu : 0;
	const kernelTotal = kernel + percpu + misc;
	return {
		applicationsBytes: anon,
		sharedBytes: shmem,
		cacheBytes: Math.max(0, file - shmem),
		kernelBytes: kernelTotal,
		slabReclaimableBytes: s['slab_reclaimable'] ?? 0,
		currentBytes: raw.current
	};
}

/** Rate-based interpretation against the previous sample (§3 rules). */
export function interpretCgroupMemory(
	raw: CgroupMemoryRaw,
	previous: CgroupMemoryRaw | null,
	tuning: { [K in keyof typeof CGROUP_TUNING]: number } = { ...CGROUP_TUNING }
): CgroupMemoryInterpretation {
	const counter = (a: number | null, b: number | null): number | null =>
		a === null || b === null ? null : Math.max(0, a - b);
	const highDelta = counter(raw.events.high, previous?.events.high ?? null);
	const maxDelta = counter(raw.events.max, previous?.events.max ?? null);
	const oomDelta = counter(raw.events.oom, previous?.events.oom ?? null);
	const oomKillDelta = counter(raw.events.oomKill, previous?.events.oomKill ?? null);
	const pgscanDirectDelta = counter(
		raw.stat['pgscan_direct'] ?? null,
		previous?.stat['pgscan_direct'] ?? null
	);
	const refaultDelta = counter(
		raw.stat['workingset_refault_file'] ?? null,
		previous?.stat['workingset_refault_file'] ?? null
	);

	const softReclaimActive = highDelta !== null && highDelta > 0;
	const hardLimitHit = maxDelta !== null && maxDelta > 0;
	const oom = (oomDelta ?? 0) > 0 || (oomKillDelta ?? 0) > 0;
	const reclaiming = (pgscanDirectDelta ?? 0) >= tuning.pressurePgscanDirectMin;
	const refaulting = (refaultDelta ?? 0) >= tuning.pressureRefaultMin;
	const atHardLimit =
		raw.max !== null && raw.current !== null && raw.current >= raw.max * tuning.hardLimitFraction;
	const pressure =
		!oom && (reclaiming || refaulting) && (softReclaimActive || hardLimitHit || atHardLimit);

	return {
		softReclaimActive,
		hardLimitHit,
		pressure,
		oom,
		events: {
			high: raw.events.high,
			max: raw.events.max,
			oom: raw.events.oom,
			oomKill: raw.events.oomKill
		},
		pgscanDirect: raw.stat['pgscan_direct'] ?? null,
		refaultFile: raw.stat['workingset_refault_file'] ?? null
	};
}

/** Read one cgroup directory's memory files; null for unreadable entries. */
export function readCgroupDir(dir: string): CgroupMemoryRaw | null {
	const files: Record<string, string> = {};
	for (const name of [
		'memory.current',
		'memory.high',
		'memory.max',
		'memory.peak',
		'memory.swap.current',
		'memory.stat',
		'memory.events'
	]) {
		try {
			files[name] = fs.readFileSync(path.join(dir, name), 'utf8');
		} catch {
			// Absent file (older kernels) → null field, never a crash.
		}
	}
	if (files['memory.current'] === undefined && files['memory.stat'] === undefined) return null;
	return parseCgroupMemory(files);
}

// ---------------------------------------------------------------------------
// Prometheus (cadvisor) fallback source
// ---------------------------------------------------------------------------

export interface PrometheusQueryResult {
	data?: { result?: { metric?: Record<string, string>; value?: [number, string] }[] };
}

/** Parse a cadvisor container id label ("/docker/<64 hex>") into the id part. */
export function containerIdFromPrometheus(
	metric: Record<string, string> | undefined
): string | null {
	const id = metric?.['id'] ?? '';
	const m = /\/docker\/([0-9a-f]{64})/.exec(id);
	return m ? m[1]! : null;
}

/** Instant-query a Prometheus for one gauge (first value or null). */
export async function prometheusQuery(
	baseUrl: string,
	query: string,
	timeoutMs = 4_000
): Promise<number | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const url = new URL(baseUrl.replace(/\/+$/, '') + '/api/v1/query');
		url.searchParams.set('query', query);
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) return null;
		const json = (await res.json()) as PrometheusQueryResult;
		const value = json.data?.result?.[0]?.value?.[1];
		if (value === undefined) return null;
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Resolve the DUMB container's cgroup directory name via cadvisor's id label. */
export async function resolveContainerIdViaPrometheus(
	baseUrl: string,
	containerName: string
): Promise<string | null> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 4_000);
	try {
		const url = new URL(baseUrl.replace(/\/+$/, '') + '/api/v1/query');
		url.searchParams.set('query', `container_memory_usage_bytes{name="${containerName}"}`);
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) return null;
		const json = (await res.json()) as PrometheusQueryResult;
		for (const series of json.data?.result ?? []) {
			const id = containerIdFromPrometheus(series.metric);
			if (id) return id;
		}
		return null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/** Fallback snapshot from Prometheus cadvisor series (fewer fields). */
export async function readCgroupViaPrometheus(
	baseUrl: string,
	containerName: string
): Promise<CgroupMemoryRaw | null> {
	const q = (metric: string) => prometheusQuery(baseUrl, `${metric}{name="${containerName}"}`);
	const [usage, rss, cache, kernel, maxUsage, oomEvents] = await Promise.all([
		q('container_memory_usage_bytes'),
		q('container_memory_rss'),
		q('container_memory_cache'),
		q('container_memory_kernel_usage'),
		q('container_memory_max_usage_bytes'),
		q('container_oom_events_total')
	]);
	if (usage === null) return null;
	const file = cache ?? 0;
	const rssValue = rss ?? 0;
	return parseCgroupMemory({
		'memory.current': String(usage),
		// cadvisor has no notion of the cgroup's configured limits.
		'memory.stat': `anon ${Math.round(rssValue)}\nfile ${Math.round(file)}\nslab ${Math.round(Math.max(0, kernel ?? 0))}`,
		'memory.peak': maxUsage !== null ? String(maxUsage) : '',
		'memory.events':
			oomEvents !== null ? `high 0\nmax 0\noom ${Math.round(oomEvents)}\noom_kill 0` : ''
	});
}

// ---------------------------------------------------------------------------
// Monitor (persistence + rollups live in metrics/cgroup-retention.ts)
// ---------------------------------------------------------------------------

export interface CgroupMonitorOptions {
	/** Explicit cgroup path for the DUMB container (mounted read-only). */
	path?: () => string | null;
	/** Parent dir of container cgroup dirs + container id/env-based discovery. */
	parent?: () => string | null;
	containerIdEnv?: () => string | null;
	containerName?: () => string | null;
	prometheusUrl?: () => string | null;
	enabled?: () => boolean;
	now?: () => number;
}

export class CgroupMemoryMonitor {
	private readonly opts: CgroupMonitorOptions;
	private readonly nowFn: () => number;
	private last: CgroupMemoryRaw | null = null;
	private lastSampleAt = 0;
	private lastSamplePersistAt = 0;
	private snapshot: CgroupMemorySnapshot;
	private unavailableReason: string | null = null;
	private sampling = false;

	constructor(options: CgroupMonitorOptions) {
		this.opts = options;
		this.nowFn = options.now ?? (() => Date.now());
		this.snapshot = this.emptySnapshot();
		this.snapshot.unavailableReason = 'no sample yet — the first pass runs within a minute';
	}

	private emptySnapshot(): CgroupMemorySnapshot {
		return {
			at: null,
			source: null,
			unavailableReason: null,
			highBytes: null,
			maxBytes: null,
			breakdown: {
				applicationsBytes: 0,
				sharedBytes: 0,
				cacheBytes: 0,
				kernelBytes: 0,
				slabReclaimableBytes: 0,
				currentBytes: null
			},
			interpretation: {
				softReclaimActive: false,
				hardLimitHit: false,
				pressure: false,
				oom: false,
				events: { high: null, max: null, oom: null, oomKill: null },
				pgscanDirect: null,
				refaultFile: null
			},
			peakBytes: null
		};
	}

	getSnapshot(): CgroupMemorySnapshot {
		return this.snapshot;
	}

	/** Why no data is currently available (for honest UI display). */
	getUnavailableReason(): string | null {
		return this.unavailableReason;
	}

	/** Raw last parse (tests). */
	get lastRaw(): CgroupMemoryRaw | null {
		return this.last;
	}

	/** Resolve the cgroup directory for the DUMB container (null when unknown). */
	private resolveDir(): string | null {
		const explicit = this.opts.path?.() ?? process.env.DUMBSCOPE_DUMB_CGROUP_PATH ?? null;
		if (explicit) return explicit;
		const parent = this.opts.parent?.() ?? process.env.DUMBSCOPE_DUMB_CGROUP_PARENT ?? null;
		if (parent) {
			const id = this.opts.containerIdEnv?.() ?? process.env.DUMBSCOPE_DUMB_CONTAINER_ID ?? null;
			if (id) return path.join(parent, id);
		}
		return null;
	}

	/** Run one sample (cgroupfs first, Prometheus fallback). Fire-and-forget safe. */
	async sample(): Promise<CgroupMemorySnapshot> {
		if (this.sampling) return this.snapshot;
		this.sampling = true;
		try {
			await this.sampleInner();
		} catch (err) {
			this.unavailableReason = err instanceof Error ? err.message : 'cgroup sample failed';
		} finally {
			this.sampling = false;
		}
		return this.snapshot;
	}

	private async sampleInner(): Promise<void> {
		const now = this.nowFn();
		const dir = this.resolveDir();
		let raw: CgroupMemoryRaw | null = null;
		let source: CgroupMemorySnapshot['source'] = null;
		if (dir) {
			raw = readCgroupDir(dir);
			if (raw) source = 'cgroupfs';
		}
		const promUrl = this.opts.prometheusUrl?.() ?? process.env.DUMBSCOPE_PROMETHEUS_URL ?? null;
		if (!raw && promUrl) {
			const name =
				this.opts.containerName?.() ?? process.env.DUMBSCOPE_DUMB_CONTAINER_NAME ?? 'DUMB';
			raw = await readCgroupViaPrometheus(promUrl, name);
			if (raw) source = 'prometheus';
		}
		if (!raw) {
			this.unavailableReason = dir
				? `cgroup directory not readable (${dir}); set DUMBSCOPE_DUMB_CGROUP_PATH to the DUMB container's cgroup mount`
				: 'no cgroup source configured (DUMBSCOPE_DUMB_CGROUP_PATH or DUMBSCOPE_PROMETHEUS_URL)';
			this.snapshot = { ...this.emptySnapshot(), unavailableReason: this.unavailableReason };
			return;
		}
		const previous = this.last;
		this.last = raw;
		this.lastSampleAt = now;
		this.unavailableReason = null;
		const interpretation = interpretCgroupMemory(raw, previous);
		const breakdown = cgroupBreakdown(raw);
		this.snapshot = {
			at: now,
			source,
			unavailableReason: null,
			highBytes: raw.high,
			maxBytes: raw.max,
			breakdown,
			interpretation,
			peakBytes: raw.peak
		};
		this.persist(raw, now);
		// Timeline: hard-limit movement and OOM are timeline facts (not alerts).
		if (interpretation.oom) {
			import('../reliability/timeline')
				.then(({ recordObservabilityEvent }) =>
					recordObservabilityEvent({
						at: now,
						kind: 'oom',
						severity: 'critical',
						title: 'DUMB cgroup OOM counter moved',
						detail: `memory.events oom=${interpretation.events.oom ?? '?'} oom_kill=${interpretation.events.oomKill ?? '?'}`
					})
				)
				.catch(() => {});
		} else if (interpretation.hardLimitHit) {
			const currentGiB = ((raw.current ?? 0) / 1024 ** 3).toFixed(2);
			const maxGiB = ((raw.max ?? 0) / 1024 ** 3).toFixed(2);
			import('../reliability/timeline')
				.then(({ recordObservabilityEvent }) =>
					recordObservabilityEvent({
						at: now,
						kind: 'cgroup-max',
						severity: 'warning',
						title: 'DUMB hit its hard memory limit (memory.max)',
						detail: `current ${currentGiB} GiB, max ${maxGiB} GiB`
					})
				)
				.catch(() => {});
		}
	}

	/** Persist one raw sample per minute; old rows are pruned by the rollups. */
	private persist(raw: CgroupMemoryRaw, now: number): void {
		if (
			this.lastSamplePersistAt !== 0 &&
			now - this.lastSamplePersistAt < CGROUP_TUNING.sampleIntervalMs
		)
			return;
		this.lastSamplePersistAt = now;
		try {
			getDb()
				.prepare(
					`INSERT OR REPLACE INTO cgroup_samples
					 (at, current_bytes, high_bytes, max_bytes, anon_bytes, file_bytes, shmem_bytes,
					  slab_bytes, slab_reclaimable_bytes, kernel_bytes,
					  events_high, events_max, events_oom, events_oom_kill, pgscan, pgscan_direct, refault_file)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					now,
					raw.current,
					raw.high,
					raw.max,
					raw.stat['anon'] ?? null,
					raw.stat['file'] ?? null,
					raw.stat['shmem'] ?? null,
					raw.stat['slab'] ?? null,
					raw.stat['slab_reclaimable'] ?? null,
					this.kernelBytesOf(raw),
					raw.events.high,
					raw.events.max,
					raw.events.oom,
					raw.events.oomKill,
					raw.stat['pgscan'] ?? null,
					raw.stat['pgscan_direct'] ?? null,
					raw.stat['workingset_refault_file'] ?? null
				);
		} catch {
			// best-effort: observability must never disturb the pipeline
		}
	}

	private kernelBytesOf(raw: CgroupMemoryRaw): number | null {
		const breakdown = cgroupBreakdown(raw);
		return breakdown.kernelBytes;
	}
}

/** Timeline wants a compact rate card for the UI too. */
export function summarizeInterpretation(i: CgroupMemoryInterpretation): string {
	const parts: string[] = [];
	if (i.softReclaimActive) parts.push('soft reclaim active');
	if (i.hardLimitHit) parts.push('hard limit hit');
	if (i.pressure) parts.push('memory pressure');
	if (i.oom) parts.push('OOM');
	if (parts.length === 0) parts.push('no limit activity');
	return parts.join(', ');
}
