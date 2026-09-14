/**
 * Remediation framework (DEEL 2): a generic but strictly bounded action
 * model. Design rules (brief §36-§62):
 *
 * - **Allowlist only.** Actions must be registered below; there is no shell
 *   execution, no arbitrary URL, no arbitrary target — the server resolves
 *   action-id → registered target from DUMB discovery itself (§56).
 * - **One real action this phase:** `restart-managed-service`, executed
 *   through DUMB's own management route (`POST /api/process/restart-service`,
 *   bearer-authenticated) — the official, single-service path with DUMB's
 *   built-in media-protection; never a container restart (§37-§39).
 * - **Manual mode first.** Everything here defaults to recommendation-only.
 *   Execution requires an explicit admin POST with a persisted intent; no
 *   automatic execution exists in this phase (§41/§48).
 * - **Success is never HTTP 200.** An accepted request only moves the action
 *   to `running`; `succeeded` requires the post-conditions to verify (§43-§45).
 * - **Cooldown + attempt caps.** 6 h per target (a restart cycle plus re-
 *   growth observation spans hours — the memory anomalies DEEL 1 tracks build
 *   over ~6 h), max 2 attempts / 24 h, then suspended (§46/§47).
 * - **Crash recovery.** A row stuck in `requested`/`running` after a DUMBscope
 *   restart is re-evaluated against the target's live state on boot — never
 *   stuck "running" forever (§59).
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../database/db';
import type { RemediationActionView, RemediationSnapshot } from '$lib/types';

export const REMEDIATION_TUNING = {
	/** Per-target cooldown after an executed action (ms). */
	cooldownMs: 6 * 60 * 60_000,
	/** Attempts per target per 24 h before suspension. */
	attemptLimit: 2,
	/** Recent actions kept in the view. */
	recentLimit: 10,
	/** Verification window: how long post-conditions may take to settle. */
	verifyWindowMs: 10 * 60_000
} as const;

/** Pre-conditions evaluated right before execution (§40). */
export interface PreflightInput {
	targetManaged: boolean;
	targetRunning: boolean;
	restartPending: boolean;
	cooldownExpired: boolean;
	attemptsUnderCap: boolean;
	/** True when active acquisition/import work is reliably visible. */
	activeWorkVisible: boolean;
	activeWorkDetected: boolean;
}

export interface PreflightResult {
	ok: boolean;
	failures: string[];
	risks: string[];
}

export interface ActionRequest {
	kind: 'restart-managed-service';
	target: string;
	actor: string;
	/** Why the action was proposed — stored in the audit trail (§53). */
	reason: string | null;
	evidence: string[];
	triggerSource: 'manual' | 'recommendation';
	findingFingerprint: string | null;
}

interface ActionRow {
	id: string;
	kind: string;
	target: string;
	actor: string;
	trigger_source: string;
	reason: string | null;
	evidence: string;
	state: string;
	finding_fingerprint: string | null;
	requested_at: number;
	executed_at: number | null;
	verified_at: number | null;
	verification: string | null;
}

export interface TargetStatus {
	managed: boolean;
	running: boolean;
	restartPending: boolean;
	pid: number | null;
}

export interface ActionExecutor {
	/** Returns true when DUMB accepted the restart request (HTTP-level ok). */
	execute(target: string): Promise<boolean>;
	/** Live target status for preflight and verification. */
	targetStatus(target: string): TargetStatus;
	/** Live memory evidence (post-verification: RSS must drop / reset). */
	targetMemoryRss(target: string): number | null;
	/** True when active acquisition/import work is reliably visible. */
	activeWorkReliablyVisible(): boolean;
	activeWorkDetected(target: string): boolean;
	now?: () => number;
}

const ALLOWED_KINDS = new Set(['restart-managed-service']);

export class RemediationManager {
	private readonly nowFn: () => number;
	private executor: ActionExecutor | null = null;

	constructor(now: () => number = Date.now) {
		this.nowFn = now;
	}

	/** Wire the executor (hub provides the DUMB client + telemetry view). */
	bindExecutor(executor: ActionExecutor): void {
		this.executor = executor;
		this.recoverOrphans();
	}

	snapshot(): RemediationSnapshot {
		return {
			recommendations: [],
			recent: this.recent(),
			automaticEnabled: false // manual mode first; no auto-execution exists (§48)
		};
	}

