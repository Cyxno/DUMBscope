/**
 * Reconciliation cancellation (v0.8.2): a wedged cycle is aborted at its
 * hard deadline, state is always cleaned up, the next cycle runs normally,
 * and an aborted cycle can never apply findings deltas (a stale open/close
 * would resolve real library findings).
 */
import { describe, expect, it, afterEach } from 'vitest';
import {
	ReconciliationRunner,
	type ArrTarget,
	type ReconciliationRunnerOptions
} from '../src/lib/server/reconciliation/cycle';
import type { ReconcileStats } from '../src/lib/server/reconciliation/library';

const BASE_SETTINGS = {
	enabled: true,
	mounts: [],
	aliases: [],
	plexDbPath: null,
	plexUrl: null,
	plexToken: null,
	plexAutoRefresh: false,
	selftestBrokenPath: null,
	selftestGhostPath: null
};

function makeHarness(overrides: {
	resolveArrTargets?: ReconciliationRunnerOptions['resolveArrTargets'];
	cycleDeadlineMs?: number | (() => number);
	openFindings?: string[];
}) {
	const reported: Array<{ fingerprint: string }> = [];
	const resolved: string[] = [];
	const runner = new ReconciliationRunner({
		getSettings: () => ({ ...BASE_SETTINGS }),
		reportFinding: (f) => reported.push(f),
		resolveFinding: (fp) => resolved.push(fp),
		getActiveFingerprints: () => overrides.openFindings ?? [],
		resolveArrTargets: overrides.resolveArrTargets ?? (() => Promise.resolve([])),
		now: () => 1_000_000_000,
		cycleDeadlineMs: overrides.cycleDeadlineMs
	} as ReconciliationRunnerOptions);
	return { runner, reported, resolved };
}

const settle = (ms = 60) => new Promise<void>((r) => setTimeout(r, ms));

afterEach(() => {
	// No timers may outlive a test (deadline timers are unref'd, but the
	// runner must still have cleaned its own state).
});

describe('stuck-cycle cancellation and recovery', () => {
	it('aborts a wedged cycle at the hard deadline, records timeout, and cleans up', async () => {
		const { runner } = makeHarness({
			cycleDeadlineMs: 20,
			resolveArrTargets: () => new Promise(() => {}) // wedged: never settles
		});
		await runner.run();
		const o = runner.observability();
		expect(o.running).toBe(false);
		expect(o.currentRunStartedAt).toBeNull();
		expect(o.lastAttempt?.status).toBe('timeout');
		expect(o.lastAttempt?.error).toContain('hard deadline');
		expect(o.lastAttempt?.durationMs).toBeLessThan(5_000);
		expect(o.recent.at(-1)?.status).toBe('timeout');
	});

	it('never lets two cycles overlap', async () => {
		let releaseTargets: (() => void) | null = null;
		const { runner, reported } = makeHarness({
			cycleDeadlineMs: 5_000,
			resolveArrTargets: () =>
				new Promise<ArrTarget[]>((resolve) => {
					releaseTargets = () => resolve([]);
				})
		});
		const first = runner.run();
		await settle(5);
		expect(runner.observability().running).toBe(true);
		const startedBefore = runner.observability().currentRunStartedAt;
		const attemptsBefore = reported.length;

		// The interval may fire again at any time: the overlap guard must
		// return immediately without side effects or state changes.
		await runner.run();
		expect(runner.observability().running).toBe(true);
		expect(runner.observability().currentRunStartedAt).toBe(startedBefore);
		expect(reported).toHaveLength(attemptsBefore);

		releaseTargets!();
		await first;
		expect(runner.observability().running).toBe(false);
	});

	it('aborted cycles never resolve library findings — even after cleanup', async () => {
		const openFinding = 'recon:plex-ghost:some-item';
		const { runner, resolved, reported } = makeHarness({
			cycleDeadlineMs: 20,
			openFindings: [openFinding],
			resolveArrTargets: () => new Promise(() => {}) // wedged before any data
		});
		await runner.run();
		expect(runner.observability().lastAttempt?.status).toBe('timeout');

		// Let the abandoned continuation and every microtask/timer flush:
		// it must stay a silent bystander — no resolves, no new findings.
		await settle(80);
		expect(resolved).toHaveLength(0);
		expect(reported).toHaveLength(0);
	});

	it('the next cycle after a timeout runs normally and records recovery', async () => {
		let wedge = true;
		let deadline = 20;
		const { runner, resolved } = makeHarness({
			openFindings: ['recon:plex-ghost:some-item'],
			cycleDeadlineMs: () => deadline,
			resolveArrTargets: () => (wedge ? new Promise(() => {}) : Promise.resolve([]))
		});
		// Cycle 1: wedged, aborted at the deadline.
		await runner.run();
		expect(runner.observability().lastAttempt?.status).toBe('timeout');

		// Cycle 2: healthy. Runs normally without needing a process restart
		// and records a successful recovery in observability.
		wedge = false;
		deadline = 5_000;
		await runner.run();
		const o = runner.observability();
		expect(o.running).toBe(false);
		expect(o.lastAttempt?.status).toBe('ok');
		expect(o.lastAttempt?.stats).not.toBeNull();
		expect(o.lastSuccess?.status).toBe('ok');
		// A successful complete cycle applies the open/close delta: the
		// stale finding is gone (and only now — the timeout must not have).
		expect(resolved).toEqual(['recon:plex-ghost:some-item']);
		expect(o.recent.map((r) => r.status)).toEqual(['timeout', 'ok']);
	});

	it('stats carry the reconciled counts on the recovering cycle', async () => {
		let wedge = true;
		let deadline = 20;
		const { runner } = makeHarness({
			cycleDeadlineMs: () => deadline,
			resolveArrTargets: () => (wedge ? new Promise(() => {}) : Promise.resolve([]))
		});
		await runner.run();
		wedge = false;
		deadline = 5_000;
		await runner.run();
		const stats = runner.observability().lastAttempt?.stats as ReconcileStats | null;
		expect(stats).not.toBeNull();
		expect(stats!.durationMs).toBeGreaterThanOrEqual(0);
		expect(typeof stats!.arrChecked).toBe('number');
	});
});
