/**
 * DUMBscope runtime self-monitor (§4): bounded, cheap sampling of this
 * process's own vital signs, feeding the System → Runtime panel, the
 * long-term metric store and the self-anomaly detector.
 *
 * Overhead budget (measured, see docs/RELIABILITY.md §Overhead): one sample
 * pass every 15s (a handful of process/FS calls + one SQLite row per minute),
 * one aggregate pass and one prune pass per hour. Event-loop lag measurement
 * piggybacks on the sampler's own 1s heartbeat timer.
 *
 * Monitored regressions: worker/thread leak (fsprobe + prober counters), FD
 * leak (/proc/self/fd), memory growth (RSS/heap/external), event-loop lag,
 * SSE subscriber leak, reconciliation duration drift, DB/WAL growth.
 */
import fs from 'node:fs';
import path from 'node:path';
import { configDir, getDb } from '../database/db';
import { fsProbeWorkerStats } from '../reliability/fsprobe';
import { queueDepth } from '../notifications/queue';
import {
	LagMonitor,
	downsampleToFiveMinutes,
	downsampleToThirtyMinutes,
	persistRuntimeSample,
	pruneRuntimeSamples,
	type RuntimeSample
} from './store';
import { SelfAnomalyMonitor, type SelfAnomalyFinding } from './anomaly';

const TUNING = {
	/** Sampler cadence. Cheap by design; 15s keeps graphs responsive. */
	sampleIntervalMs: 15_000,
	/** One persisted row per minute (raw tier). */
	persistIntervalMs: 60_000,
	/** Downsample + prune hourly. */
	maintenanceIntervalMs: 60 * 60_000
} as const;

/** Facts the sampler cannot know alone — provided by the hub each tick. */
export interface RuntimeProviders {
	/** Live SSE subscriber count. */
	sseClients: () => number;
	/** Reconciliation duration of the last completed cycle (ms | null). */
	reconDurationMs: () => number | null;
	/** Reliability probe round duration (ms | null). */
	probeDurationMs: () => number | null;
	/** Registered scheduled jobs (timers that are alive right now). */
	jobsActive: () => number;
	/** Active reconciliation prober workers (0/1). */
	reconWorkersActive: () => number;
}

export class RuntimeMonitor {
	private timer: NodeJS.Timeout | null = null;
	private heartbeat: NodeJS.Timeout | null = null;
	private lastPersistAt = 0;
	private lastMaintainAt = 0;
	private lastSample: RuntimeSample | null = null;
	private readonly lag = new LagMonitor();
	private anomaly: SelfAnomalyMonitor;
	private providers: RuntimeProviders | null = null;
	/** Cumulative counters for the panel (workers spawned/timed out etc). */
	readonly startedAt = Date.now();

	constructor(options: {
		onFinding: (finding: SelfAnomalyFinding) => void;
		onResolve: (fingerprint: string, message: string) => void;
		enabled?: () => boolean;
	}) {
		this.anomaly = new SelfAnomalyMonitor({
			onFinding: options.onFinding,
			onResolve: options.onResolve,
			...(options.enabled ? { enabled: options.enabled } : {})
		});
	}

	setProviders(providers: RuntimeProviders): void {
		this.providers = providers;
	}

	start(): void {
		if (this.timer) return;
		// Heartbeat: measures event-loop lag as drift from the expected 1s tick.
		this.heartbeat ??= setInterval(() => this.lag.tick(1_000), 1_000);
		this.heartbeat.unref?.();
		this.timer = setInterval(() => this.sample(), TUNING.sampleIntervalMs);
		this.timer.unref?.();
		this.sample();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.timer = null;
		this.heartbeat = null;
	}

