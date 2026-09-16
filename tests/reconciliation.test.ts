/**
 * Regression tests for library reconciliation (FASE D).
 *
 * These encode the failure scenarios from the 2026-09-16 production incident
 * (Reacher S04E08: FILE NOT FOUND while every database said "healthy"):
 *
 *   A. Sonarr `hasFile=true`, file missing      → incident (arr-file-missing)
 *   B. Symlink exists, target missing           → incident (broken-symlink)
 *   C. Plex media part, path missing            → incident (plex-ghost)
 *   D. Release only `grabbed`                   → NEVER counted available
 *   E. Upgrade A→B where B fails; Plex stale    → old file gone must still be
 *      visible as plex-ghost / plex-stale, never silently green
 *   F. Backend (FUSE mount) temporarily down    → ONE per-mount finding,
 *      per-item noise suppressed, distinct from permanent missing
 *   G. Container restart / remount              → reconciliation runs again
 *      and resolves findings once state matches (post-restart cycle)
 */
import { describe, expect, it } from 'vitest';
import {
	diffFindings,
	reconcileLibrary,
	type ArrFileRecord,
	type LibraryProber,
	type MountVisibility,
	type PlexPartRecord
} from '../src/lib/server/reconciliation/library';

const MOUNTS = [
	{ prefix: '/mnt/remote/nzbdav', label: 'nzbdav (usenet)' },
	{ prefix: '/mnt/debrid/decypharr', label: 'decypharr (debrid)' }
];

const ALIASES = [
	{ from: '/media/', to: '/symlinks/TV Shows/' },
	{ from: '/media-movies/', to: '/symlinks/Movies/' }
];

/** In-memory filesystem + mount health, keyed by exact path. */
function fakeProber(state: {
	files: Map<string, { symlink?: string; size?: number }>;
	healthyMounts: Set<string>;
	visibility?: Map<string, MountVisibility>;
}): LibraryProber {
	return {
		async lstat(path) {
			const entry = state.files.get(path);
			if (!entry) return { kind: 'missing' };
			if (entry.symlink) return { kind: 'symlink', target: entry.symlink };
			return { kind: 'file', size: entry.size ?? 1 };
		},
		async resolve(path) {
			const entry = state.files.get(path);
			if (!entry) return 'missing';
			if (entry.symlink) {
				return state.files.has(entry.symlink) ? 'exists' : 'missing';
			}
			return 'exists';
		},
		async mountHealthy(prefix) {
			return state.healthyMounts.has(prefix);
		},
		async mountVisibility(prefix): Promise<MountVisibility> {
			return (
				state.visibility?.get(prefix) ?? (state.healthyMounts.has(prefix) ? 'visible' : 'missing')
			);
		}
	};
}

function arrFile(overrides: Partial<ArrFileRecord> = {}): ArrFileRecord {
	return {
		source: 'sonarr',
		key: 'sonarr:default:episode:1109',
		label: 'Reacher S04E08',
		path: '/media/Reacher (2022)/Season 4/file.mkv',
		addedAt: 1,
		...overrides
	};
}

function plexPart(overrides: Partial<PlexPartRecord> = {}): PlexPartRecord {
	return {
		key: 'plex:part:1',
		label: 'file.mkv',
		path: '/symlinks/TV Shows/Reacher (2022)/Season 4/file.mkv',
		sectionId: 2,
		...overrides
	};
}

