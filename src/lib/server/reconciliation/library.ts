/**
 * Library reconciliation (FASE D): deterministic, read-only verification that
 * what the Arrs and Plex *claim* is actually true on the filesystem.
 *
 * The production complaint (2026-09-16, Reacher S04E08): Sonarr reported
 * `hasFile=true`, Plex served a library entry, yet pressing Play yielded
 * FILE NOT FOUND. Root causes were two silent divergence classes the
 * existing signals could not see:
 *
 *  1. **Backend-down**: symlink targets on a sick FUSE mount answered EIO or
 *     hung — every stat "succeeds" on the mount root while every file I/O
 *     fails, so mount-root probes lie. Item state stayed green.
 *  2. **Replace-without-rescan**: an Arr upgrade deleted the old symlink and
 *     imported a new file, but Plex was never rescanned — the library kept a
 *     ghost part pointing at the deleted path.
 *
 * This module compares three sources of truth per media item —
 * Arr database records, the Plex library, and the real filesystem — and
 * classifies every divergence. `grabbed`/`imported` history is explicitly
 * NOT evidence of availability (the acquisition ledger already models that);
 * only a path that resolves to a readable file on a healthy mount counts.
 *
 * Rules the implementation enforces:
 * - **Read-only, always.** lstat / stat with hard deadlines in bounded
 *   workers; nothing is ever repaired here (see fsprobe.ts, brief §16).
 * - **A sick mount is one finding, not a storm.** While a mount probe fails,
 *   every path on that mount collapses into a single per-mount finding with
 *   counts; per-item findings are suppressed to avoid flooding (and to keep
 *   "temporary backend outage" distinct from "permanently missing media").
 * - **Path identity is mount-aware.** Arr paths (/media, /media-movies) and
 *   Plex paths (/symlinks/…) can name the same file through declared aliases;
 *   cross-comparing without normalising would drown real ghosts in noise.
 */
import type { IncidentSeverity } from '$lib/types';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type ArrSource = 'sonarr' | 'radarr';

export interface ArrFileRecord {
	source: ArrSource;
	/** Stable Arr identity, e.g. `sonarr:default:episode:1109`. */
	key: string;
	/** Display label for humans, e.g. `Reacher S04E08`. */
	label: string;
	path: string;
	size?: number | null;
	addedAt?: number | null;
}

export interface PlexPartRecord {
	/** Stable Plex identity, e.g. `plex:part:19737`. */
	key: string;
	label: string;
	path: string;
	sectionId: number | null;
	size?: number | null;
}

export interface MountTargetSpec {
	/** Absolute prefix under which symlink targets live, e.g. `/mnt/remote/nzbdav`. */
	prefix: string;
	label: string;
}

export interface PathAliasSpec {
	/** Rewrites `from`-prefixed paths onto `to` (both directions compared). */
	from: string;
	to: string;
}

export type FsKind = 'file' | 'symlink' | 'missing' | 'error';

/** Visibility of a mount root from this process's filesystem view. */
export type MountVisibility = 'missing' | 'empty' | 'visible' | 'error';

/** Filesystem probe contract — injectable so tests can simulate failures. */
export interface LibraryProber {
	lstat(path: string): Promise<{ kind: FsKind; target?: string; size?: number; code?: string }>;
	/** Fully resolve a path (follow symlinks). Must respect a hard deadline. */
	resolve(path: string): Promise<'exists' | 'missing' | 'error'>;
	/** True when a real file operation (not statfs!) succeeds on this mount. */
	mountHealthy(prefix: string): Promise<boolean>;
	/**
	 * Distinguish "mount not visible to us" from "mount present but target
	 * gone": a bind of a not-yet-mounted host path shows up as an EMPTY
	 * directory, while a healthy FUSE mount root lists content. Observers
	 * outside the container that owns the mount see 'missing' or 'empty' and
	 * must not report its items as permanently missing.
	 */
	mountVisibility(prefix: string): Promise<MountVisibility>;
}

export type ItemVerdict =
	| { status: 'available' }
	| { status: 'missing' }
	| { status: 'broken-symlink' }
	| { status: 'backend-down'; mount: string }
	| { status: 'unverifiable'; mount: string }
	| { status: 'unreadable'; mount: string; code?: string };

