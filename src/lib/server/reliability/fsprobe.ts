/**
 * Read-only filesystem probes with hard timeouts, run inside worker threads.
 *
 * FUSE mounts (rclone/debrid views) can hang *in syscall* when a remote is
 * sick — a plain `fs.stat` from the poller would then block the libuv thread
 * pool indefinitely and take the whole poller down with it (brief §45). Every
 * probe here therefore runs in a disposable worker that is *terminated* when
 * its deadline passes, so the monitor only ever loses the probe, never the
 * thread.
 *
 * Strictly read-only: stat / lstat / bounded readdir. Nothing in this module
 * writes, links, unlinks or walks a full library (brief §16/§19).
 */
import { Worker } from 'node:worker_threads';

/** Probe tasks understood by the worker. */
export interface StatProbe {
	op: 'stat';
	path: string;
}

export interface ListProbe {
	op: 'list';
	path: string;
	/** Total directory entries the bounded walk may look at. */
	entryBudget: number;
	/** Walk depth for the bounded BFS (symlink roots nest shows/seasons). */
	depth: number;
	/** Sample at most this many symlinks encountered on the walk. */
	linkSampleCap: number;
}

export type FsProbe = StatProbe | ListProbe;

export interface ProbeOpResult {
	ok: boolean;
	latencyMs?: number;
	/** errno-style code ('ENOENT', 'EACCES', 'EIO', 'TIMEOUT', …). */
	code?: string;
	message?: string;
	entriesScanned?: number;
	truncated?: boolean;
	sample?: {
		sampled: number;
		valid: number;
		broken: number;
		unreadable: number;
		entriesScanned: number;
		truncated: boolean;
	} | null;
}

export interface ProbeRoundResult {
	results: ProbeOpResult[];
	/** True when the worker was terminated because a probe overran its deadline. */
	timedOut: boolean;
	/** Wall-clock duration of the whole round (including worker startup). */
	durationMs: number;
}

/**
 * The worker source is inlined as a string so server-side bundling can never
 * lose a worker file. It runs as CommonJS, executes the ops sequentially and
 * posts one result per op; first failure aborts the remaining ops. A hung op
 * simply never replies — the parent terminates the worker at the deadline.
 */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = fs.promises;
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

async function listDir(path, entryBudget, depth, linkSampleCap) {
	const t0 = process.hrtime.bigint();
	const links = [];
	let scanned = 0;
	let truncated = false;
	let queue = [{ path, level: 0 }];
	while (queue.length > 0) {
		if (scanned >= entryBudget) { truncated = true; break; }
		const dir = queue.shift();
		let entries;
		try {
			entries = await fsp.readdir(dir.path, { withFileTypes: true });
		} catch (err) {
			if (dir.level === 0) throw err;
			continue; // unreadable subdirectory: skip it, keep the walk bounded
		}
		for (const entry of entries) {
			if (scanned >= entryBudget) { truncated = true; break; }
			scanned++;
			const full = dir.path + '/' + entry.name;
			if (entry.isSymbolicLink()) links.push(full);
			else if (entry.isDirectory() && dir.level < depth) queue.push({ path: full, level: dir.level + 1 });
		}
	}
	// Deterministic spread across the found links, hard-capped.
	const stride = links.length > linkSampleCap ? Math.floor(links.length / linkSampleCap) : 1;
	const picked = [];
	for (let i = 0; i < links.length && picked.length < linkSampleCap; i += stride) picked.push(links[i]);
	const sample = { sampled: 0, valid: 0, broken: 0, unreadable: 0, entriesScanned: scanned, truncated };
	for (const link of picked) {
		try { await fsp.lstat(link); } catch { sample.unreadable++; continue; }
		try { await fsp.stat(link); sample.valid++; }
		catch (err) { if (err && err.code === 'ENOENT') sample.broken++; else sample.unreadable++; }
		sample.sampled++;
	}
	return { ok: true, latencyMs: ms(t0), entriesScanned: scanned, truncated, sample };
}

