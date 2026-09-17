/**
 * Memory-leak regression: probe workers must be reclaimed on EVERY round
 * exit path, success included (2026-09-17 production finding).
 *
 * The mount monitor runs one probe round per mount per minute. Before the
 * fix, `runProbeRound` only terminated its worker on a deadline overrun, so
 * every healthy round leaked one idle worker isolate (~8 MB RSS). With four
 * mounts configured that was ~4 workers/min ≈ 2 GB/hour of steady growth in
 * every DUMBscope instance — beta merely reached visibility first because it
 * stays up longest.
 *
 * These tests spawn many REAL workers (the same eval'd WORKER_SOURCE as
 * production) and assert the process thread count returns to baseline.
 * Vitest runs each test file in its own child process, so /proc/self/task
 * counts only this file's threads; the baseline is captured before any
 * worker exists and the tolerance is generous so timing never flakes.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProbeRound } from '../src/lib/server/reliability/fsprobe';

/** Live OS threads of this process (Linux only; undefined elsewhere). */
function liveThreads(): number | undefined {
	try {
		return fs.readdirSync('/proc/self/task').length;
	} catch {
		return undefined;
	}
}

/** Small settle window so terminate() completes before calibration. */
async function waitForThreadsSettled(): Promise<void> {
	await new Promise((r) => setTimeout(r, 300));
}

/** Poll until the thread count is back at `baseline + slack` or below. */
async function waitForThreadsAtMost(
	baseline: number,
	slack: number,
	timeoutMs: number
): Promise<number | undefined> {
	const deadline = Date.now() + timeoutMs;
	let count = liveThreads();
	while (Date.now() < deadline) {
		count = liveThreads();
		if (count === undefined || (count !== undefined && count <= baseline + slack)) return count;
		await new Promise((r) => setTimeout(r, 50));
	}
	return count;
}

function makeProbeTarget(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-fsprobe-leak-'));
	fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
	for (let i = 0; i < 4; i++) {
		fs.symlinkSync(path.join(dir, 'file.txt'), path.join(dir, `link.${i}.mkv`));
	}
	return dir;
}

const HEALTHY_OPS = (dir: string) =>
	[
		{ op: 'stat' as const, path: path.join(dir, 'file.txt') },
		{ op: 'list' as const, path: dir, entryBudget: 50, depth: 1, linkSampleCap: 4 }
	];

describe('fsprobe worker lifecycle (memory-leak regression)', () => {
	it('reclaims its worker after healthy rounds — 40 rounds add no threads', async () => {
		const dir = makeProbeTarget();
		// Self-calibrating baseline: run one warm-up round first, then measure.
		// V8 spawns lazy platform threads (GC/compiler) under load, so absolute
		// baselines drift; what must NEVER drift is per-round growth. The old
		// leak added exactly one thread per round (+39 here).
		const warmup = await runProbeRound(HEALTHY_OPS(dir), 10_000);
		expect(warmup.results.every((r) => r.ok)).toBe(true);
		await waitForThreadsSettled();
		const afterWarmup = liveThreads()!;
		expect(afterWarmup).toBeDefined();

		for (let round = 0; round < 39; round++) {
			const result = await runProbeRound(HEALTHY_OPS(dir), 10_000);
			// Every round must actually succeed — otherwise the test would
			// pass vacuously while probing nothing.
			expect(result.results.every((r) => r.ok)).toBe(true);
			expect(result.timedOut).toBe(false);
		}

		// terminate() is async: give the last worker a generous window to die.
		const live = await waitForThreadsAtMost(afterWarmup, 2, 10_000);
		expect(live).toBeDefined();
		expect(live! - afterWarmup).toBeLessThanOrEqual(2);
	});

	it('reclaims its worker after a timed-out round', async () => {
		const baseline = liveThreads();
		expect(baseline).toBeDefined();
		const dir = makeProbeTarget();
		// Deadline shorter than worker startup: the round times out and the
		// worker must still be reaped.
		const result = await runProbeRound([{ op: 'stat', path: path.join(dir, 'file.txt') }], 1);
		expect(result.timedOut).toBe(true);

		const live = await waitForThreadsAtMost(baseline!, 3, 10_000);
		expect(live! - baseline!).toBeLessThanOrEqual(3);
	});

	it('keeps the thread count bounded across mixed healthy and timeout rounds', async () => {
		const baseline = liveThreads();
		expect(baseline).toBeDefined();
		const dir = makeProbeTarget();
		for (let round = 0; round < 25; round++) {
			await runProbeRound(HEALTHY_OPS(dir), 10_000);
			await runProbeRound([{ op: 'stat', path: path.join(dir, 'file.txt') }], 1);
		}
		const live = await waitForThreadsAtMost(baseline!, 3, 10_000);
		expect(live! - baseline!).toBeLessThanOrEqual(3);
	});
});
