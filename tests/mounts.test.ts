/**
 * FASE B — read-only mount health (real filesystem).
 *
 * End-to-end checks for the probe worker: stat, bounded listing, symlink
 * sampling against a real temporary directory tree, and the monitor's
 * `missing` derivation on a genuinely absent path.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProbeRound } from '../src/lib/server/reliability/fsprobe';
import { MountMonitor } from '../src/lib/server/reliability/mounts';
import type { MountTarget } from '$lib/types';

function makeSymlinkTree(): { root: string; broken: number; valid: number } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-mounts-'));
	// 3 shows × 2 seasons × 4 links = 24 links; ~5/6 point at stale targets.
	let broken = 0;
	let valid = 0;
	for (let show = 0; show < 3; show++) {
		for (let season = 0; season < 2; season++) {
			const dir = path.join(root, `Show ${show}`, `Season ${season}`);
			fs.mkdirSync(dir, { recursive: true });
			for (let link = 0; link < 4; link++) {
				const name = `episode.${show}.${season}.${link}.mkv`;
				const stale = (show + season + link) % 6 !== 0;
				const target = stale
					? `/nonexistent/debrid/${show}/${season}/${link}`
					: path.join(root, 'real-target.txt');
				if (stale) broken++;
				else valid++;
				fs.symlinkSync(target, path.join(dir, name));
			}
		}
	}
	fs.writeFileSync(path.join(root, 'real-target.txt'), 'x');
	return { root, broken, valid };
}

describe('fsprobe worker (real filesystem)', () => {
	it('stats an existing path with latency', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-fsprobe-'));
		const round = await runProbeRound([{ op: 'stat', path: dir }], 10_000);
		expect(round.timedOut).toBe(false);
		expect(round.results[0]).toMatchObject({ ok: true });
		expect(round.results[0]?.latencyMs).toBeGreaterThanOrEqual(0);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('reports ENOENT for a missing path without throwing', async () => {
		const round = await runProbeRound(
			[{ op: 'stat', path: '/nonexistent/dumbscope/definitely-missing' }],
			10_000
		);
		expect(round.results[0]).toMatchObject({ ok: false, code: 'ENOENT' });
	});

	it('walks a bounded tree and samples symlinks with valid/broken counts', async () => {
		const tree = makeSymlinkTree();
		const round = await runProbeRound(
			[{ op: 'list', path: tree.root, entryBudget: 400, depth: 3, linkSampleCap: 24 }],
			15_000
		);
		const list = round.results[0];
		expect(list?.ok).toBe(true);
		const sample = list?.sample;
		expect(sample).toBeDefined();
		expect(sample?.sampled).toBeLessThanOrEqual(24);
		expect(sample?.sampled).toBeGreaterThan(0);
		expect(sample!.valid + sample!.broken + sample!.unreadable).toBe(sample?.sampled);
		expect(sample!.broken).toBeGreaterThan(0); // stale targets detected
		expect(sample!.valid).toBeGreaterThan(0); // real targets resolve
		expect(list?.entriesScanned).toBeLessThanOrEqual(400);
		fs.rmSync(tree.root, { recursive: true, force: true });
	});

	it('honours the entry budget (never a full walk)', async () => {
		const tree = makeSymlinkTree();
		const round = await runProbeRound(
			[{ op: 'list', path: tree.root, entryBudget: 10, depth: 3, linkSampleCap: 24 }],
			15_000
		);
		expect(round.results[0]?.entriesScanned).toBeLessThanOrEqual(10);
		expect(round.results[0]?.truncated).toBe(true);
		fs.rmSync(tree.root, { recursive: true, force: true });
	});
});

describe('MountMonitor against a real path', () => {
	const ctx = { runningProcesses: new Set<string>() };

	it('reports healthy for a real readable directory', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dumbscope-mount-live-'));
		const target: MountTarget = {
			id: 'tv',
			label: 'TV symlink root',
			path: root,
			kind: 'symlink-root',
			consumers: []
		};
		const monitor = new MountMonitor({ targets: [target], roundIntervalMs: 0 });
		await monitor.tick(ctx);
		const report = monitor.getReports()[0]!;
		expect(report.state).toBe('healthy');
		expect(report.statLatencyMs).not.toBeNull();
		expect(report.lastSuccessAt).not.toBeNull();
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('requires two rounds before declaring a path missing', async () => {
		const target: MountTarget = {
			id: 'gone',
			label: 'Missing mount',
			path: '/nonexistent/dumbscope/mount-check',
			kind: 'local',
			consumers: []
		};
		const monitor = new MountMonitor({ targets: [target], roundIntervalMs: 0 });
		await monitor.tick(ctx);
		expect(monitor.getReports()[0]!.state).toBe('unknown');
		await monitor.tick(ctx);
		expect(monitor.getReports()[0]!.state).toBe('missing');
		expect(monitor.getReports()[0]!.lastError).toContain('does not exist');
	});
});