export interface ReconcileFinding {
	kind:
		| 'arr-file-missing'
		| 'broken-symlink'
		| 'plex-ghost'
		| 'plex-stale'
		| 'backend-unavailable'
		| 'mount-unverifiable';
	fingerprint: string;
	severity: IncidentSeverity;
	title: string;
	summary: string;
	evidence: string[];
	/** When true, a later healthy run should call resolveFinding(fingerprint). */
	resolvable: boolean;
}

export interface ReconcileStats {
	arrChecked: number;
	plexChecked: number;
	available: number;
	arrMissing: number;
	brokenSymlinks: number;
	plexGhosts: number;
	plexStale: number;
	pathsOnDownMount: number;
	pathsUnverifiable: number;
	mountsDown: string[];
	mountsUnverifiable: string[];
	durationMs: number;
}

export interface ReconcileOptions {
	mounts: MountTargetSpec[];
	aliases: PathAliasSpec[];
	arrFiles: ArrFileRecord[];
	plexParts: PlexPartRecord[];
	prober: LibraryProber;
	/** Grace before a healthy-but-unindexed Arr file counts as Plex-stale. */
	staleGraceMs?: number;
	now?: () => number;
}

export interface ReconcileResult {
	findings: ReconcileFinding[];
	stats: ReconcileStats;
	/** Real paths (normalised) of files that verifiably exist on healthy mounts. */
	arrAvailable: Set<string>;
	plexAvailable: Set<string>;
}

// ---------------------------------------------------------------------------
// Path identity
// ---------------------------------------------------------------------------

/** Normalise a recorded path across declared aliases (chained to fixpoint),
 *  so `/media/X`, `/symlinks/TV Shows/X` and the raw bind view converge onto
 *  one identity for set comparison. */
export function normalizePath(path: string, aliases: PathAliasSpec[]): string {
	let out = path;
	for (let hop = 0; hop < 5; hop++) {
		let changed = false;
		for (const alias of aliases) {
			if (out.startsWith(alias.from)) {
				const next = alias.to + out.slice(alias.from.length);
				if (next !== out) {
					out = next;
					changed = true;
					break;
				}
			}
		}
		if (!changed) break;
	}
	return out;
}

