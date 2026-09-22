/**
 * DUMBscope self-anomaly detection (§5): sustained-trend findings about
 * DUMBscope itself — the class of regressions that silently killed
 * deployments before (worker leak 2026-09-17, reconciliation slowdowns).
 *
 * The architecture is deliberately the SAME as the stack-side memory anomaly
 * tracker (FASE C): a rolling lagged baseline, absolute AND relative
 * evidence, a persistence window before anything opens, hysteresis before
 * anything resolves, and recovery that must be sustained — never a single
 * threshold crossing. Trends use the shared Theil–Sen estimator (§7), so a
 * plateau with one spike is not a "leak".
 *
 * Findings go through the normal incident engine (fingerprint `self:<metric>`)
 * — there is no second findings engine.
 */
import { estimateTrend, formatRate, projectToThreshold, type TrendPoint } from './trend';
import { loadSeries, type RuntimeSample } from './store';

export const SELF_ANOMALY_TUNING = {
	/** Evaluation cadence (the sampler persists one row per minute). */
	evaluateIntervalMs: 5 * 60_000,
	/** Baseline window + lag: the recent trend must not poison its own baseline. */
	baselineWindowMs: 6 * 60 * 60_000,
	baselineLagMs: 30 * 60_000,
	/** Samples required before relative rules arm. */
	baselineMinSamples: 15,
	/** How long evidence must hold before a finding opens. */
	persistenceMs: 15 * 60_000,
	/** How long recovery must hold before a finding resolves. */
	resolveSustainMs: 10 * 60_000,
	// --- per-metric evidence thresholds -----------------------------------
	/** RSS: minimum absolute level before growth matters at all. */
	rssFloorBytes: 768 * 1024 * 1024,
	/** RSS: sustained growth rate that counts as evidence… */
	rssGrowthBytesPerHour: 96 * 1024 * 1024,
	/** …and how far above baseline counts as "substantially above typical". */
	rssBaselineFactor: 1.5,
	/** Workers: absolute count that is already suspicious on its own. */
	workersAbsoluteMax: 12,
	/** Workers: growth above this rate (per hour) is a leak signature. */
	workersGrowthPerHour: 4,
	/** FDs: absolute floor and growth rate for evidence. */
	fdsFloor: 1_200,
	fdsGrowthPerHour: 60,
	/** Event-loop lag: sustained average above this degrades everything. */
	lagSustainedMs: 250,
	/** Reconciliation duration: median must exceed both… */
	reconRegressionFactor: 2,
	reconRegressionFloorMs: 90_000
} as const;

export interface SelfAnomalyFinding {
	fingerprint: string;
	severity: 'warning' | 'critical';
	title: string;
	summary: string;
	evidence: string;
}

interface MetricState {
	open: boolean;
	heldSince: number | null;
	recoveredSince: number | null;
	/** Baseline frozen when the finding armed (leak must not absorb into it). */
	frozenBaseline: number | null;
	lastEvaluateAt: number;
}

interface MetricEvaluation {
	shouldOpen: boolean;
	shouldResolve: boolean;
	severity: 'warning' | 'critical';
	title: string;
	summary: string;
	evidence: string;
}