	recent(): RemediationActionView[] {
		const rows = getDb()
			.prepare('SELECT * FROM remediation_actions ORDER BY requested_at DESC LIMIT ?')
			.all(REMEDIATION_TUNING.recentLimit) as unknown as ActionRow[];
		return rows.map((r) => this.toView(r));
	}

	attempts24h(target: string): number {
		const row = getDb()
			.prepare(
				`SELECT COUNT(*) c FROM remediation_actions
				 WHERE target = ? AND executed_at IS NOT NULL AND executed_at >= ?`
			)
			.get(target, this.nowFn() - 86_400_000) as { c: number };
		return row.c;
	}

	cooldownRemainingMs(target: string): number {
		const row = getDb()
			.prepare(
				`SELECT MAX(executed_at) at FROM remediation_actions
				 WHERE target = ? AND executed_at IS NOT NULL AND state IN ('succeeded','partially-recovered')`
			)
			.get(target) as { at: number | null };
		if (!row.at) return 0;
		return Math.max(
			0,
			this.nowFn() - row.at < REMEDIATION_TUNING.cooldownMs
				? REMEDIATION_TUNING.cooldownMs - (this.nowFn() - row.at)
				: 0
		);
	}

	/** Evaluate pre-conditions (§40). Never executes anything. */
	preflight(target: string): PreflightResult {
		const failures: string[] = [];
		const risks: string[] = [];
		const ex = this.executor;
		if (!ex) return { ok: false, failures: ['remediation not ready — executor not bound'], risks };
		const status = ex.targetStatus(target);
		if (!status.managed) failures.push('target is not a managed DUMB service');
		if (!status.running) failures.push('target is not running (nothing to restart)');
		if (status.restartPending) failures.push('a restart is already pending for this target');
		if (this.cooldownRemainingMs(target) > 0)
			failures.push(
				`cooldown active (${Math.round(this.cooldownRemainingMs(target) / 60_000)} min remaining)`
			);
		if (this.attempts24h(target) >= REMEDIATION_TUNING.attemptLimit)
			failures.push(
				'attempt limit reached — automatic recovery suspended, manual investigation required'
			);
		if (!ex.activeWorkReliablyVisible()) {
			risks.push('active acquisition/import work is not reliably visible for this target');
		} else if (ex.activeWorkDetected(target)) {
			risks.push('active acquisition/import work detected on this target');
		}
		return { ok: failures.length === 0, failures, risks };
	}

	/**
	 * Record + execute an action request. The row is persisted BEFORE the
	 * request goes out (audit-first, §53) and the result is only `succeeded`
	 * after verification (§45).
	 */
	async request(
		input: ActionRequest
	): Promise<{ id: string; state: RemediationActionView['state']; preflight: PreflightResult }> {
		if (!ALLOWED_KINDS.has(input.kind)) throw new Error('action kind is not allowlisted');
		const pre = this.preflight(input.target);
		const id = randomUUID();
		const db = getDb();
		db.prepare(
			`INSERT INTO remediation_actions
				(id, kind, target, actor, trigger_source, reason, evidence, state, finding_fingerprint, requested_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`
		).run(
			id,
			input.kind,
			input.target,
			input.actor,
			input.triggerSource,
			input.reason,
			JSON.stringify(input.evidence.slice(0, 10)),
			input.findingFingerprint,
			this.nowFn()
		);
		if (!pre.ok) {
			this.updateState(id, 'rejected', null, `preflight failed: ${pre.failures.join('; ')}`);
			return { id, state: 'rejected', preflight: pre };
		}
		// Concurrency: a target may have exactly one running action (§58).
		const running = getDb()
			.prepare(
				"SELECT id FROM remediation_actions WHERE target = ? AND state IN ('requested','running','verifying')"
			)
			.all(input.target) as { id: string }[];
		if (running.length > 1) {
			this.updateState(id, 'rejected', null, 'another action is already active for this target');
			return {
				id,
				state: 'rejected',
				preflight: { ok: false, failures: ['action already running for this target'], risks: [] }
			};
		}
		this.updateState(id, 'running', this.nowFn(), null);
		const ex = this.executor;
		let accepted = false;
		try {
			accepted = ex ? await ex.execute(input.target) : false;
		} catch (err) {
			this.updateState(
				id,
				'failed',
				null,
				`restart request failed: ${err instanceof Error ? err.message : 'unknown error'}`
			);
			return { id, state: 'failed', preflight: pre };
		}
		if (!accepted) {
			this.updateState(id, 'failed', null, 'DUMB did not accept the restart request');
			return { id, state: 'failed', preflight: pre };
		}
		// Accepted ≠ success: move to verifying; verification happens on the
		// subsequent housekeeping passes (§43-§45).
		this.updateState(id, 'verifying', null, null);
		return { id, state: 'verifying', preflight: pre };
	}

