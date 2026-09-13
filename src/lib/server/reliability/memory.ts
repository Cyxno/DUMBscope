/**
 * MemoryAnomalyTracker (FASE C): detects runaway per-process memory growth in
 * the DUMB stack (the production complaint: NZBDAV/InfiniDysk-adjacent memory
 * creeping towards 4–5 GB inside the container's cgroup until a restart is
 * needed — previously invisible to DUMBscope).
 *
 * Detection is deliberately *not* a pure 4 GB rule (brief §31): a finding
 * needs absolute usage above the warning bar AND evidence that the process is
 * substantially above its own rolling-median baseline or growing in a
 * sustained way. Spikes that recover before the persistence window closes
 * never open a finding; recovery must be sustained before one resolves
 * (hysteresis, brief §37); the engine's occurrence bumping prevents flapping
 * (brief §38).
 *
 * Data source: the *existing* metrics WebSocket stream — no extra polling of
 * DUMB. Samples are throttled to one row per process per minute and pruned on
 * a retention window (brief §42/§43).
 */
import type { MemoryAnomalyLevel, MetricsSnapshot, ProcessMemoryView } from '$lib/types';
import { getDb } from '../database/db';

export const MEMORY_TUNING = {
	/** At most one stored sample per process per this interval. */
	sampleIntervalMs: 60_000,
	/** Detection cadence (cheap: a few bounded SQL aggregates). */
	evaluateIntervalMs: 60_000,
	/** Baseline window for the rolling median. */
	baselineWindowMs: 6 * 60 * 60_000,
	/** Recent samples excluded from the baseline: a growing leak must not
	 *  absorb into its own baseline before the persistence window closes. */
	baselineLagMs: 5 * 60_000,
	/** Samples required before relative (baseline) rules arm. */
	baselineMinSamples: 20,
	/** Sample retention (pruned; ~26h keeps a full 24h peak view). */
	retentionMs: 26 * 60 * 60_000,
	/** How often stale samples are pruned. */
	pruneIntervalMs: 30 * 60_000,
	/** A warning condition must hold this long before a finding opens. */
	persistenceMs: 10 * 60_000,
	/** "Substantially above baseline": current ≥ baseline × this factor. */
	warningBaselineFactor: 1.75,
	/** …or at least this much growth over the last hour (when above bar). */
	warningGrowth1hBytes: 512 * 1024 * 1024,
	/** Growth over the last 15 min that counts as "continued growth". */
	growth15mBytes: 96 * 1024 * 1024,
	/** Host (cgroup) memory pressure threshold in percent. */
	hostPressurePercent: 90,
	/** Recovery: current ≤ baseline × this factor… */
	resolveBaselineFactor: 1.25,
	/** …or within this distance of the baseline (large baselines). */
	resolveAbsoluteBytes: 512 * 1024 * 1024,
	/** Recovery must hold this long before a finding resolves. */
	resolveSustainMs: 10 * 60_000,
	/** Hold releases only below warning bar × this factor (arming hysteresis). */
	holdResetFactor: 0.85,
	/** Cap on how many process views are handed to the UI. */
	maxViews: 8
} as const;

export interface MemoryAssessment {
	process: string;
	level: MemoryAnomalyLevel;
	currentBytes: number;
	baselineBytes: number | null;
	delta1hBytes: number | null;
	delta6hBytes: number | null;
	peak24hBytes: number | null;
	/** Host/cgroup memory percent at evaluation time. */
	hostMemPercent: number | null;
	/** Plain-language reasons backing the level (evidence lines). */
	reasons: string[];
	samples: number;
	lastSampleAt: number;
}

/** Widened tuning type (all tuning values are numeric). */
export type MemoryTuning = { [K in keyof typeof MEMORY_TUNING]: number };
/** Overrides for the tuning constants — tests and e2e speed-ups only. */
export type MemoryTuningOverrides = Partial<MemoryTuning>;

export interface MemoryTrackerOptions {
	now?: () => number;
	warningBytes: () => number;
	criticalBytes: () => number;
	enabled?: () => boolean;
	onAssessment: (assessment: MemoryAssessment) => void;
	/** Overrides for the tuning constants — tests and e2e speed-ups only. */
	tuning?: MemoryTuningOverrides;
}

interface ProcessState {
	lastSampleAt: number;
	latestBytes: number;
	/** Consecutive evaluations the warning condition has held. */
	warningHeldSince: number | null;
	/** Baseline frozen when the warning condition first armed. */
	warningBaseline: number | null;
	/** Open level reported to the engine ('ok' = nothing open). */
	openLevel: MemoryAnomalyLevel;
	/** Since when the recovery condition has held continuously. */
	recoveredSince: number | null;
	criticalSince: number | null;
}

