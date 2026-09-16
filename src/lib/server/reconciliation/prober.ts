/**
 * Filesystem prober for library reconciliation — production implementation of
 * `LibraryProber`.
 *
 * Same rules as reliability/fsprobe.ts: FUSE mounts can hang *in syscall*, so
 * every probe runs in a disposable worker with a hard deadline; the poller
 * never blocks. Strictly read-only.
 *
 * The mount probe deliberately performs a real directory READ (readdir), not
 * a statfs: on a dead FUSE connection the kernel happily answers statfs while
 * every file operation returns EIO (production finding 2026-09-16). Probing
 * the root directory is the cheapest honest signal.
 */
import { Worker } from 'node:worker_threads';
import type { FsKind, LibraryProber, MountVisibility } from './library';

const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const fsp = fs.promises;

parentPort.on('message', async (msg) => {
	const results = [];
	for (const op of msg.ops || []) {
		try {
			if (op.op === 'lstat') {
				const st = await fsp.lstat(op.path);
				if (st.isSymbolicLink()) {
					let target = null;
					try { target = await fsp.readlink(op.path); } catch {}
					results.push({ kind: 'symlink', target });
				} else {
					results.push({ kind: 'file', size: st.size });
				}
			} else if (op.op === 'resolve') {
				const st = await fsp.stat(op.path);
				results.push({ ok: true, size: st.size });
			} else if (op.op === 'mount') {
				// Real read: readdir on the mount root. statfs lies on dead FUSE.
				await fsp.readdir(op.path);
				results.push({ ok: true });
			} else if (op.op === 'visibility') {
				// An empty root is the signature of a bind of a not-yet-mounted
				// host path; a live FUSE mount root lists content.
				try {
					const entries = await fsp.readdir(op.path);
					results.push({ visible: entries.length > 0 ? 'visible' : 'empty' });
				} catch (verr) {
					results.push({ visible: verr && verr.code === 'ENOENT' ? 'missing' : 'error' });
				}
			}
		} catch (err) {
			if (op.op === 'lstat') {
				results.push({ kind: err && err.code === 'ENOENT' ? 'missing' : 'error', code: err && err.code });
			} else if (op.op === 'resolve') {
				results.push({ ok: false, missing: !!err && err.code === 'ENOENT', code: err && err.code });
			} else {
				results.push({ ok: false, code: err && err.code });
			}
		}
	}
	parentPort.postMessage({ id: msg.id, results });
});
`;

interface Pending {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	timer: NodeJS.Timeout;
}

export class WorkerLibraryProber implements LibraryProber {
	private worker: Worker | null = null;
	private seq = 0;
	private pending = new Map<number, Pending>();

	constructor(private readonly opTimeoutMs = 8_000) {}

	private ensureWorker(): Worker {
		if (this.worker) return this.worker;
		const worker = new Worker(WORKER_SOURCE, { eval: true });
		worker.on('message', (msg: { id: number; results: unknown[] }) => {
			const entry = this.pending.get(msg.id);
			if (!entry) return;
			this.pending.delete(msg.id);
			clearTimeout(entry.timer);
			entry.resolve(msg.results[0]);
		});
		const kill = () => {
			const w = this.worker;
			this.worker = null;
			this.pending.clear();
			if (w) void w.terminate();
		};
		worker.on('error', kill);
		worker.on('exit', kill);
		this.worker = worker;
		return worker;
	}

	private run<T>(op: Record<string, unknown>): Promise<T> {
		const worker = this.ensureWorker();
		const id = ++this.seq;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				// A hung op poisons the worker: terminate and leak no handles.
				const w = this.worker;
				this.worker = null;
				if (w) void w.terminate();
				reject(new Error(`probe timeout after ${this.opTimeoutMs}ms`));
			}, this.opTimeoutMs);
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
			worker.postMessage({ id, ops: [op] });
		});
	}

	async lstat(
		path: string
	): Promise<{ kind: FsKind; target?: string; size?: number; code?: string }> {
		try {
			return await this.run<{ kind: FsKind; target?: string; size?: number; code?: string }>({
				op: 'lstat',
				path
			});
		} catch {
			return { kind: 'error', code: 'TIMEOUT' };
		}
	}

	async resolve(path: string): Promise<'exists' | 'missing' | 'error'> {
		try {
			const r = await this.run<{ ok: boolean; missing?: boolean; code?: string }>({
				op: 'resolve',
				path
			});
			if (r.ok) return 'exists';
			return r.missing ? 'missing' : 'error';
		} catch {
			return 'error';
		}
	}

	async mountHealthy(prefix: string): Promise<boolean> {
		try {
			const r = await this.run<{ ok: boolean }>({ op: 'mount', path: prefix });
			return r.ok;
		} catch {
			return false;
		}
	}

	async mountVisibility(prefix: string): Promise<MountVisibility> {
		try {
			const r = await this.run<{ visible: MountVisibility }>({ op: 'visibility', path: prefix });
			return r.visible;
		} catch {
			return 'error';
		}
	}

	dispose(): void {
		const w = this.worker;
		this.worker = null;
		this.pending.clear();
		if (w) void w.terminate();
	}
}
