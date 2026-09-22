/**
 * MountMonitor (FASE B): read-only observability for the stack's storage
 * mounts — debrid/FUSE views, symlink roots and local media paths.
 *
 * Rules the implementation enforces:
 * - **Read-only, always.** Probes are stat / bounded listing / symlink
 *   sampling in disposable workers with hard deadlines (see fsprobe.ts).
 *   Mounting, remounting, restarting or repairing is never attempted here.
 * - **Never a full walk.** Each listing has an entry budget and depth cap;
 *   symlink sampling picks a hard-capped subset of the links found on that
 *   walk (brief §19/§21).
 * - **False-positive protection.** One bad round never produces a verdict:
 *   `unresponsive` needs several consecutive failed rounds, `missing` needs
 *   two consecutive ENOENT rounds, and findings resolve only after several
 *   consecutive healthy rounds (hysteresis lives in the incident engine,
 *   brief §27).
 * - **Failure isolation.** A timed-out mount affects nothing else: no shared
 *   state, no connection impact, the hub poller keeps running (brief §45).
 */
import type { MountReport, MountTarget, SymlinkSample } from '$lib/types';
import { runProbeRound } from './fsprobe';

export const MOUNT_TUNING = {
	/** Target cadence between probe rounds per mount (the hub calls tick()). */
	roundIntervalMs: 60_000,
	/** Hard deadline for a whole probe round (worker includes all ops). */
	roundTimeoutMs: 30_000,
	/** Directory entries a bounded walk may look at before truncating. */
	entryBudget: 400,
	/** BFS depth for symlink roots (root → show → season → links). */
	walkDepth: 3,
	/** Maximum symlinks sampled per round (hard cap, brief §21). */
	linkSampleCap: 24,
	/** Minimum sample for the systemic-broken-symlink signal to be eligible. */
	systemicMinSample: 8,
	/** Broken ratio at which the systemic symlink finding opens. */
	systemicBrokenRatio: 0.8,
	/** stat/list latency above which a healthy mount is reported `slow`. */
	slowLatencyMs: 1_500,
	/** Consecutive failed rounds before `unresponsive`/`read-error`. */
	failedRoundsForDown: 3,
	/** Consecutive failed rounds before `degraded`. */
	failedRoundsForDegraded: 2,
	/** Consecutive ENOENT rounds before `missing`. */
	missingRounds: 2,
	/** Healthy rounds a finding requires before it resolves (hysteresis). */
	healthyRoundsForRecovery: 2
} as const;

export interface MountMonitorOptions {
	now?: () => number;
	targets: MountTarget[];
	enabled?: () => boolean;
	roundIntervalMs?: number;
}

interface TargetState {
	report: MountReport;
	/** In-progress guard: rounds for one target never overlap. */
	busy: boolean;
	lastRoundAt: number | null;
	consecutiveMissing: number;
}

export interface MountRoundContext {
	/** Process run-states by process name (for honest correlation copy). */
	runningProcesses: ReadonlySet<string>;
}

export class MountMonitor {
	private readonly nowFn: () => number;
	private readonly targets: Map<string, TargetState> = new Map();
	private readonly enabledFn: (() => boolean) | null;
	private readonly roundIntervalMs: number;
	/** Set when a round produced a state change (hub turns this into an SSE event). */
	public dirty = false;
	private rounds = 0;
	private lastRoundMs: number | null = null;
	private roundInProgress = false;

	constructor(options: MountMonitorOptions) {
		this.nowFn = options.now ?? (() => Date.now());
		this.enabledFn = options.enabled ?? null;
		this.roundIntervalMs = options.roundIntervalMs ?? MOUNT_TUNING.roundIntervalMs;
		for (const target of options.targets) {
			this.targets.set(target.id, {
				busy: false,
				lastRoundAt: null,
				consecutiveMissing: 0,
				report: emptyReport(target)
			});
		}
	}