export class MemoryAnomalyTracker {
	private readonly nowFn: () => number;
	private readonly warningBytesFn: () => number;
	private readonly criticalBytesFn: () => number;
	private readonly enabledFn: (() => boolean) | null;
	private readonly onAssessment: (assessment: MemoryAssessment) => void;
	/** Effective tuning: defaults merged with the injected overrides. */
	private readonly t: MemoryTuning;
	private processes = new Map<string, ProcessState>();
	private lastEvaluateAt = 0;
	private lastPruneAt = 0;
	private views: ProcessMemoryView[] = [];

	constructor(options: MemoryTrackerOptions) {
		this.nowFn = options.now ?? (() => Date.now());
		this.warningBytesFn = options.warningBytes;
		this.criticalBytesFn = options.criticalBytes;
		this.enabledFn = options.enabled ?? null;
		this.onAssessment = options.onAssessment;
		this.t = { ...MEMORY_TUNING, ...options.tuning };
	}

	/** Number of processes currently sampled. */
	get trackedCount(): number {
		return this.processes.size;
	}

	/** Cached UI views (refreshed on each evaluation). */
	getViews(): ProcessMemoryView[] {
		return this.views;
	}

	/**
	 * Feed one metrics snapshot. Records samples at the throttled cadence; the
	 * per-process value is the max RSS among same-named entries in the frame
	 * (external processes can share a name; the largest is the one at risk).
	 */
	onSnapshot(snapshot: MetricsSnapshot): void {
		if (this.enabledFn && !this.enabledFn()) return;
		const now = this.nowFn();
		const byName = new Map<string, number>();
		for (const proc of snapshot.processes) {
			if (proc.memoryBytes === null) continue;
			byName.set(proc.name, Math.max(byName.get(proc.name) ?? 0, proc.memoryBytes));
		}
		for (const [name, rss] of byName) {
			let state = this.processes.get(name);
			if (!state) {
				state = {
					lastSampleAt: 0,
					latestBytes: rss,
					warningHeldSince: null,
					warningBaseline: null,
					openLevel: 'ok',
					recoveredSince: null,
					criticalSince: null
				};
				this.processes.set(name, state);
			}
			state.latestBytes = rss;
			if (now - state.lastSampleAt >= this.t.sampleIntervalMs) {
				state.lastSampleAt = now;
				try {
					getDb()
						.prepare('INSERT INTO memory_samples (process, at, rss_bytes) VALUES (?, ?, ?)')
						.run(name, now, Math.round(rss));
				} catch {
					// A failed sample insert must never disturb the metrics pipeline.
				}
			}
		}
		this.pruneIfDue(now);
	}

	/**
	 * Run one detection pass. Cheap and failure-isolated: every per-process
	 * evaluation is wrapped, so one bad series never aborts the rest.
	 */
	evaluate(hostMemPercent: number | null): void {
		if (this.enabledFn && !this.enabledFn()) return;
		const now = this.nowFn();
		if (now - this.lastEvaluateAt < this.t.evaluateIntervalMs) return;
		this.lastEvaluateAt = now;
		const warningBytes = this.warningBytesFn();
		const criticalBytes = this.criticalBytesFn();
		const views: ProcessMemoryView[] = [];
		for (const [name, state] of this.processes) {
			try {
				const history = loadSamples(name, now, this.t);
				if (history.latest === null) continue;
				// Assess first, then build the view: the view must reflect the
				// level the assessment just produced (e.g. a fresh 'ok').
				const assess = assessProcess(
					name,
					history,
					state,
					warningBytes,
					criticalBytes,
					hostMemPercent,
					now,
					this.t
				);
				if (assess) this.onAssessment(assess);
				views.push(buildView(name, history, state));
			} catch {
				// Isolated: skip this process until the next evaluation.
			}
		}
		views.sort((a, b) => {
			const rank = (v: ProcessMemoryView) =>
				v.level === 'critical' ? 2 : v.level === 'warning' ? 1 : 0;
			return rank(b) - rank(a) || (b.currentBytes ?? 0) - (a.currentBytes ?? 0);
		});
		this.views = views.slice(0, this.t.maxViews);
	}

	/** Delete samples older than the retention window. */
	private pruneIfDue(now: number): void {
		if (now - this.lastPruneAt < this.t.pruneIntervalMs) return;
		this.lastPruneAt = now;
		try {
			getDb()
				.prepare('DELETE FROM memory_samples WHERE at < ?')
				.run(now - this.t.retentionMs);
		} catch {
			// Retention is best-effort; try again on the next pass.
		}
	}
}

