/**
 * Regression: symlink sampling must not judge targets it cannot resolve
 * because their mount lives in another container's namespace.
 *
 * Production case (2026-09-25): the TV/Movies symlink roots point at
 * /mnt/remote/nzbdav/.ids/… — the usenet rclone mount lives ONLY inside the
 * DUMB container. The DUMBscope container has no /mnt/remote, so every
 * sampled link was ENOENT and reported as broken (23/24, 20/24) → permanent
 * systemic warnings for healthy libraries. The namespace guard now classifies
 * ENOENT whose first missing directory lies OUTSIDE the walked tree as
 * unresolvable; unresolvable links are not conclusive evidence (not counted
 * in `sampled`) and existing findings resolve via the clean-round hysteresis.
 *
 * Uses the REAL worker (same eval'd WORKER_SOURCE as production) and the REAL
 * incident engine — no mocks.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProbeRound } from '../src/lib/server/reliability/fsprobe';
import { MountMonitor } from '../src/lib/server/reliability/mounts';
import { IncidentEngine } from '../src/lib/server/incidents/engine';
import { Fingerprints } from '../src/lib/server/incidents/fingerprint';

let root: string;
let walkRoot: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-ns-'));
	walkRoot = path.join(root, 'library', 'TV Shows');
	fs.mkdirSync(walkRoot, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function makeLink(name: string, target: string): void {
	fs.symlinkSync(target, path.join(walkRoot, name));
}

async function sample(): Promise<{
	sampled: number;
	valid: number;
	broken: number;
	unreadable: number;
	unresolvable: number;
}> {
	const round = await runProbeRound(
		[
			{ op: 'stat', path: walkRoot },
			{ op: 'list', path: walkRoot, entryBudget: 400, depth: 1, linkSampleCap: 8 }
		],
		30_000
	);
	const list = round.results[1] as {
		ok: boolean;
		sample: { sampled: number; valid: number; broken: number; unreadable: number; unresolvable: number } | null;
	};
	if (!list.ok || !list.sample) throw new Error('list probe failed');
	return list.sample;
}

describe('symlink sampling namespace guard', () => {
	it('target behind a mount absent from this container is unresolvable, not broken', async () => {
		makeLink('a.mkv', '/definitely-absent-namespace-root/xyz/movie.mkv');
		const s = await sample();
		expect(s.unresolvable).toBeGreaterThanOrEqual(1);
		expect(s.broken).toBe(0);
		expect(s.sampled).toBe(0); // unresolvable links are not conclusive evidence
	});

	it('target missing inside the walked tree is conclusive broken', async () => {
		const real = path.join(walkRoot, 'present.mkv');
		makeLink('b.mkv', real);
		fs.rmSync(real, { force: true }); // target was removed: genuinely broken
		const s = await sample();
		expect(s.broken).toBeGreaterThanOrEqual(1);
		expect(s.sampled).toBeGreaterThanOrEqual(1);
		expect(s.unresolvable).toBe(0);
	});

	it('valid target resolves', async () => {
		const real = path.join(walkRoot, 'real.mkv');
		fs.writeFileSync(real, 'x');
		makeLink('c.mkv', real);
		const s = await sample();
		expect(s.valid).toBe(1);
		expect(s.broken).toBe(0);
		expect(s.unresolvable).toBe(0);
	});
});

describe('incident engine with unresolvable-only samples', () => {
	const target = {
		id: 'tv',
		label: 'TV symlink root',
		path: '/mnt/media/tv',
		kind: 'symlink-root' as const,
		consumers: ['Plex Media Server']
	};
	const fp = Fingerprints.symlinksBroken(target.path);

	function makeMonitor(): MountMonitor {
		return new MountMonitor({ targets: [target], roundIntervalMs: 0 });
	}

	function applySample(
		engine: IncidentEngine,
		monitor: MountMonitor,
		sample: {
			sampled: number;
			valid: number;
			broken: number;
			unreadable: number;
			unresolvable: number;
			entriesScanned: number;
			truncated: boolean;
		}
	): void {
		// Shape the report exactly the way a real healthy-stat round would (the
		// mount root itself is fine — only the symlink targets are in question).
		const monitorInternal = monitor as unknown as {
			targets: Map<string, { report: { symlink: unknown; state: string; statLatencyMs: number | null } }>;
		};
		const report = monitorInternal.targets.get(target.id)!.report;
		report.state = 'healthy';
		report.statLatencyMs = 5;
		report.symlink = sample;
		engine.onMountHealth(monitor.getReports());
	}

	it('unresolvable-only samples never open the systemic finding and resolve it', () => {
		const engine = new IncidentEngine({}, () => Date.now());
		const monitor = makeMonitor();
		// pre-open the finding the way the pre-fix build would have
		applySample(engine, monitor, {
			sampled: 24, valid: 0, broken: 24, unreadable: 0, unresolvable: 0,
			entriesScanned: 400, truncated: false
		});
		expect(engine.getActive().some((r) => r.fingerprint === fp && r.status === 'active')).toBe(true);

		// post-fix reality: the same library samples as fully unresolvable
		const unresolvableSample = {
			sampled: 0, valid: 0, broken: 0, unreadable: 0, unresolvable: 24,
			entriesScanned: 400, truncated: false
		};
		applySample(engine, monitor, unresolvableSample);
		applySample(engine, monitor, unresolvableSample); // second clean round
		const finding = engine.getActive().find((r) => r.fingerprint === fp);
		expect(finding).toBeUndefined();
	});

	it('hydration safety net: finding of a removed target resolves as obsolete', () => {
		const engine = new IncidentEngine({}, () => Date.now());
		const monitor = makeMonitor();
		// pre-open the finding (old target still configured at the time)
		applySample(engine, monitor, {
			sampled: 24, valid: 0, broken: 24, unreadable: 0, unresolvable: 0,
			entriesScanned: 400, truncated: false
		});
		expect(engine.getActive().some((r) => r.fingerprint === fp && r.status === 'active')).toBe(true);

		// the target is now removed from the monitor list: its fingerprint is
		// no longer produced, and a restarted process has no identity for it —
		// exactly the state the hydration safety net must clean up.
		const known = new Set<string>([
			Fingerprints.mountUnhealthy(target.path),
			Fingerprints.symlinksBroken(target.path),
			Fingerprints.mountUnhealthy('/mnt/debrid/decypharr'),
			Fingerprints.symlinksBroken('/mnt/vm_storage/symlinks/Movies')
		]);
		const retired = engine.resolveMountFindingsExcept(
			new Set([...known].filter((f) => f !== fp)),
			Date.now()
		);
		expect(retired).toBe(1);
		expect(engine.getActive().some((r) => r.fingerprint === fp)).toBe(false);
	});
});