function mountForTarget(target: string, mounts: MountTargetSpec[]): MountTargetSpec | null {
	for (const m of mounts) {
		if (target === m.prefix || target.startsWith(m.prefix + '/')) return m;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** The filesystem root prefix of a recorded path, e.g. `/symlinks` or `/media`. */
function pathRoot(path: string): string {
	const parts = path.split('/').filter(Boolean);
	return '/' + (parts[0] ?? '');
}

/**
 * Rewrite a recorded path through every alias (chained, so Arr roots can
 * converge onto Plex library roots and then onto the raw bind view). Used to
 * probe alternate filesystem views of the same logical file.
 */
export function aliasViews(path: string, aliases: PathAliasSpec[]): string[] {
	const views = new Set<string>([path]);
	let current = path;
	for (let hop = 0; hop < 5; hop++) {
		let changed = false;
		for (const alias of aliases) {
			if (current.startsWith(alias.from)) {
				const next = alias.to + current.slice(alias.from.length);
				if (!views.has(next)) {
					views.add(next);
					current = next;
					changed = true;
					break;
				}
			}
		}
		if (!changed) break;
	}
	return [...views];
}

async function classifyPath(
	path: string,
	prober: LibraryProber,
	mounts: MountTargetSpec[],
	mountHealth: Map<string, boolean>,
	mountVisibility: Map<string, MountVisibility>,
	pathAliases: PathAliasSpec[],
	rootVisibility: Map<string, MountVisibility>
): Promise<ItemVerdict> {
	if (!path) return { status: 'missing' };
	// Try every filesystem view of this logical path. The recorded view may
	// not exist in this container while an alias view does (DUMBscope binds
	// /mnt/vm_storage/symlinks/… while Plex records /symlinks/…).
	let missingEverywhere = true;
	let recordedViewVisible = false;
	const views = aliasViews(path, pathAliases);
	for (const view of views) {
		const l = await prober.lstat(view);
		if (l.kind === 'missing') {
			if (view === path && (rootVisibility.get(pathRoot(path)) ?? 'visible') === 'visible') {
				recordedViewVisible = true;
			}
			continue;
		}
		missingEverywhere = false;
		if (l.kind === 'error') {
			return { status: 'unreadable', mount: 'local', code: l.code };
		}
		const target = l.kind === 'symlink' ? (l.target ?? '') : null;
		if (target !== null) {
			const mount = mountForTarget(target, mounts);
			if (mount) {
				const healthy = mountHealth.get(mount.prefix) ?? true;
				if (!healthy) return { status: 'backend-down', mount: mount.label };
			}
		}
		const r = await prober.resolve(view);
		if (r === 'exists') return { status: 'available' };
		if (r === 'missing') {
			if (target !== null) {
				// Target gone: is that permanent (broken symlink) or is the
				// mount simply not visible from this filesystem view? An
				// empty mount root is the signature of a bind of a
				// not-yet-mounted host path.
				const targetMount = target !== null ? mountForTarget(target, mounts) : null;
				const prefix = targetMount?.prefix ?? target.split('/').slice(0, 4).join('/') + '/';
				const visibility = mountVisibility.get(prefix);
				if (visibility === 'missing' || visibility === 'empty' || visibility === 'error') {
					return { status: 'unverifiable', mount: targetMount?.label ?? prefix };
				}
				return { status: 'broken-symlink' };
			}
			return { status: 'missing' };
		}
		return {
			status: 'unreadable',
			mount: target ? (mountForTarget(target, mounts)?.label ?? 'local') : 'local'
		};
	}
	// Every view is missing. If even the recorded path's own root directory
	// is not visible here, this instance cannot judge the item at all —
	// reporting it as permanently missing would be a lie (production lesson
	// 2026-09-16: 4.5k false plex-ghost findings without this rule).
	if (!recordedViewVisible) {
		return { status: 'unverifiable', mount: pathRoot(path) };
	}
	return { status: 'missing' };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const DEFAULT_STALE_GRACE_MS = 30 * 60_000;

export async function reconcileLibrary(options: ReconcileOptions): Promise<ReconcileResult> {
	const t0 = options.now?.() ?? Date.now();
	const { prober, mounts, aliases, arrFiles, plexParts } = options;

	// 1. Mount health with a REAL file operation. statfs/stat-root lies on a
	//    dead FUSE connection (production finding 2026-09-16).
	const mountHealth = new Map<string, boolean>();
	for (const m of mounts) {
		mountHealth.set(m.prefix, await prober.mountHealthy(m.prefix));
	}

	// 2. Classify every recorded Arr path.
	const arrAvailable = new Set<string>();
	const arrMissing: ArrFileRecord[] = [];
	const arrBrokenSymlink: ArrFileRecord[] = [];
	const arrBackendDown: ArrFileRecord[] = [];
	const arrUnverifiable: ArrFileRecord[] = [];
	const arrUnreadable: ArrFileRecord[] = [];

	// Visibility of every configured mount root, so "target gone" can be told
	// apart from "mount not visible to us".
	const mountVisibility = new Map<string, MountVisibility>();
	for (const m of mounts) {
		mountVisibility.set(m.prefix, await prober.mountVisibility(m.prefix));
	}

	// Root visibility for the recorded path views themselves (e.g. `/symlinks`
	// is invisible in a DUMBscope container that binds the raw symlink dir).
	const rootVisibility = new Map<string, MountVisibility>();
	const recordRoot = async (p: string) => {
		const root = pathRoot(p);
		if (!rootVisibility.has(root)) {
			rootVisibility.set(root, await prober.mountVisibility(root));
		}
	};
	await recordRoot('/symlinks');
	for (const rec of arrFiles) await recordRoot(rec.path);
	for (const part of plexParts) await recordRoot(part.path);

	for (const rec of arrFiles) {
		const verdict = await classifyPath(
			rec.path,
			prober,
			mounts,
			mountHealth,
			mountVisibility,
			aliases,
			rootVisibility
		);
		if (verdict.status === 'available') {
			arrAvailable.add(normalizePath(rec.path, aliases));
			continue;
		}
		if (verdict.status === 'backend-down') arrBackendDown.push(rec);
		else if (verdict.status === 'missing') arrMissing.push(rec);
		else if (verdict.status === 'broken-symlink') arrBrokenSymlink.push(rec);
		else if (verdict.status === 'unverifiable') arrUnverifiable.push(rec);
		else arrUnreadable.push(rec);
	}

	// 3. Classify every Plex media part.
	const plexAvailable = new Set<string>();
	const plexGhosts: PlexPartRecord[] = [];
	let plexOnDownMount = 0;
	let plexUnverifiable = 0;
	for (const part of plexParts) {
		const verdict = await classifyPath(
			part.path,
			prober,
			mounts,
			mountHealth,
			mountVisibility,
			aliases,
			rootVisibility
		);
		if (verdict.status === 'available') {
			plexAvailable.add(normalizePath(part.path, aliases));
			continue;
		}
		if (verdict.status === 'backend-down') {
			plexOnDownMount++;
			continue;
		}
		if (verdict.status === 'unverifiable') {
			plexUnverifiable++;
			continue;
		}
		// missing (deleted) or broken-symlink: Plex plays a path that is gone.
		plexGhosts.push(part);
	}

	// 4. Cross-compare: Arr has a verifiably good file Plex does not index.
	//    This is the 'replace-without-rescan' class (scenario E) — it only
	//    fires after the grace window so normal import→scan latency never
	//    alarms (measured on the real stack: seconds to ~2 minutes).
	const now = options.now?.() ?? Date.now();
	const staleGraceMs = options.staleGraceMs ?? DEFAULT_STALE_GRACE_MS;
	const plexStale: ArrFileRecord[] = [];
	for (const rec of arrFiles) {
		if (!arrAvailable.has(normalizePath(rec.path, aliases))) continue;
		if (plexAvailable.has(normalizePath(rec.path, aliases))) continue;
		const addedAt = rec.addedAt ?? 0;
		if (addedAt && now - addedAt < staleGraceMs) continue;
		plexStale.push(rec);
	}

	// ---------------------------------------------------------------------------
	// 5. Findings. One per stable identity; a down mount yields ONE finding.
	//
	// Visibility is the primary signal: a mount root that is missing or an
	// empty directory means this instance cannot verify items on it at all
	// (info, "not visible from this filesystem view"). A visible root whose
	// real file operations fail means the backend is genuinely down
	// (critical, "backend unavailable") — that distinction is what keeps a
	// temporary backend outage from masquerading as permanent missing media.
	// ---------------------------------------------------------------------------
	const findings: ReconcileFinding[] = [];
	const downMounts = mounts.filter(
		(m) => mountVisibility.get(m.prefix) === 'visible' && mountHealth.get(m.prefix) === false
	);

	for (const m of downMounts) {
		findings.push({
			kind: 'backend-unavailable',
			fingerprint: `recon:backend-unavailable:${m.prefix}`,
			severity: 'critical',
			title: `Storage mount ${m.label}: backend unavailable`,
			summary:
				`A real file operation against ${m.prefix} fails. Every library item whose ` +
				'symlink target lives on this mount is currently unplayable, while Sonarr/Radarr ' +
				'still report hasFile=true. Per-item findings are suppressed until the mount recovers.',
			evidence: [
				`mount ${m.prefix} (${m.label}) failed a file-level probe`,
				`${arrBackendDown.length} Arr files and ${plexOnDownMount} Plex parts ` +
					'live on this mount and are currently unusable'
			],
			resolvable: true
		});
	}

	// Mounts whose root is not visible at all (no bind, or a bind of a
	// not-yet-mounted host path): an observer outside the mount owner cannot
	// judge those items. One info finding per mount, never per-item warnings.
	const unverifiableMounts = mounts.filter((m) => {
		const v = mountVisibility.get(m.prefix);
		return v === 'missing' || v === 'empty' || v === 'error';
	});
	for (const m of unverifiableMounts) {
		findings.push({
			kind: 'mount-unverifiable',
			fingerprint: `recon:mount-unverifiable:${m.prefix}`,
			severity: 'info',
			title: `Storage mount ${m.label}: not visible from this filesystem view`,
			summary:
				`The mount root ${m.prefix} is missing or an empty directory here, so items ` +
				'targeting it cannot be verified from this instance. Mount the volume into ' +
				'DUMBscope (or exclude the target) to verify those items.',
			evidence: [
				`${arrUnverifiable.length} Arr files and ${plexUnverifiable} Plex parts ` +
					'target this mount and were skipped'
			],
			resolvable: true
		});
	}

	for (const rec of arrMissing) {
		findings.push({
			kind: 'arr-file-missing',
			fingerprint: `recon:arr-file-missing:${rec.key}`,
			severity: 'warning',
			title: `${rec.label}: Arr says hasFile, filesystem disagrees`,
			summary:
				`${rec.source} reports this item as having a file, but ${rec.path} does not ` +
				'exist. Availability must never be derived from database state alone.',
			evidence: [`recorded path: ${rec.path}`, `lstat: ENOENT`],
			resolvable: true
		});
	}

	for (const rec of arrBrokenSymlink) {
		findings.push({
			kind: 'broken-symlink',
			fingerprint: `recon:broken-symlink:${rec.key}`,
			severity: 'warning',
			title: `${rec.label}: broken symlink on a healthy mount`,
			summary:
				'The symlink exists but its target is gone while the owning mount is healthy. ' +
				'This is permanent missing media, not a transient backend outage.',
			evidence: [`recorded path: ${rec.path}`],
			resolvable: true
		});
	}

	for (const part of plexGhosts) {
		findings.push({
			kind: 'plex-ghost',
			fingerprint: `recon:plex-ghost:${part.key}`,
			severity: 'warning',
			title: `${part.label}: Plex library entry has no file`,
			summary:
				'Plex serves this library entry, but its media part path does not resolve. ' +
				'Playing it yields FILE NOT FOUND. Typical cause: the Arr replaced the release ' +
				'and deleted the old file without Plex being rescanned.',
			evidence: [`plex part path: ${part.path}`],
			resolvable: true
		});
	}

	for (const rec of plexStale) {
		findings.push({
			kind: 'plex-stale',
			fingerprint: `recon:plex-stale:${rec.key}`,
			severity: 'warning',
			title: `${rec.label}: imported file not indexed by Plex`,
			summary:
				'The file verifiably exists and is playable, but no Plex media part references it ' +
				'after the grace window. Plex is stale until it is rescanned.',
			evidence: [`file: ${rec.path}`, `plex parts referencing it: 0`],
			resolvable: true
		});
	}

	const stats: ReconcileStats = {
		arrChecked: arrFiles.length,
		plexChecked: plexParts.length,
		available: arrAvailable.size,
		arrMissing: arrMissing.length,
		brokenSymlinks: arrBrokenSymlink.length,
		plexGhosts: plexGhosts.length,
		plexStale: plexStale.length,
		pathsOnDownMount: arrBackendDown.length + plexOnDownMount,
		pathsUnverifiable: arrUnverifiable.length + plexUnverifiable,
		mountsDown: downMounts.map((m) => m.prefix),
		mountsUnverifiable: unverifiableMounts.map((m) => m.prefix),
		durationMs: (options.now?.() ?? Date.now()) - t0
	};

	return { findings, stats, arrAvailable, plexAvailable };
}

// ---------------------------------------------------------------------------
// Findings → incident engine deltas (stateful across runs)
// ---------------------------------------------------------------------------

/**
 * Diff two reconcile runs' active fingerprints so the incident engine only
 * hears about opens/updates and clean resolutions. Keeps per-item noise from
 * re-opening deduplicated incidents every cycle.
 */
export function diffFindings(
	previous: Set<string>,
	current: ReconcileFinding[]
): { open: ReconcileFinding[]; close: string[] } {
	const open = current.filter((f) => !previous.has(f.fingerprint));
	const seen = new Set(current.map((f) => f.fingerprint));
	const close = [...previous].filter((fp) => !seen.has(fp));
	return { open, close };
}