// -----------------------------------------------------------------------------
// Sample loading and derived features
// -----------------------------------------------------------------------------

interface SampleHistory {
	latest: { at: number; bytes: number } | null;
	baseline: number | null;
	baselineSamples: number;
	delta1h: number | null;
	delta6h: number | null;
	peak24h: number | null;
	growth15m: number | null;
}

function loadSamples(process: string, now: number, t: MemoryTuning): SampleHistory {
	const db = getDb();
	const windowStart = now - t.retentionMs;
	const rows = db
		.prepare(
			'SELECT at, rss_bytes FROM memory_samples WHERE process = ? AND at >= ? ORDER BY at ASC'
		)
		.all(process, windowStart) as { at: number; rss_bytes: number }[];
	const history: SampleHistory = {
		latest: null,
		baseline: null,
		baselineSamples: 0,
		delta1h: null,
		delta6h: null,
		peak24h: null,
		growth15m: null
	};
	if (rows.length === 0) return history;
	const last = rows[rows.length - 1]!;
	history.latest = { at: last.at, bytes: last.rss_bytes };

	// Rolling median over the baseline window, lagged by baselineLagMs so the
	// anomaly itself cannot poison the baseline it is judged against (§32).
	const baselineRows = rows.filter(
		(r) => r.at >= now - t.baselineWindowMs && r.at <= now - t.baselineLagMs
	);
	history.baselineSamples = baselineRows.length;
	if (baselineRows.length > 0) {
		const sorted = baselineRows.map((r) => r.rss_bytes).sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		history.baseline =
			sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
	}

	const nearestBefore = (targetMs: number): number | null => {
		let best: number | null = null;
		for (const r of rows) {
			if (r.at <= now - targetMs) best = r.rss_bytes;
			else break;
		}
		return best;
	};
	const hourAgo = nearestBefore(60 * 60_000);
	if (hourAgo !== null) history.delta1h = last.rss_bytes - hourAgo;
	const sixHoursAgo = nearestBefore(6 * 60 * 60_000);
	if (sixHoursAgo !== null) history.delta6h = last.rss_bytes - sixHoursAgo;
	history.peak24h = Math.max(...rows.map((r) => r.rss_bytes));
	const quarterHourAgo = nearestBefore(15 * 60_000);
	if (quarterHourAgo !== null) history.growth15m = last.rss_bytes - quarterHourAgo;
	return history;
}

function buildView(
	process: string,
	history: SampleHistory,
	state: ProcessState
): ProcessMemoryView {
	return {
		process,
		currentBytes: history.latest?.bytes ?? state.latestBytes,
		baselineBytes: history.baseline,
		delta1hBytes: history.delta1h,
		delta6hBytes: history.delta6h,
		peak24hBytes: history.peak24h,
		level: state.openLevel,
		samples: history.baselineSamples,
		lastSampleAt: history.latest?.at ?? null
	};
}

// -----------------------------------------------------------------------------
// Detection rules (brief §31/§33/§34)
// -----------------------------------------------------------------------------