	getReports(): MountReport[] {
		return [...this.targets.values()].map((t) => t.report);
	}

	/**
	 * Apply configuration changes (targets live in settings; the hub syncs on
	 * every housekeeping tick). New targets start probing on their next round;
	 * removed targets stop immediately and their paths are returned so the
	 * caller can retire the findings as obsolete ("target removed") — without
	 * this, a removed mount kept being probed forever with findings that could
	 * never see a healthy round again.
	 */
	syncTargets(targets: MountTarget[]): string[] {
		const seen = new Set(targets.map((t) => t.id));
		const removed: string[] = [];
		for (const [id, state] of this.targets) {
			if (seen.has(id)) continue;
			removed.push(state.report.target.path);
			this.targets.delete(id);
		}
		for (const target of targets) {
			const existing = this.targets.get(target.id);
			if (!existing) {
				this.targets.set(target.id, {
					busy: false,
					lastRoundAt: null,
					consecutiveMissing: 0,
					report: emptyReport(target)
				});
				continue;
			}
			// Same id but edited definition (label, path, consumers): keep the
			// probe state, refresh the identity shown in reports.
			const current = existing.report.target;
			if (
				current.path !== target.path ||
				current.label !== target.label ||
				current.kind !== target.kind ||
				current.consumers.join('\u0000') !== target.consumers.join('\u0000')
			) {
				existing.report.target = target;
			}
		}
		return removed;
	}

	stats(): { mountRounds: number; lastRoundMs: number | null } {
		return { mountRounds: this.rounds, lastRoundMs: this.lastRoundMs };
	}

	/**
	 * Run one probe round for every target whose interval elapsed. Never
	 * throws, never overlaps itself, and skips targets mid-flight so a hung
	 * (terminated) worker cannot stack up rounds.
	 */
	async tick(context: MountRoundContext): Promise<void> {
		if (this.enabledFn && !this.enabledFn()) return;
		if (this.roundInProgress) return;
		const now = this.nowFn();
		const due = [...this.targets.values()].filter(
			(t) => !t.busy && (t.lastRoundAt === null || now - t.lastRoundAt >= this.roundIntervalMs)
		);
		if (due.length === 0) return;
		this.roundInProgress = true;
		const startedAt = this.nowFn();
		try {
			await Promise.all(due.map((t) => this.probeTarget(t, context)));
		} finally {
			this.rounds++;
			this.lastRoundMs = this.nowFn() - startedAt;
			this.roundInProgress = false;
		}
	}

	private async probeTarget(state: TargetState, context: MountRoundContext): Promise<void> {
		state.busy = true;
		state.lastRoundAt = this.nowFn();
		const { target } = state.report;
		try {
			// Op 1: path existence + stat latency. Op 2: bounded walk + symlink
			// sampling. Both inside one disposable worker with one deadline.
			const round = await runProbeRound(
				[
					{ op: 'stat', path: target.path },
					{
						op: 'list',
						path: target.path,
						entryBudget: MOUNT_TUNING.entryBudget,
						depth: MOUNT_TUNING.walkDepth,
						linkSampleCap: MOUNT_TUNING.linkSampleCap
					}
				],
				MOUNT_TUNING.roundTimeoutMs
			);
			this.applyRound(state, round.results[0] ?? null, round.results[1] ?? null, round.timedOut);
			correlate(state.report, context);
			state.report.lastProbeAt = state.lastRoundAt;
			this.dirty = true;
		} catch {
			// runProbeRound resolves rather than rejects; this is belt-and-braces.
			state.report.lastError = 'internal probe error';
		} finally {
			state.busy = false;
		}
	}

