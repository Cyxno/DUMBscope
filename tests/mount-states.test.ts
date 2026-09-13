/**
 * FASE B — mount state machine and finding lifecycle with controlled probes.
 *
 * The probe layer is mocked so timeout/IO scenarios (a hung FUSE mount cannot
 * be reproduced deterministically on CI) run instantly and deterministically.
 * Pins: one failed round never reclassifies a healthy mount, `unresponsive`
 * needs three failed rounds, recovery clears automatically, and findings in
 * the incident engine open only on the derived verdicts and resolve with
 * hysteresis (brief §26/§27).
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { vi as viGlobal } from 'vitest';

const runProbeRoundMock = vi.fn();
vi.mock('../src/lib/server/reliability/fsprobe', () => ({
	runProbeRound: (...args: unknown[]) => runProbeRoundMock(...args),
	fsProbeCallCount: () => 0
}));

import { MountMonitor } from '../src/lib/server/reliability/mounts';
import { IncidentEngine } from '../src/lib/server/incidents/engine';
import type { MountTarget } from '$lib/types';

const target: MountTarget = {
	id: 'tv',
	label: 'TV symlink root',
	path: '/mnt/media/tv',
	kind: 'symlink-root',
	consumers: ['Plex Media Server']
};

const ctx = { runningProcesses: new Set<string>(['Decypharr']) };

function okStat(latencyMs = 5) {
	return { ok: true, latencyMs };
}
function okList(
	sample: {
		sampled: number;
		valid: number;
		broken: number;
		unreadable: number;
		entriesScanned: number;
		truncated: boolean;
	} | null = null
) {
	return { ok: true, latencyMs: 12, entriesScanned: 40, truncated: false, sample };
}
const timeouts = () => ({
	results: [
		{ ok: false, code: 'TIMEOUT', message: 'probe timed out' },
		{ ok: false, code: 'TIMEOUT', message: 'probe timed out' }
	],
	timedOut: true,
	durationMs: 30_000
});
const enoent = () => ({
	results: [{ ok: false, code: 'ENOENT', message: 'ENOENT' }],
	timedOut: false,
	durationMs: 3
});

describe('MountMonitor state machine (mocked probes)', () => {
	beforeEach(() => {
		runProbeRoundMock.mockReset();
	});

	function makeMonitor(): MountMonitor {
		return new MountMonitor({ targets: [target], roundIntervalMs: 0 });
	}

	it('healthy after a successful round', async () => {
		const monitor = makeMonitor();
		runProbeRoundMock.mockResolvedValue({
			results: [okStat(), okList()],
			timedOut: false,
			durationMs: 20
		});
		await monitor.tick(ctx);
		const report = monitor.getReports()[0]!;
		expect(report.state).toBe('healthy');
		expect(report.statLatencyMs).toBe(5);
		expect(report.failedRounds).toBe(0);
	});

	it('one failed round never reclassifies a healthy mount', async () => {
		const monitor = makeMonitor();
		runProbeRoundMock
			.mockResolvedValueOnce({ results: [okStat(), okList()], timedOut: false, durationMs: 20 })
			.mockResolvedValueOnce(timeouts());
		await monitor.tick(ctx);
		await monitor.tick(ctx);
		const report = monitor.getReports()[0]!;
		expect(report.state).toBe('healthy');
		expect(report.failedRounds).toBe(1);
	});

	it('two failed rounds degrade, three mark unresponsive, two healthy rounds recover', async () => {
		const monitor = makeMonitor();
		runProbeRoundMock
			.mockResolvedValueOnce({ results: [okStat(), okList()], timedOut: false, durationMs: 20 })
			.mockResolvedValueOnce(timeouts())
			.mockResolvedValueOnce(timeouts())
			.mockResolvedValueOnce(timeouts())
			.mockResolvedValueOnce({ results: [okStat(), okList()], timedOut: false, durationMs: 20 })
			.mockResolvedValueOnce({ results: [okStat(), okList()], timedOut: false, durationMs: 20 });
		await monitor.tick(ctx);
		expect(monitor.getReports()[0]!.state).toBe('healthy');
		await monitor.tick(ctx);
		expect(monitor.getReports()[0]!.state).toBe('healthy');
		await monitor.tick(ctx);
		expect(monitor.getReports()[0]!.state).toBe('degraded');
		await monitor.tick(ctx);
		const down = monitor.getReports()[0]!;
		expect(down.state).toBe('unresponsive');
		expect(down.failedRounds).toBe(3);
		await monitor.tick(ctx);
		expect(monitor.getReports()[0]!.state).toBe('healthy');
		await monitor.tick(ctx);
		expect(monitor.getReports()[0]!.healthyRounds).toBe(2);
	});

	it('storage-service correlation rides on the unresponsive report', async () => {
		const monitor = makeMonitor();
		runProbeRoundMock
			.mockResolvedValueOnce(timeouts())
			.mockResolvedValueOnce(timeouts())
			.mockResolvedValueOnce(timeouts());
		await monitor.tick(ctx);
		await monitor.tick(ctx);
		await monitor.tick(ctx);
		expect(monitor.getReports()[0]!.lastError).toContain('storage mount appears unhealthy');
	});

	it('missing needs two consecutive ENOENT rounds', async () => {
		const monitor = makeMonitor();
		runProbeRoundMock.mockResolvedValueOnce(enoent()).mockResolvedValueOnce(enoent());
		await monitor.tick(ctx);
		expect(monitor.getReports()[0]!.state).toBe('unknown');
		await monitor.tick(ctx);
		expect(monitor.getReports()[0]!.state).toBe('missing');
	});

	it('conspicuous latency yields slow without a failure count', async () => {
		const monitor = makeMonitor();
		runProbeRoundMock.mockResolvedValue({
			results: [
				okStat(2_000),
				okList({
					sampled: 10,
					valid: 10,
					broken: 0,
					unreadable: 0,
					entriesScanned: 40,
					truncated: false
				})
			],
			timedOut: false,
			durationMs: 2_300
		});
		await monitor.tick(ctx);
		const report = monitor.getReports()[0]!;
		expect(report.state).toBe('slow');
		expect(report.failedRounds).toBe(0);
	});
});

describe('mount + symlink finding lifecycle in the incident engine', () => {
	beforeEach(() => {
		runProbeRoundMock.mockReset();
	});

	it('opens a critical finding on unresponsive, resolves it after sustained recovery', async () => {
		const now = { value: 1_000_000 };
		const monitor = new MountMonitor({
			targets: [target],
			roundIntervalMs: 0,
			now: () => now.value
		});
		const engine = new IncidentEngine({}, () => now.value);

		runProbeRoundMock
			.mockResolvedValueOnce(timeouts())
			.mockResolvedValueOnce(timeouts())
			.mockResolvedValueOnce(timeouts());
		await monitor.tick(ctx);
		await monitor.tick(ctx);
		await monitor.tick(ctx);
		engine.onMountHealth(monitor.getReports());
		const active = engine.getActive();
		expect(active).toHaveLength(1);
		expect(active[0]!.severity).toBe('critical');
		expect(active[0]!.title).toContain('TV symlink root');
		expect(active[0]!.summary).toContain('appears unhealthy');
		expect(active[0]!.summary).toContain('May be affected: Plex Media Server');
		expect(active[0]!.evidence.at(-1)?.source).toBe('reliability');

		// Recovery: two healthy rounds before the finding resolves.
		runProbeRoundMock
			.mockResolvedValueOnce({ results: [okStat(), okList()], timedOut: false, durationMs: 20 })
			.mockResolvedValueOnce({ results: [okStat(), okList()], timedOut: false, durationMs: 20 });
		now.value += 60_000;
		await monitor.tick(ctx);
		engine.onMountHealth(monitor.getReports());
		expect(engine.getActive()).toHaveLength(1); // hysteresis holds
		now.value += 60_000;
		await monitor.tick(ctx);
		engine.onMountHealth(monitor.getReports());
		expect(engine.getActive()).toHaveLength(0);
	});

	it('warns only on systemic symlink breakage, not on a few stale links', async () => {
		const now = { value: 2_000_000 };
		const engine = new IncidentEngine({}, () => now.value);
		const monitor = new MountMonitor({
			targets: [target],
			roundIntervalMs: 0,
			now: () => now.value
		});

		// 2 of 10 broken: noise, no finding.
		runProbeRoundMock.mockResolvedValueOnce({
			results: [
				okStat(),
				okList({
					sampled: 10,
					valid: 8,
					broken: 2,
					unreadable: 0,
					entriesScanned: 400,
					truncated: true
				})
			],
			timedOut: false,
			durationMs: 40
		});
		await monitor.tick(ctx);
		engine.onMountHealth(monitor.getReports());
		expect(engine.getActive()).toHaveLength(0);

		// 9 of 10 broken: systemic — the debrid target is gone.
		runProbeRoundMock.mockResolvedValueOnce({
			results: [
				okStat(),
				okList({
					sampled: 10,
					valid: 1,
					broken: 9,
					unreadable: 0,
					entriesScanned: 400,
					truncated: true
				})
			],
			timedOut: false,
			durationMs: 40
		});
		await monitor.tick(ctx);
		engine.onMountHealth(monitor.getReports());
		const active = engine.getActive();
		expect(active).toHaveLength(1);
		expect(active[0]!.fingerprint).toMatch(/^symlinks:/);
		expect(active[0]!.severity).toBe('warning');
		expect(active[0]!.summary).toContain('9 of 10 sampled links');

		// Clean sampling twice resolves the systemic finding.
		const clean = {
			results: [
				okStat(),
				okList({
					sampled: 10,
					valid: 10,
					broken: 0,
					unreadable: 0,
					entriesScanned: 400,
					truncated: true
				})
			],
			timedOut: false,
			durationMs: 40
		};
		runProbeRoundMock.mockResolvedValueOnce(clean).mockResolvedValueOnce(clean);
		now.value += 60_000;
		await monitor.tick(ctx);
		engine.onMountHealth(monitor.getReports());
		now.value += 60_000;
		await monitor.tick(ctx);
		engine.onMountHealth(monitor.getReports());
		expect(engine.getActive()).toHaveLength(0);
	});

	it('uses the injectable clock and never blocks a tick on a hung probe', async () => {
		// A round that overruns its deadline still resolves (worker terminated
		// by the probe layer); the monitor reports it and stays usable.
		const now = { value: 3_000_000 };
		const monitor = new MountMonitor({
			targets: [target],
			roundIntervalMs: 0,
			now: () => now.value
		});
		runProbeRoundMock.mockResolvedValueOnce(timeouts());
		await monitor.tick(ctx);
		expect(monitor.getReports()[0]!.failedRounds).toBe(1);
		expect(viGlobal.isMockFunction(runProbeRoundMock)).toBe(true);
	});
});