function assessProcess(
	process: string,
	history: SampleHistory,
	state: ProcessState,
	warningBytes: number,
	criticalBytes: number,
	hostMemPercent: number | null,
	now: number,
	t: MemoryTuning
): MemoryAssessment | null {
	const current = history.latest?.bytes;
	if (current === undefined) return null;

	const baseline = history.baseline;
	const hasBaseline = history.baselineSamples >= t.baselineMinSamples && baseline !== null;
	const aboveWarningBar = current >= warningBytes;

	// Evidence for "substantially above its own typical use, or rising fast" —
	// never the bare threshold alone. The baseline is *frozen* on the first
	// arming evaluation: a growing leak must not absorb into its own baseline
	// before the persistence window closes.
	const baselineEvidence =
		hasBaseline && baseline !== null && current >= baseline * t.warningBaselineFactor;
	const growthEvidence =
		aboveWarningBar && history.delta1h !== null && history.delta1h >= t.warningGrowth1hBytes;

	// Arming is sticky: the evidence (frozen baseline) is captured on the
	// first arming evaluation and the hold is only released by a *real*
	// recovery signal (below the bar by a margin) — never by the live median
	// drifting while the process is still above the warning bar.
	const resetHold = current < warningBytes * t.holdResetFactor;
	if (resetHold) {
		state.warningHeldSince = null;
		if (state.openLevel === 'ok') state.warningBaseline = null;
	} else if (aboveWarningBar && (baselineEvidence || growthEvidence)) {
		state.warningHeldSince ??= now;
		state.warningBaseline ??= baseline;
	}
	const referenceBaseline = state.warningBaseline ?? (hasBaseline ? baseline : null);

	const relativeReasons: string[] = [];
	if (referenceBaseline !== null && current >= referenceBaseline * t.warningBaselineFactor) {
		relativeReasons.push(
			`${formatGb(current)} vs typical ${formatGb(referenceBaseline)} (baseline median of ${history.baselineSamples} samples)`
		);
	}
	if (growthEvidence) {
		relativeReasons.push(`+${formatGb(history.delta1h!)} over the last hour`);
	}

	const warningCondition = aboveWarningBar && state.warningHeldSince !== null;
	const growth15m = history.growth15m;
	const continuedGrowth = growth15m !== null && growth15m >= t.growth15mBytes;
	const hostPressure = hostMemPercent !== null && hostMemPercent >= t.hostPressurePercent;
	const criticalCondition =
		current >= criticalBytes && (continuedGrowth || hostPressure || warningCondition);

	if (criticalCondition && warningCondition) {
		state.criticalSince ??= now;
	} else if (!criticalCondition) {
		state.criticalSince = null;
	}

	// Recovery: sustained at-or-below typical use closes a finding (§37).
	const resolveLine = hasBaseline
		? Math.min(
				warningBytes * 0.85,
				(baseline ?? 0) * t.resolveBaselineFactor + t.resolveAbsoluteBytes
			)
		: warningBytes * 0.85;
	const recovered = current <= resolveLine;
	if (recovered) {
		state.recoveredSince ??= now;
	} else {
		state.recoveredSince = null;
	}

	if (state.openLevel !== 'ok') {
		if (state.recoveredSince !== null && now - state.recoveredSince >= t.resolveSustainMs) {
			state.openLevel = 'ok';
			state.criticalSince = null;
			state.warningHeldSince = null;
			state.warningBaseline = null;
			return {
				process,
				level: 'ok',
				currentBytes: current,
				baselineBytes: baseline,
				delta1hBytes: history.delta1h,
				delta6hBytes: history.delta6h,
				peak24hBytes: history.peak24h,
				hostMemPercent,
				reasons: [`memory returned to ${formatGb(current)}`],
				samples: history.baselineSamples,
				lastSampleAt: history.latest?.at ?? now
			};
		}
		// While open: keep severity/summary fresh (escalation included).
		const level: MemoryAnomalyLevel = criticalCondition ? 'critical' : 'warning';
		state.openLevel = level;
		return assessment(process, level, history, referenceBaseline, hostMemPercent, [
			...relativeReasons,
			...(continuedGrowth ? [`still growing: +${formatGb(growth15m ?? 0)} over 15 min`] : []),
			...(hostPressure ? [`host memory pressure at ${hostMemPercent?.toFixed(0)}%`] : [])
		]);
	}

	// Opening a finding requires the warning condition to persist (§27/§38).
	if (
		state.openLevel === 'ok' &&
		state.warningHeldSince !== null &&
		now - state.warningHeldSince >= t.persistenceMs
	) {
		const level: MemoryAnomalyLevel = criticalCondition ? 'critical' : 'warning';
		state.openLevel = level;
		return assessment(process, level, history, referenceBaseline, hostMemPercent, [
			...relativeReasons,
			...(continuedGrowth ? [`still growing: +${formatGb(growth15m ?? 0)} over 15 min`] : []),
			...(hostPressure ? [`host memory pressure at ${hostMemPercent?.toFixed(0)}%`] : [])
		]);
	}
	return null;
}

function assessment(
	process: string,
	level: MemoryAnomalyLevel,
	history: SampleHistory,
	baseline: number | null,
	hostMemPercent: number | null,
	reasons: string[]
): MemoryAssessment {
	return {
		process,
		level,
		currentBytes: history.latest?.bytes ?? 0,
		baselineBytes: baseline,
		delta1hBytes: history.delta1h,
		delta6hBytes: history.delta6h,
		peak24hBytes: history.peak24h,
		hostMemPercent,
		reasons,
		samples: history.baselineSamples,
		lastSampleAt: history.latest?.at ?? Date.now()
	};
}

function formatGb(bytes: number): string {
	const gb = bytes / 1024 ** 3;
	if (gb >= 1 || gb === 0) return `${gb.toFixed(1)} GB`;
	return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}