	private applyRound(
		state: TargetState,
		stat: { ok: boolean; latencyMs?: number; code?: string; message?: string } | null,
		list: {
			ok: boolean;
			latencyMs?: number;
			code?: string;
			sample?: SymlinkSample | null;
			entriesScanned?: number;
			truncated?: boolean;
		} | null,
		timedOut: boolean
	): void {
		const report = state.report;
		const statOk = stat?.ok === true;
		const listOk = list?.ok === true;

		// ENOENT on the stat: the path is not present at all. `missing` needs
		// two consecutive rounds so a late bind mount never flashes a warning.
		if (!statOk && stat?.code === 'ENOENT') {
			state.consecutiveMissing++;
			report.failedRounds = 0;
			report.healthyRounds = 0;
			if (state.consecutiveMissing >= MOUNT_TUNING.missingRounds) {
				report.state = 'missing';
				report.lastError = 'path does not exist inside the DUMBscope container';
			}
			return;
		}
		state.consecutiveMissing = 0;

		if (statOk && listOk) {
			// A fully successful round: reset failure tracking immediately.
			report.failedRounds = 0;
			report.healthyRounds++;
			report.statLatencyMs = stat.latencyMs ?? null;
			report.listLatencyMs = list.latencyMs ?? null;
			report.symlink = list.sample ?? null;
			report.lastSuccessAt = this.nowFn();
			report.lastError = null;
			// 'slow' follows the *stat* latency: plain responsiveness of the
			// mount. The bounded walk's list latency is budgeted work (400
			// entries over a FUSE/shfs stack easily exceeds a second on a
			// healthy array) — reported in the UI, but never a health signal.
			report.state = (report.statLatencyMs ?? 0) > MOUNT_TUNING.slowLatencyMs ? 'slow' : 'healthy';
			return;
		}

		report.healthyRounds = 0;
		report.failedRounds++;
		const code = stat?.code && stat.code !== 'error' ? stat.code : (list?.code ?? 'TIMEOUT');
		report.lastError =
			code === 'TIMEOUT'
				? timedOut
					? 'probe timed out (worker terminated at the deadline)'
					: 'probe timed out'
				: code === 'EACCES' || code === 'EPERM'
					? 'permission denied while reading the path'
					: code === 'EIO'
						? 'input/output error while reading the path'
						: `probe failed (${code})`;
		if (report.failedRounds >= MOUNT_TUNING.failedRoundsForDown) {
			// After several consecutive failed rounds the failure mode is stable
			// enough to name: IO/permission errors are read errors; everything
			// else (timeouts, resets) means the mount is not answering.
			report.state =
				code === 'EIO' || code === 'EACCES' || code === 'EPERM' ? 'read-error' : 'unresponsive';
		} else if (report.failedRounds >= MOUNT_TUNING.failedRoundsForDegraded) {
			report.state = 'degraded';
		} else if (report.state === 'unknown') {
			report.state = 'unknown';
		}
		// Keep the previous state for a single failed round — one timeout never
		// reclassifies a healthy mount.
	}
}

/** Initial report before the first probe round. */
function emptyReport(target: MountTarget): MountReport {
	return {
		target,
		state: 'unknown',
		statLatencyMs: null,
		listLatencyMs: null,
		failedRounds: 0,
		healthyRounds: 0,
		symlink: null,
		lastProbeAt: null,
		lastSuccessAt: null,
		lastError: null
	};
}

/**
 * Honest correlation copy (brief §24): when the mount is down while its
 * storage backend reports running, say "the storage mount appears unhealthy"
 * and name the consumers with "may be affected" — never a consumer-down
 * verdict and never a consumer incident.
 */
function correlate(report: MountReport, context: MountRoundContext): void {
	if (!['unresponsive', 'read-error', 'degraded'].includes(report.state)) return;
	if (report.lastError) {
		const storageAlive = [...context.runningProcesses].some((name) =>
			/infinidysk|decypharr|rclone|nzbdav|zurg|altmount/i.test(name)
		);
		if (storageAlive) {
			report.lastError += ' — storage service reports running: the storage mount appears unhealthy';
		}
	}
	void report.target; // consumers are rendered by the engine/UI from the target
}