	sample(): RuntimeSample {
		const now = Date.now();
		const mem = process.memoryUsage();
		const workers = fsProbeWorkerStats();
		const dbSizes = databaseSizes();
		const sample: RuntimeSample = {
			at: now,
			rssBytes: mem.rss,
			heapUsedBytes: mem.heapUsed,
			heapTotalBytes: mem.heapTotal,
			externalBytes: mem.external ?? null,
			arrayBuffersBytes: mem.arrayBuffers ?? null,
			eventLoopLagMs: this.lag.averageMs(),
			fds: fileDescriptorCount(),
			workersActive: workers.active + (this.providers?.reconWorkersActive() ?? 0),
			workersSpawned: workers.spawned,
			workersTerminated: workers.terminated,
			workersTimedOut: workers.timedOut,
			sseClients: this.providers?.sseClients() ?? 0,
			dbBytes: dbSizes.db,
			walBytes: dbSizes.wal,
			jobsActive: this.providers?.jobsActive() ?? 0,
			reconDurationMs: this.providers?.reconDurationMs() ?? null,
			probeDurationMs: this.providers?.probeDurationMs() ?? null,
			notifQueueDepth: safeQueueDepth()
		};
		this.lastSample = sample;
		if (now - this.lastPersistAt >= TUNING.persistIntervalMs) {
			this.lastPersistAt = now;
			persistRuntimeSample(sample);
		}
		if (now - this.lastMaintainAt >= TUNING.maintenanceIntervalMs) {
			this.lastMaintainAt = now;
			try {
				downsampleToFiveMinutes(now);
				downsampleToThirtyMinutes(now);
				pruneRuntimeSamples(now);
				// Service-memory long-term tiers (§6) ride the same hourly pass.
				void import('../metrics/retention').then((m) => {
					m.downsampleMemoryToFiveMinutes(now);
					m.downsampleMemoryToThirtyMinutes(now);
					m.pruneMemorySamples(now);
				});
			} catch {
				// Maintenance is best-effort; retried next hour.
			}
		}
		// Self-anomaly findings (sustained trends only). Failure-isolated.
		try {
			this.anomaly.evaluate(now);
		} catch {
			// never disturb the sampler
		}
		return sample;
	}

	latest(): RuntimeSample | null {
		return this.lastSample;
	}

	uptimeMs(): number {
		return Date.now() - this.startedAt;
	}

	lagStats(): { averageMs: number | null; maxMs: number | null } {
		return { averageMs: this.lag.averageMs(), maxMs: this.lag.maxMs() };
	}
}

/** DB + WAL file sizes (null when not yet created / unreadable). */
function databaseSizes(): { db: number | null; wal: number | null } {
	try {
		const file = path.join(configDir(), 'dumbscope.db');
		// Ensure the DB exists before stat (first sample may run pre-bootstrap).
		getDb();
		const db = fs.statSync(file).size;
		let wal: number | null = null;
		try {
			wal = fs.statSync(`${file}-wal`).size;
		} catch {
			wal = null; // no WAL file right now — honest null, not zero
		}
		return { db, wal };
	} catch {
		return { db: null, wal: null };
	}
}

/** Open FDs via /proc (Linux); null elsewhere or when unavailable. */
export function fileDescriptorCount(): number | null {
	try {
		return fs.readdirSync('/proc/self/fd').length;
	} catch {
		return null;
	}
}

function safeQueueDepth(): number {
	try {
		return queueDepth();
	} catch {
		return 0;
	}
}

/** Process-wide singleton (the hub owns the lifecycle). */
let monitor: RuntimeMonitor | null = null;

export type RuntimeMonitorOptions = {
	onFinding: (finding: SelfAnomalyFinding) => void;
	onResolve: (fingerprint: string, message: string) => void;
	enabled?: () => boolean;
};

export function getRuntimeMonitor(options?: RuntimeMonitorOptions): RuntimeMonitor {
	if (!monitor) {
		monitor = new RuntimeMonitor(options ?? { onFinding: () => {}, onResolve: () => {} });
	}
	return monitor;
}

export function resetRuntimeMonitor(): void {
	monitor?.stop();
	monitor = null;
}