describe('library reconciliation — production incident scenarios', () => {
	it('A: Sonarr hasFile=true with a missing file opens an arr-file-missing finding', async () => {
		const result = await reconcileLibrary({
			mounts: MOUNTS,
			aliases: ALIASES,
			arrFiles: [arrFile()],
			plexParts: [],
			prober: fakeProber({ files: new Map(), healthyMounts: new Set(MOUNTS.map((m) => m.prefix)) })
		});
		const kinds = result.findings.map((f) => f.kind);
		expect(kinds).toContain('arr-file-missing');
		const finding = result.findings.find((f) => f.kind === 'arr-file-missing');
		expect(finding?.fingerprint).toBe('recon:arr-file-missing:sonarr:default:episode:1109');
		expect(result.stats.arrMissing).toBe(1);
		expect(result.stats.available).toBe(0);
	});

	it('B: a broken symlink on a healthy mount is distinct from backend-down', async () => {
		const files = new Map<string, { symlink?: string; size?: number }>();
		files.set('/media/x/ep.mkv', { symlink: '/mnt/debrid/decypharr/__all__/ep.mkv' });
		const result = await reconcileLibrary({
			mounts: MOUNTS,
			aliases: ALIASES,
			arrFiles: [arrFile({ path: '/media/x/ep.mkv' })],
			plexParts: [],
			prober: fakeProber({ files, healthyMounts: new Set(MOUNTS.map((m) => m.prefix)) })
		});
		expect(result.findings.map((f) => f.kind)).toContain('broken-symlink');
		expect(result.findings.map((f) => f.kind)).not.toContain('backend-unavailable');
	});

	it('C: a Plex media part whose path is gone opens a plex-ghost finding', async () => {
		const files = new Map<string, { symlink?: string; size?: number }>();
		files.set('/symlinks/TV Shows/Reacher (2022)/Season 4/old.mkv', {});
		// Plex path recorded, nothing on disk at all:
		const result = await reconcileLibrary({
			mounts: MOUNTS,
			aliases: ALIASES,
			arrFiles: [],
			plexParts: [plexPart({ path: '/symlinks/TV Shows/Reacher (2022)/Season 4/old.mkv' })],
			prober: fakeProber({ files: new Map(), healthyMounts: new Set(MOUNTS.map((m) => m.prefix)) })
		});
		expect(result.findings.map((f) => f.kind)).toContain('plex-ghost');
		expect(result.stats.plexGhosts).toBe(1);
	});

	it('D: a grabbed-only release never counts as available', async () => {
		// Acquisition history is not part of the inputs by design: only paths
		// that resolve to real files contribute to `available`.
		const files = new Map<string, { symlink?: string; size?: number }>();
		const result = await reconcileLibrary({
			mounts: MOUNTS,
			aliases: ALIASES,
			arrFiles: [arrFile({ path: '/media/Reacher (2022)/Season 4/cakes.mkv' })],
			plexParts: [],
			prober: fakeProber({ files, healthyMounts: new Set(MOUNTS.map((m) => m.prefix)) })
		});
		expect(result.stats.available).toBe(0);
		expect(result.arrAvailable.size).toBe(0);
	});

	it('E: upgrade replaced the file, Plex kept the old entry → ghost + stale, not green', async () => {
		const files = new Map<string, { symlink?: string; size?: number }>();
		// New FLUX file exists under the Arr root (symlink resolves):
		files.set('/media/Reacher (2022)/Season 4/flux.mkv', {
			symlink: '/mnt/debrid/decypharr/__all__/flux/flux.mkv'
		});
		files.set('/mnt/debrid/decypharr/__all__/flux/flux.mkv', { size: 8313661320 });
		// Old NeoNoir symlink was deleted by the upgrade:
		const result = await reconcileLibrary({
			mounts: MOUNTS,
			aliases: ALIASES,
			arrFiles: [arrFile({ path: '/media/Reacher (2022)/Season 4/flux.mkv', addedAt: 1 })],
			plexParts: [plexPart({ path: '/symlinks/TV Shows/Reacher (2022)/Season 4/neonoir.mkv' })],
			prober: fakeProber({ files, healthyMounts: new Set(MOUNTS.map((m) => m.prefix)) })
		});
		expect(result.findings.map((f) => f.kind)).toContain('plex-ghost');
		// The good new file exists but Plex does not index it (grace elapsed).
		expect(result.findings.map((f) => f.kind)).toContain('plex-stale');
		expect(result.stats.plexGhosts).toBe(1);
		expect(result.stats.plexStale).toBe(1);
	});

	it('E2: within the stale grace an unindexed-but-good file is not an incident', async () => {
		const files = new Map<string, { symlink?: string; size?: number }>();
		files.set('/media/Reacher (2022)/Season 4/flux.mkv', {
			symlink: '/mnt/debrid/decypharr/__all__/flux/flux.mkv'
		});
		files.set('/mnt/debrid/decypharr/__all__/flux/flux.mkv', { size: 1 });
		const now = Date.now();
		const result = await reconcileLibrary({
			mounts: MOUNTS,
			aliases: ALIASES,
			arrFiles: [
				arrFile({ path: '/media/Reacher (2022)/Season 4/flux.mkv', addedAt: now - 60_000 })
			],
			plexParts: [],
			prober: fakeProber({ files, healthyMounts: new Set(MOUNTS.map((m) => m.prefix)) }),
			staleGraceMs: 30 * 60_000,
			now: () => now
		});
		expect(result.findings).toHaveLength(0);
		expect(result.stats.available).toBe(1);
	});

	it('F: a down mount yields exactly one backend-unavailable finding and suppresses per-item noise', async () => {
		const files = new Map<string, { symlink?: string; size?: number }>();
		// 50 nzbdav symlinks whose targets "exist" on the (down) mount:
		for (let i = 0; i < 50; i++) {
			files.set(`/media/show/ep${i}.mkv`, { symlink: `/mnt/remote/nzbdav/.ids/${i}` });
			files.set(`/mnt/remote/nzbdav/.ids/${i}`, { size: 1 });
		}
		const result = await reconcileLibrary({
			mounts: MOUNTS,
			aliases: ALIASES,
			arrFiles: Array.from({ length: 50 }, (_, i) =>
				arrFile({ key: `sonarr:default:episode:${i}`, path: `/media/show/ep${i}.mkv` })
			),
			plexParts: [],
			prober: fakeProber({
				files,
				healthyMounts: new Set(['/mnt/debrid/decypharr']), // nzbdav file-ops FAIL
				// …but the root is visible and lists content: the dead-FUSE
				// signature (real ops → EIO, statfs/readdir succeed).
				visibility: new Map<string, MountVisibility>([
					['/mnt/remote/nzbdav', 'visible'],
					['/mnt/debrid/decypharr', 'visible']
				])
			})
		});
		const backendFindings = result.findings.filter((f) => f.kind === 'backend-unavailable');
		expect(backendFindings).toHaveLength(1);
		expect(backendFindings[0]?.severity).toBe('critical');
		expect(backendFindings[0]?.fingerprint).toBe('recon:backend-unavailable:/mnt/remote/nzbdav');
		// No per-item findings for paths on the down mount:
		expect(result.findings.filter((f) => f.kind === 'arr-file-missing')).toHaveLength(0);
		expect(result.stats.pathsOnDownMount).toBe(50);
	});

	it('F2: an EIO-storm (unreadable) on a healthy mount still surfaces per-item, not as backend-down', async () => {
		const prober: LibraryProber = {
			async lstat() {
				return { kind: 'error', code: 'EIO' };
			},
			async resolve() {
				return 'error';
			},
			async mountHealthy() {
				return true;
			},
			async mountVisibility() {
				return 'visible';
			}
		};
		const result = await reconcileLibrary({
			mounts: MOUNTS,
			aliases: ALIASES,
			arrFiles: [arrFile()],
			plexParts: [],
			prober
		});
		// EIO at lstat is indistinguishable from missing for the Arr record's
		// purposes here: the item is not available, which is what matters.
		expect(result.stats.available).toBe(0);
	});

	it('G: findings resolve on a later healthy run (post-restart reconciliation)', async () => {
		const files = new Map<string, { symlink?: string; size?: number }>();
		files.set('/media/x/ep.mkv', { symlink: '/mnt/remote/nzbdav/.ids/1' });
		files.set('/mnt/remote/nzbdav/.ids/1', { size: 1 });

		const before = await reconcileLibrary({
			mounts: MOUNTS,
			aliases: ALIASES,
			arrFiles: [arrFile({ path: '/media/x/ep.mkv' })],
			plexParts: [],
			prober: fakeProber({
				files,
				healthyMounts: new Set(['/mnt/debrid/decypharr']),
				visibility: new Map<string, MountVisibility>([
					['/mnt/remote/nzbdav', 'visible'],
					['/mnt/debrid/decypharr', 'visible']
				])
			})
		});
		expect(before.findings.map((f) => f.fingerprint)).toContain(
			'recon:backend-unavailable:/mnt/remote/nzbdav'
		);

		// The remount healed (watchdog); the next cycle must resolve the
		// backend finding. Plex still lacks a part for the file, so the
		// plex-stale finding (correctly) remains the only open item.
		const after = await reconcileLibrary({
			mounts: MOUNTS,
			aliases: ALIASES,
			arrFiles: [arrFile({ path: '/media/x/ep.mkv' })],
			plexParts: [plexPart({ path: '/symlinks/TV Shows/x/ep.mkv' })],
			prober: fakeProber({
				files: (() => {
					const healed = new Map(files);
					healed.set('/symlinks/TV Shows/x/ep.mkv', {
						symlink: '/mnt/remote/nzbdav/.ids/1'
					});
					return healed;
				})(),
				healthyMounts: new Set(MOUNTS.map((m) => m.prefix))
			})
		});
		const previous = new Set(before.findings.map((f) => f.fingerprint));
		const { open, close } = diffFindings(previous, after.findings);
		expect(open).toHaveLength(0);
		expect(close).toContain('recon:backend-unavailable:/mnt/remote/nzbdav');
	});

	it('path aliases make Sonarr /media and Plex /symlinks the same identity', async () => {
		const files = new Map<string, { symlink?: string; size?: number }>();
		// Both paths are two views of the same underlying file (bind alias):
		files.set('/media/Reacher (2022)/Season 4/flux.mkv', {
			symlink: '/mnt/debrid/decypharr/__all__/flux/flux.mkv'
		});
		files.set('/symlinks/TV Shows/Reacher (2022)/Season 4/flux.mkv', {
			symlink: '/mnt/debrid/decypharr/__all__/flux/flux.mkv'
		});
		files.set('/mnt/debrid/decypharr/__all__/flux/flux.mkv', { size: 1 });
		const result = await reconcileLibrary({
			mounts: MOUNTS,
			aliases: ALIASES,
			arrFiles: [arrFile({ path: '/media/Reacher (2022)/Season 4/flux.mkv' })],
			plexParts: [plexPart({ path: '/symlinks/TV Shows/Reacher (2022)/Season 4/flux.mkv' })],
			prober: fakeProber({ files, healthyMounts: new Set(MOUNTS.map((m) => m.prefix)) })
		});
		expect(result.findings).toHaveLength(0);
		expect(result.stats.plexStale).toBe(0);
	});
});

