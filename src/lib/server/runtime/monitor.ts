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
	/** Ms since the last completed housekeeping tick (null = never ticked). */
	housekeepingHeartbeatMs: () => number | null;
	/** True once the hub's schedulers have been armed. */
	schedulerStarted: () => boolean;
	/** In-flight reconciliation cycle, if any (stuck-run watchdog). */
	reconciliationRun: () => { running: boolean; startedAt: number | null };
}

/** Watchdog tuning: independent monitor beats watching scheduler heartbeats. */
export const WATCHDOG_TUNING = {
	/** Housekeeping interval is 10s; stale beyond this many ms is a finding. */
	housekeepingStaleMs: 60_000,
	/** Consecutive stale samples (15s each) before the finding opens. */
	staleConsecutive: 2,
	/** Consecutive fresh samples before a watchdog finding resolves. */
	cleanConsecutive: 2,
	/** A reconciliation cycle running longer than this is stuck. The worst
	 *  legitimate cycle is ~13 min (400 series, 8s per-request deadline, 8
	 *  concurrent fetchers), so 15 min is safely beyond expected. */
	reconciliationStuckMs: 15 * 60_000
} as const;

export class RuntimeMonitor {
	private timer: NodeJS.Timeout | null = null;
	private heartbeat: NodeJS.Timeout | null = null;
	private lastPersistAt = 0;
	private lastMaintainAt = 0;
	private lastSample: RuntimeSample | null = null;
	private readonly lag = new LagMonitor();
	private anomaly: SelfAnomalyMonitor;
	private options: {
		onFinding: (finding: SelfAnomalyFinding) => void;
		onResolve: (fingerprint: string, message: string) => void;
	};
	private providers: RuntimeProviders | null = null;
	/** Cumulative counters for the panel (workers spawned/timed out etc). */
	readonly startedAt = Date.now();
	// Watchdog hysteresis state (independent monitor beats): housekeeping
	// staleness and a reconciliation cycle stuck past its expected maximum.
	private housekeepingStaleStreak = 0;
	private housekeepingCleanStreak = 0;
	private housekeepingOpen = false;
	private reconStuckStreak = 0;
	private reconStuckOpen = false;

	constructor(options: {
		onFinding: (finding: SelfAnomalyFinding) => void;
		onResolve: (fingerprint: string, message: string) => void;
		enabled?: () => boolean;
	}) {
		this.options = options;
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
		// Scheduler watchdogs: this sampler is an INDEPENDENT interval (15s) —
		// it keeps beating even when the hub's housekeeper or the
		// reconciliation runner wedges, which is exactly what it watches for.
		try {
			this.runWatchdogs(now);
		} catch {
			// never disturb the sampler
		}
		return sample;
	}

	/**
	 * Two watchdog findings, both with hysteresis (N consecutive stale
	 * samples before opening, M consecutive clean before resolving) and both
	 * through the ONE incident engine:
	 * - `self:housekeeping` — the 10s housekeeping heartbeat went silent.
	 * - `self:recon-stuck` — a reconciliation cycle exceeded its expected
	 *   maximum duration and is presumed wedged.
	 * Scope note (documented, not an accident): a TOTAL process death or a
	 * fully starved event loop stops this sampler too — that failure class is
	 * supervised externally by the Docker liveness HEALTHCHECK.
	 */
	private runWatchdogs(now: number): void {
		const providers = this.providers;
		if (!providers) return;

		// --- housekeeping heartbeat -----------------------------------------
		const hb = providers.housekeepingHeartbeatMs();
		const stale =
			providers.schedulerStarted() && hb !== null && hb > WATCHDOG_TUNING.housekeepingStaleMs;
		if (stale) {
			this.housekeepingStaleStreak++;
			this.housekeepingCleanStreak = 0;
			if (
				this.housekeepingStaleStreak >= WATCHDOG_TUNING.staleConsecutive &&
				!this.housekeepingOpen
			) {
				this.housekeepingOpen = true;
				this.options.onFinding({
					fingerprint: 'self:housekeeping',
					severity: 'critical',
					title: 'DUMBscope housekeeping loop has stalled',
					summary: `No housekeeping tick for ${Math.round(hb / 1000)}s (interval 10s) — incident evaluation, safety net and telemetry freshness checks are not running`,
					evidence: `heartbeat age=${Math.round(hb / 1000)}s · observed stale on ${this.housekeepingStaleStreak} consecutive samples`
				});
			} else if (this.housekeepingOpen) {
				this.options.onFinding({
					fingerprint: 'self:housekeeping',
					severity: 'critical',
					title: 'DUMBscope housekeeping loop has stalled',
					summary: `No housekeeping tick for ${Math.round(hb / 1000)}s (interval 10s) — incident evaluation, safety net and telemetry freshness checks are not running`,
					evidence: `heartbeat age=${Math.round(hb / 1000)}s`
				});
			}
		} else {
			this.housekeepingStaleStreak = 0;
			if (
				this.housekeepingOpen &&
				++this.housekeepingCleanStreak >= WATCHDOG_TUNING.cleanConsecutive
			) {
				this.housekeepingOpen = false;
				this.housekeepingCleanStreak = 0;
				this.options.onResolve(
					'self:housekeeping',
					`Housekeeping is ticking again (last tick ${hb === null ? 'pending' : `${Math.round(hb / 1000)}s ago`})`
				);
			}
		}

		// --- reconciliation stuck -------------------------------------------
		const run = providers.reconciliationRun();
		const stuck =
			run.running &&
			run.startedAt !== null &&
			now - run.startedAt > WATCHDOG_TUNING.reconciliationStuckMs;
		if (stuck && run.startedAt !== null) {
			this.reconStuckStreak++;
			if (this.reconStuckStreak >= WATCHDOG_TUNING.staleConsecutive && !this.reconStuckOpen) {
				this.reconStuckOpen = true;
				this.options.onFinding({
					fingerprint: 'self:recon-stuck',
					severity: 'warning',
					title: 'Library reconciliation appears stuck',
					summary: `The reconciliation cycle has been running for ${Math.round((now - run.startedAt) / 60_000)} min — beyond the expected maximum (~15 min). New cycles cannot start until it finishes.`,
					evidence: `startedAt=${new Date(run.startedAt).toISOString()} · runtime=${Math.round((now - run.startedAt) / 1000)}s`
				});
			} else if (this.reconStuckOpen) {
				this.options.onFinding({
					fingerprint: 'self:recon-stuck',
					severity: 'warning',
					title: 'Library reconciliation appears stuck',
					summary: `The reconciliation cycle has been running for ${Math.round((now - run.startedAt) / 60_000)} min — beyond the expected maximum (~15 min). New cycles cannot start until it finishes.`,
					evidence: `runtime=${Math.round((now - run.startedAt) / 1000)}s`
				});
			}
		} else {
			this.reconStuckStreak = 0;
			if (this.reconStuckOpen) {
				this.reconStuckOpen = false;
				this.options.onResolve(
					'self:recon-stuck',
					'Reconciliation finished or restarted within the expected duration'
				);
			}
		}
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