function fmtBytes(bytes: number): string {
	const gb = bytes / 1024 ** 3;
	if (gb >= 1) return `${gb.toFixed(1)} GB`;
	return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export class SelfAnomalyMonitor {
	private readonly t: typeof SELF_ANOMALY_TUNING;
	private states = new Map<string, MetricState>();
	private onFinding: (finding: SelfAnomalyFinding) => void;
	private onResolve: (fingerprint: string, message: string) => void;
	private enabledFn: () => boolean;
	private lastEvaluateAt = 0;

	constructor(options: {
		onFinding: (finding: SelfAnomalyFinding) => void;
		onResolve: (fingerprint: string, message: string) => void;
		enabled?: () => boolean;
		tuning?: Partial<typeof SELF_ANOMALY_TUNING>;
	}) {
		this.onFinding = options.onFinding;
		this.onResolve = options.onResolve;
		this.enabledFn = options.enabled ?? (() => true);
		this.t = { ...SELF_ANOMALY_TUNING, ...options.tuning };
	}

	evaluate(now: number): void {
		if (!this.enabledFn()) return;
		if (now - this.lastEvaluateAt < this.t.evaluateIntervalMs) return;
		this.lastEvaluateAt = now;
		// Metrics are read from the persisted 1-minute tier — the anomaly view
		// and the UI graphs always agree because they share one storage.
		const since = now - Math.max(this.t.baselineWindowMs + this.t.baselineLagMs, 3 * 60 * 60_000);
		for (const key of ['rss', 'workers', 'fds', 'lag', 'recon'] as const) {
			try {
				this.evaluateMetric(key, now, since);
			} catch {
				// One bad metric never aborts the others.
			}
		}
	}

	private stateFor(key: string): MetricState {
		let state = this.states.get(key);
		if (!state) {
			state = {
				open: false,
				heldSince: null,
				recoveredSince: null,
				frozenBaseline: null,
				lastEvaluateAt: 0
			};
			this.states.set(key, state);
		}
		return state;
	}

	private samples(
		key: 'rss' | 'workers' | 'fds' | 'lag' | 'recon',
		since: number
	): {
		series: TrendPoint[];
		baseline: number | null;
	} {
		const raw = loadSeries(key, since) as { at: number; value: number }[];
		const recent = raw.filter((p) => p.at > 0);
		const baselineRows = recent.filter(
			(p) =>
				p.at >= Date.now() - this.t.baselineWindowMs && p.at <= Date.now() - this.t.baselineLagMs
		);
		const baseline =
			baselineRows.length >= this.t.baselineMinSamples
				? medianOf(baselineRows.map((p) => p.value))
				: null;
		return { series: recent, baseline };
	}

	private evaluateMetric(
		key: 'rss' | 'workers' | 'fds' | 'lag' | 'recon',
		now: number,
		since: number
	): void {
		const { series, baseline } = this.samples(key, since);
		if (series.length < 5) return; // not enough data — never a verdict
		const state = this.stateFor(key);
		const trend = estimateTrend(series);
		const latest = series[series.length - 1]!;
		const evaluation = assess(key, latest.value, latest.at, baseline, trend, this.t, state, series);
		const fingerprint = `self:${key}`;

		if (evaluation.shouldResolve) {
			// Recovery must hold for the full sustain window (hysteresis) —
			// never a single good sample.
			state.recoveredSince ??= now;
			if (now - state.recoveredSince >= this.t.resolveSustainMs && state.open) {
				state.open = false;
				state.heldSince = null;
				state.recoveredSince = null;
				state.frozenBaseline = null;
				this.onResolve(fingerprint, evaluation.summary);
			}
			return;
		}
		state.recoveredSince = null;

		if (evaluation.shouldOpen) {
			state.heldSince ??= now;
			state.frozenBaseline ??= baseline;
			if (now - state.heldSince >= this.t.persistenceMs) {
				const firstOpen = !state.open;
				state.open = true;
				if (firstOpen) {
					this.onFinding({
						fingerprint,
						severity: evaluation.severity,
						title: evaluation.title,
						summary: evaluation.summary,
						evidence: evaluation.evidence
					});
				}
			}
			return;
		}
		// Evidence gone before the persistence window closed: reset the hold.
		if (!state.open) {
			state.heldSince = null;
			state.frozenBaseline = null;
		}
	}
}

function medianOf(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function assess(
	key: 'rss' | 'workers' | 'fds' | 'lag' | 'recon',
	current: number,
	lastAt: number,
	baseline: number | null,
	trend: ReturnType<typeof estimateTrend>,
	t: typeof SELF_ANOMALY_TUNING,
	state: MetricState,
	series: TrendPoint[]
): MetricEvaluation {
	const reference = state.frozenBaseline ?? baseline;
	switch (key) {
		case 'rss': {
			const rate = trend?.ratePerHour ?? 0;
			const confidence = trend?.confidence ?? 0;
			const growthEvidence = rate >= t.rssGrowthBytesPerHour && confidence >= 0.7;
			const levelEvidence = current >= t.rssFloorBytes;
			const relativeEvidence = reference !== null && current >= reference * t.rssBaselineFactor;
			const evidence = [
				`rss=${fmtBytes(current)}`,
				reference !== null ? `baseline=${fmtBytes(reference)}` : null,
				growthEvidence
					? `trend=${formatRate(rate, 'MB')} (${Math.round(confidence * 100)}% agreement)`
					: null
			]
				.filter(Boolean)
				.join(', ');
			const shouldOpen = levelEvidence && (growthEvidence || relativeEvidence);
			// Recovery lines: back near baseline, or well under the floor. The
			// sustained window is enforced by the caller's state machine.
			const shouldResolve =
				reference !== null && current <= reference * 1.25 ? true : current < t.rssFloorBytes * 0.8;
			let summary = `DUMBscope RSS is increasing ${formatRate(rate, 'MB')} — current ${fmtBytes(current)}`;
			if (reference !== null) summary += ` · baseline ${fmtBytes(reference)}`;
			const projection = trend ? projectToThreshold(trend, lastAt, t.rssFloorBytes * 4) : null;
			if (projection) {
				summary += ` · estimate: reaches ${fmtBytes(projection.threshold)} in ~${Math.round(projection.hoursRemaining)}h`;
			}
			return {
				shouldOpen,
				shouldResolve,
				severity: current >= t.rssFloorBytes * 3 ? 'critical' : 'warning',
				title: 'DUMBscope memory use is growing abnormally',
				summary,
				evidence
			};
		}
		case 'workers': {
			const rate = trend?.ratePerHour ?? 0;
			const growthEvidence = rate >= t.workersGrowthPerHour && (trend?.confidence ?? 0) >= 0.7;
			const absoluteEvidence = current >= t.workersAbsoluteMax;
			const first = series[Math.max(0, series.length - 36)]?.value ?? current;
			const evidence = `workers=${current} · ${Math.round((lastAt - series[0]!.at) / 60_000)} min window · rate=${formatRate(rate, 'workers')}`;
			const shouldOpen = absoluteEvidence && (growthEvidence || current >= (reference ?? 0) + 6);
			const shouldResolve = current <= Math.max(2, (reference ?? 2) * 1.5);
			return {
				shouldOpen,
				shouldResolve,
				severity: current >= t.workersAbsoluteMax * 3 ? 'critical' : 'warning',
				title: 'DUMBscope worker count is growing abnormally',
				summary: `Workers ${first} → ${current} · baseline ${reference === null ? 'unknown' : `~${Math.round(reference)}`} · rate ${formatRate(rate, 'workers')}`,
				evidence
			};
		}
		case 'fds': {
			const rate = trend?.ratePerHour ?? 0;
			const growthEvidence = rate >= t.fdsGrowthPerHour && (trend?.confidence ?? 0) >= 0.7;
			const evidence = `fds=${current} · rate=${formatRate(rate, 'FDs')}`;
			const shouldOpen = current >= t.fdsFloor && growthEvidence;
			const shouldResolve = current < t.fdsFloor * 0.8;
			const projection = trend ? projectToThreshold(trend, lastAt, 65_535) : null;
			let summary = `DUMBscope file-descriptor count is growing ${formatRate(rate, 'FDs')} — current ${current}`;
			if (projection)
				summary += ` · estimate: resource exhaustion in ~${Math.round(projection.hoursRemaining)}h`;
			return {
				shouldOpen,
				shouldResolve,
				severity: 'warning',
				title: 'DUMBscope file descriptors are growing abnormally',
				summary,
				evidence
			};
		}
		case 'lag': {
			const evidence = `avg=${Math.round(current)}ms`;
			const shouldOpen = current >= t.lagSustainedMs;
			const shouldResolve = current < t.lagSustainedMs * 0.4;
			return {
				shouldOpen,
				shouldResolve,
				severity: current >= t.lagSustainedMs * 3 ? 'critical' : 'warning',
				title: 'DUMBscope event-loop lag is unusually high',
				summary: `Event-loop lag averaging ${Math.round(current)}ms — UI and probes may feel sluggish`,
				evidence
			};
		}
		case 'recon': {
			const recent = medianOf(series.slice(-5).map((p) => p.value));
			const referenceValue = reference ?? medianOf(series.map((p) => p.value));
			const regressed =
				recent >= t.reconRegressionFloorMs && recent >= referenceValue * t.reconRegressionFactor;
			const evidence = `recent median=${Math.round(recent / 1000)}s · baseline=${Math.round(referenceValue / 1000)}s`;
			const shouldOpen = regressed;
			const shouldResolve = recent < Math.max(t.reconRegressionFloorMs, referenceValue * 1.3);
			return {
				shouldOpen,
				shouldResolve,
				severity: 'warning',
				title: 'Library reconciliation is becoming progressively slower',
				summary: `Recent cycles median ${Math.round(recent / 1000)}s vs ${Math.round(referenceValue / 1000)}s baseline — probe load or mount latency is growing`,
				evidence
			};
		}
	}
}

/** Exported for tests: build samples straight from RuntimeSample rows. */
export function samplesFromRuntime(
	rows: RuntimeSample[],
	pick: (r: RuntimeSample) => number | null
): TrendPoint[] {
	return rows
		.map((r) => ({ at: r.at, value: pick(r) }))
		.filter((p): p is TrendPoint => p.value !== null);
}