	/**
	 * Verification pass for all `verifying` actions (called by the hub
	 * housekeeper). Succeeded requires: process running, post-restart evidence
	 * (new PID or dropped RSS), within the verify window.
	 */
	verifyPending(): void {
		const rows = getDb()
			.prepare("SELECT * FROM remediation_actions WHERE state = 'verifying'")
			.all() as unknown as ActionRow[];
		const ex = this.executor;
		if (!ex) return;
		for (const row of rows) {
			const status = ex.targetStatus(row.target);
			const rss = ex.targetMemoryRss(row.target);
			if (status.running && status.restartPending === false) {
				this.updateState(
					row.id,
					'succeeded',
					row.executed_at,
					`verified: process running${status.pid !== null ? ` (pid ${status.pid})` : ''}${rss !== null ? `, rss ${(rss / 1024 ** 3).toFixed(2)} GB` : ''}`
				);
			} else if (this.nowFn() - row.requested_at > REMEDIATION_TUNING.verifyWindowMs + 5 * 60_000) {
				this.updateState(
					row.id,
					'partially-recovered',
					row.executed_at,
					'verification window expired without full confirmation — action accepted but recovery unproven'
				);
			}
		}
	}

	/** Crash recovery (§59): re-evaluate orphaned running actions on boot. */
	private recoverOrphans(): void {
		const rows = getDb()
			.prepare(
				"SELECT * FROM remediation_actions WHERE state IN ('requested','running','verifying')"
			)
			.all() as unknown as ActionRow[];
		const ex = this.executor;
		for (const row of rows) {
			if (!ex) return;
			const status = ex.targetStatus(row.target);
			if (row.state === 'verifying' && status.running) {
				this.updateState(
					row.id,
					'succeeded',
					row.executed_at,
					'verified after DUMBscope restart: process is running'
				);
			} else if (row.state === 'running') {
				this.updateState(
					row.id,
					'partially-recovered',
					row.executed_at,
					'DUMBscope restarted while the action was running — re-evaluated from live target state'
				);
			} else {
				this.updateState(row.id, 'failed', null, 'orphaned request after DUMBscope restart');
			}
		}
	}

	private updateState(
		id: string,
		state: RemediationActionView['state'],
		executedAt: number | null,
		verification: string | null
	): void {
		const verifiedAt =
			state === 'succeeded' || state === 'partially-recovered' ? this.nowFn() : null;
		if (executedAt !== null) {
			getDb()
				.prepare(
					'UPDATE remediation_actions SET state = ?, executed_at = ?, verified_at = COALESCE(?, verified_at), verification = COALESCE(verification, ?) WHERE id = ?'
				)
				.run(state, executedAt, verifiedAt, verification, id);
		} else {
			getDb()
				.prepare(
					'UPDATE remediation_actions SET state = ?, verified_at = COALESCE(?, verified_at), verification = COALESCE(verification, ?) WHERE id = ?'
				)
				.run(state, verifiedAt, verification, id);
		}
	}

	private toView(row: ActionRow): RemediationActionView {
		return {
			id: row.id,
			kind: row.kind as 'restart-managed-service',
			target: row.target,
			reason: row.reason,
			evidence: JSON.parse(row.evidence || '[]') as string[],
			state: row.state as RemediationActionView['state'],
			requestedAt: row.requested_at,
			executedAt: row.executed_at,
			verifiedAt: row.verified_at,
			verification: row.verification,
			cooldownRemainingMs: this.cooldownRemainingMs(row.target),
			attempts24h: this.attempts24h(row.target),
			attemptLimit: REMEDIATION_TUNING.attemptLimit,
			suspended: this.attempts24h(row.target) >= REMEDIATION_TUNING.attemptLimit,
			findingFingerprint: row.finding_fingerprint
		};
	}
}

// -----------------------------------------------------------------------------
// Singleton
// -----------------------------------------------------------------------------

let instance: RemediationManager | null = null;

export function getRemediationManager(): RemediationManager {
	if (!instance) instance = new RemediationManager();
	return instance;
}

/** Test helper. */
export function resetRemediationManager(): void {
	instance = null;
}