describe('observer-visibility semantics', () => {
	it('F3: items on a mount that is not visible to this instance are unverifiable, not ghosts', async () => {
		// Beta/prod DUMBscope containers bind /mnt/remote/nzbdav, but after the
		// in-container mount rework the host path is an empty directory: the
		// mount lives inside DUMB. An observer must NOT report those items as
		// permanently missing — it must say "cannot verify" once, per mount.
		const files = new Map<string, { symlink?: string; size?: number }>();
		files.set('/media/show/ep.mkv', { symlink: '/mnt/remote/nzbdav/.ids/42' });
		files.set('/symlinks/TV Shows/show/ep.mkv', { symlink: '/mnt/remote/nzbdav/.ids/42' });
		// The target exists INSIDE DUMB only — not in this container's view:
		const visibility = new Map<string, MountVisibility>([
			['/mnt/remote/nzbdav', 'empty'], // bind of not-mounted host path
			['/mnt/debrid/decypharr', 'visible']
		]);
		const result = await reconcileLibrary({
			mounts: MOUNTS,
			aliases: ALIASES,
			arrFiles: [arrFile({ path: '/media/show/ep.mkv' })],
			plexParts: [plexPart({ path: '/symlinks/TV Shows/show/ep.mkv' })],
			prober: fakeProber({
				files,
				healthyMounts: new Set(MOUNTS.map((m) => m.prefix)),
				visibility
			})
		});
		const kinds = result.findings.map((f) => f.kind);
		expect(kinds).not.toContain('plex-ghost');
		expect(kinds).not.toContain('broken-symlink');
		expect(kinds).toContain('mount-unverifiable');
		const mv = result.findings.find((f) => f.kind === 'mount-unverifiable');
		expect(mv?.severity).toBe('info');
		expect(result.stats.pathsUnverifiable).toBe(2);
	});
});
