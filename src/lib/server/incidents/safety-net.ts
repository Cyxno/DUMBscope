/**
 * Stale-incident safety net: a bounded periodic pass over persisted open
 * incidents that verifies each one still has an evaluable origin — the
 * configured mount target, the registered integration, the enabled monitor.
 *
 * Purpose: no incident may stay open purely because its originating target
 * disappeared. Findings whose origin is provably gone resolve with an
 * explicit OBSOLETE resolution ("target removed", "monitor disabled",
 * "integration deleted") recorded in the timeline — never as a recovery.
 *
 * Honest-verification rule: this pass never resolves anything when the
 * detector merely cannot verify right now (DUMB offline, metrics stale,
 * probe round failing). "Cannot evaluate" and "no longer exists" are
 * different states and stay distinct.
 */
import type { MountTarget } from '$lib/types';
import type { IncidentEngine } from './engine';

export interface SafetyNetContext {
	now: number;
	/** Currently configured mount targets (empty when mount monitoring is off). */
	mountTargets: MountTarget[];
	mountMonitoringEnabled: boolean;
	memoryMonitoringEnabled: boolean;
	reconciliationEnabled: boolean;
	runtimeMonitoringEnabled: boolean;
	/** Every registered integration id (enabled or not). */
	registeredIntegrationIds: string[];
	/** At least one enabled Sonarr/Radarr exists (media-flow can evaluate). */
	arrIntegrationsPresent: boolean;
	dumbConfigured: boolean;
	/** True only when the metrics snapshot is recent — gates metrics-derived judgments. */
	metricsFresh: boolean;
	/** True once the post-upgrade grace window (default 60 min) has passed:
	 *  pre-v0.8 rows no current detector re-adopted by then can no longer be
	 *  evaluated and are retired as obsolete (never as recovered). */
	legacyGraceElapsed: boolean;
}

const PREFIX = {
	mount: 'mount:',
	symlink: 'symlinks:',
	memory: 'memory:',
	recon: 'recon:',
	integration: 'integration-down:',
	media: 'media-',
	self: 'self:',
	service: 'svc-'
} as const;

export class IncidentSafetyNet {
	/** Open incidents inspected on the last pass (for the runtime panel). */
	lastInspectedAt: number | null = null;
	lastResolvedCount = 0;
	lastNote: string | null = null;

	constructor(private readonly engine: IncidentEngine) {}

	run(ctx: SafetyNetContext): number {
		const resolved = this.sweep(ctx);
		this.lastInspectedAt = ctx.now;
		this.lastResolvedCount = resolved;
		return resolved;
	}

	private sweep(ctx: SafetyNetContext): number {
		const engine = this.engine;
		let resolved = 0;

		// DUMB deconfigured: nothing about the stack is evaluable anymore.
		if (!ctx.dumbConfigured) {
			resolved += engine.resolveWhere(
				(i) => i.detector.startsWith('status.') || i.detector.startsWith('metrics.'),
				() => 'Resolved: the DUMB connection was removed from the configuration',
				ctx.now
			);
			this.lastNote = 'dumb-unconfigured';
			return resolved;
		}

		// Pre-v0.8 rows no detector re-adopted since the upgrade: their
		// identity is unknown and no fingerprint matches them anymore, so they
		// can never be evaluated again. After the grace window they retire with
		// an explicit OBSOLETE reason — never presented as a recovery. Rows a
		// detector DID re-adopt carry a stamped detector (engine adoption) and
		// are evaluated like native findings; a legacy finding whose condition
		// still holds stays open instead of being falsely resolved.
		if (ctx.legacyGraceElapsed) {
			resolved += engine.resolveWhere(
				(i) => i.lastEvaluatedAt === null,
				() =>
					'Resolved: legacy (pre-v0.8) finding could no longer be evaluated by any current detector',
				ctx.now
			);
		}

		// Monitor disabled: its findings can no longer be evaluated.
		if (!ctx.mountMonitoringEnabled) {
			resolved += engine.resolveWhere(
				(i) => i.fingerprint.startsWith(PREFIX.mount) || i.fingerprint.startsWith(PREFIX.symlink),
				() => 'Resolved: mount monitoring is disabled',
				ctx.now
			);
		}
		if (!ctx.memoryMonitoringEnabled) {
			resolved += engine.resolveWhere(
				(i) => i.fingerprint.startsWith(PREFIX.memory),
				() => 'Resolved: memory anomaly monitoring is disabled',
				ctx.now
			);
		}
		if (!ctx.reconciliationEnabled) {
			resolved += engine.resolveWhere(
				(i) => i.fingerprint.startsWith(PREFIX.recon),
				() => 'Resolved: library reconciliation is disabled',
				ctx.now
			);
		}
		if (!ctx.runtimeMonitoringEnabled) {
			resolved += engine.resolveWhere(
				(i) => i.fingerprint.startsWith(PREFIX.self),
				() => 'Resolved: runtime self-monitoring is disabled',
				ctx.now
			);
		}
		if (!ctx.arrIntegrationsPresent) {
			resolved += engine.resolveWhere(
				(i) => i.fingerprint.startsWith(PREFIX.media),
				() => 'Resolved: no Arr integrations are configured anymore',
				ctx.now
			);
		}

		// Mount targets: a finding for a path that is no longer configured has
		// no probe path back to truth — it must not outlive its target.
		const mountPaths = new Set(ctx.mountTargets.map((t) => t.path));
		resolved += engine.resolveWhere(
			(i) =>
				(i.fingerprint.startsWith(PREFIX.mount) || i.fingerprint.startsWith(PREFIX.symlink)) &&
				(() => {
					const identity = engine.identityOf(i.fingerprint);
					return identity !== null && !mountPaths.has(identity);
				})(),
			(i) => {
				const identity = engine.identityOf(i.fingerprint) ?? 'unknown path';
				return `Resolved: monitored mount "${identity}" was removed from the configuration`;
			},
			ctx.now
		);

		// Integrations: a failing-poll finding for a deleted integration can
		// never recover through polling — retire it.
		const registered = new Set(ctx.registeredIntegrationIds);
		resolved += engine.resolveWhere(
			(i) =>
				i.fingerprint.startsWith(PREFIX.integration) &&
				(() => {
					const identity = engine.identityOf(i.fingerprint);
					return identity !== null && !registered.has(identity);
				})(),
			(i) => `Resolved: integration "${engine.identityOf(i.fingerprint) ?? 'unknown'}" was deleted`,
			ctx.now
		);

		// Note: item-level media findings (media-repeat/media-mismatch/media-
		// failing) resolve through the media-flow correlator's complete-cycle
		// open/close sweep — a history window that rolled over must not look
		// like "recovered" here, and a failed Arr read must resolve nothing.

		return resolved;
	}
}
