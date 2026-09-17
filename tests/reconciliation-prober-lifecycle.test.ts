/**
 * Memory-leak regression for the reconciliation prober (2026-09-17).
 *
 * The prober is long-lived by design (one worker for the runner's lifetime),
 * so two invariants must hold forever:
 *  1. many probe ops never grow the worker population (one worker total);
 *  2. dispose() reclaims the last worker — the runner holds no idle isolate.
 *
 * The historical bug class this guards: the 'exit'/'error' handler nulled and
 * terminated `this.worker` *unconditionally*, so a stale worker's death could
 * kill the current replacement mid-op and strand in-flight probes.
 *
 * Worker liveness is measured as OS-thread delta of this test process
 * (vitest runs each file in its own process), with generous slack.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkerLibraryProber } from '../src/lib/server/reconciliation/prober';

function liveThreads(): number | undefined {
	try {
		return fs.readdirSync('/proc/self/task').length;
	} catch {
		return undefined;
	}
}

async function waitForThreadsAtMost(
	baseline: number,
	slack: number,
	timeoutMs: number
): Promise<number | undefined> {
	const deadline = Date.now() + timeoutMs;
	let count = liveThreads();
	while (Date.now() < deadline) {
		count = liveThreads();
		if (count === undefined || count <= baseline + slack) return count;
		await new Promise((r) => setTimeout(r, 50));
	}
	return count;
}

const probers: WorkerLibraryProber[] = [];

function makeTree(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-prober-leak-'));
	fs.writeFileSync(path.join(dir, 'real.txt'), 'x');
	fs.symlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'good.mkv'));
	fs.symlinkSync('/nonexistent/prober-target', path.join(dir, 'dangling.mkv'));
	return dir;
}

describe('WorkerLibraryProber lifecycle (memory-leak regression)', () => {
	afterEach(async () => {
		const baseline = liveThreads()!;
		for (const p of probers.splice(0)) p.dispose();
		await waitForThreadsAtMost(baseline, 3, 10_000);
	});

	it('stays at one worker across 200 mixed probe ops', async () => {
		const baseline = liveThreads()!;
		const dir = makeTree();
		const prober = new WorkerLibraryProber(5_000);
		probers.push(prober);

		for (let i = 0; i < 200; i++) {
			const which = i % 4;
			if (which === 0) {
				const r = await prober.lstat(path.join(dir, 'good.mkv'));
				expect(r.kind).toBe('symlink');
			} else if (which === 1) {
				expect(await prober.resolve(path.join(dir, 'real.txt'))).toBe('exists');
			} else if (which === 2) {
				expect(await prober.resolve(path.join(dir, 'dangling.mkv'))).toBe('missing');
			} else {
				expect(await prober.mountHealthy(dir)).toBe(true);
			}
		}

		// One persistent worker (plus libuv pool headroom) — never one per op.
		const live = await waitForThreadsAtMost(baseline, 6, 5_000);
		expect(live! - baseline).toBeLessThanOrEqual(6);
	});

	it('dispose() reclaims the worker — no idle isolate left behind', async () => {
		const baseline = liveThreads()!;
		const dir = makeTree();
		const prober = new WorkerLibraryProber(5_000);
		expect(await prober.mountHealthy(dir)).toBe(true);

		prober.dispose();
		const live = await waitForThreadsAtMost(baseline, 3, 10_000);
		expect(live! - baseline).toBeLessThanOrEqual(3);
	});

	it('probes against a missing mount answer honestly and stay bounded', async () => {
		const baseline = liveThreads()!;
		const prober = new WorkerLibraryProber(5_000);
		probers.push(prober);
		const missing = path.join(os.tmpdir(), 'dumbscope-does-not-exist', 'nope');

		for (let i = 0; i < 50; i++) {
			expect(await prober.resolve(missing)).toBe('missing');
			const v = await prober.mountVisibility(missing);
			expect(['missing', 'empty', 'error']).toContain(v);
		}

		const live = await waitForThreadsAtMost(baseline, 6, 5_000);
		expect(live! - baseline).toBeLessThanOrEqual(6);
	});
});