parentPort.on('message', async (msg) => {
	const results = [];
	for (const op of msg.ops || []) {
		try {
			if (op.op === 'stat') {
				const t0 = process.hrtime.bigint();
				await fsp.stat(op.path);
				results.push({ ok: true, latencyMs: ms(t0) });
			} else if (op.op === 'list') {
				results.push(await listDir(op.path, op.entryBudget, op.depth, op.linkSampleCap));
			}
		} catch (err) {
			results.push({
				ok: false,
				code: (err && err.code) || 'error',
				message: (err && err.message) || String(err)
			});
			break;
		}
	}
	parentPort.postMessage({ results });
});
`;

let fsCalls = 0;

/** Worker lifecycle counters (self-monitoring): growth of `active` across
 *  rounds would be a thread leak — the reclaim-on-every-exit-path fix keeps
 *  it at zero between rounds, and the runtime monitor watches exactly that. */
let workersSpawned = 0;
let workersActive = 0;
let workersTerminated = 0;
let workersTimedOut = 0;

/** Total probe operations issued since process start (for the overhead report). */
export function fsProbeCallCount(): number {
	return fsCalls;
}

/** Worker lifecycle snapshot for the DUMBscope runtime panel. */
export function fsProbeWorkerStats(): {
	spawned: number;
	active: number;
	terminated: number;
	timedOut: number;
} {
	return {
		spawned: workersSpawned,
		active: workersActive,
		terminated: workersTerminated,
		timedOut: workersTimedOut
	};
}

/**
 * Run a probe round in a fresh worker. Resolves (never rejects): failures
 * become `{ ok: false }` results; a hung worker is terminated at the deadline
 * and the remaining ops are reported as timeouts.
 */
export function runProbeRound(ops: FsProbe[], timeoutMs: number): Promise<ProbeRoundResult> {
	const started = Date.now();
	fsCalls += ops.length;
	workersSpawned++;
	workersActive++;
	return new Promise((resolve) => {
		const results: ProbeOpResult[] = [];
		let settled = false;
		const finish = (result: Omit<ProbeRoundResult, 'durationMs'>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			workersActive = Math.max(0, workersActive - 1);
			if (result.timedOut) workersTimedOut++;
			// Reclaim the worker on EVERY exit path — success included. A
			// worker is single-use by design: leaving a completed round's
			// isolate alive leaks one idle thread (~8 MB RSS) per round, and
			// the mount monitor runs one round per mount per minute
			// (2026-09-17: 4 mounts → GBs per hour across both instances).
			workersTerminated++;
			void worker.terminate().catch(() => {
				// already gone
			});
			resolve({ ...result, durationMs: Date.now() - started });
		};
		const worker = new Worker(WORKER_SOURCE, { eval: true });
		const timer = setTimeout(() => {
			const remaining: ProbeOpResult[] = [];
			for (let i = results.length; i < ops.length; i++) {
				remaining.push({ ok: false, code: 'TIMEOUT', message: 'probe timed out' });
			}
			finish({ results: [...results, ...remaining], timedOut: true });
		}, timeoutMs);
		worker.on('message', (msg: { results: ProbeOpResult[] }) => {
			results.push(...(msg.results ?? []));
			finish({ results, timedOut: false });
		});
		worker.on('error', (err: NodeJS.ErrnoException) => {
			const code = err.code ?? 'error';
			const rest: ProbeOpResult[] = [{ ok: false, code, message: err.message }];
			for (let i = results.length + 1; i < ops.length; i++) {
				rest.push({ ok: false, code: 'SKIPPED', message: 'skipped after earlier failure' });
			}
			finish({ results: [...results, ...rest], timedOut: false });
		});
		worker.on('exit', () => {
			// Exit without a message means the worker died mid-round.
			if (results.length < ops.length) {
				const rest: ProbeOpResult[] = [];
				for (let i = results.length; i < ops.length; i++) {
					rest.push({ ok: false, code: 'error', message: 'probe worker exited early' });
				}
				finish({ results: [...results, ...rest], timedOut: false });
			}
		});
		worker.postMessage({ ops });
	});
}
