/**
 * Safe Actions executor (docs/ACTIONS.md). Runs the media-command allowlist
 * from {@link ./registry} against an exact integration instance.
 *
 * Guarantees (§13/§14/§15):
 *  - audit-first: the row is persisted before the upstream request goes out;
 *  - acceptance ≠ outcome: "Search requested" never claims "media found";
 *  - atomic duplicate suppression: the cooldown check, the in-flight dedupe
 *    check and the audit INSERT run inside one BEGIN IMMEDIATE transaction,
 *    backed by a partial UNIQUE index on active claims (migration v11) —
 *    concurrent identical requests serialize at the SQLite layer and only
 *    one reaches upstream (§13a);
 *  - bounded follow-up: at most `followMaxPolls` status polls, then the row
 *    settles on `unconfirmed` — no endless polling, no polling storms;
 *  - crash honesty: rows left in flight by a previous process are settled to
 *    `unconfirmed` at startup reconciliation — never "failed", never
 *    re-executed (§13b);
 *  - per-target cooldowns against double-clicks (short, not safety-critical);
 *  - no secrets: rows carry ids and plain-language messages only.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../database/db';
import { ArrAuthError, ArrBaseClient, ArrError } from '../integrations/arr/base';
import { getApiKey, getIntegration } from '../integrations/store';
import type { IntegrationConfig } from '../integrations/types';
import {
	getMediaAction,
	validateMediaTarget,
	type MediaActionDefinition,
	type MediaActionTarget
} from './registry';
import type { IntegrationActionState, IntegrationActionView } from '$lib/types';

export const ACTIONS_TUNING = {
	/** Bounded upstream follow-up: interval × max ≈ 20 s window. */
	followPollIntervalMs: 2_000,
	followMaxPolls: 10,
	/**
	 * Startup reconciliation age bound (§13b): rows still `requested`/`accepted`
	 * after this long were orphaned by a dead process (the follow window is
	 * ~20 s) and are settled to `unconfirmed`. Conservative — fresh rows are
	 * never touched, whatever the boot timing.
	 */
	reconcileAgeMs: 60_000,
	/** Rows kept for the activity view (hard LIMIT on every read). */
	recentLimit: 25,
	/** Audit retention; pruned opportunistically. */
	retentionMs: 14 * 86_400_000
} as const;

/** Structural subset of ArrBaseClient the manager needs (test seam). */
export interface ArrCommandClient {
	commandStatus(commandId: number): Promise<{ id?: number; status?: string }>;
	commandEpisodeSearch(episodeIds: number[]): Promise<{ id?: number; status?: string }>;
	commandSeasonSearch(
		seriesId: number,
		seasonNumber: number
	): Promise<{ id?: number; status?: string }>;
	commandSeriesSearch(seriesId: number): Promise<{ id?: number; status?: string }>;
	commandRefreshSeries(seriesId: number): Promise<{ id?: number; status?: string }>;
	commandMoviesSearch(movieIds: number[]): Promise<{ id?: number; status?: string }>;
	commandRefreshMovie(movieId: number): Promise<{ id?: number; status?: string }>;
}

export type ArrClientFactory = (config: IntegrationConfig, apiKey: string) => ArrCommandClient;

const defaultClientFactory: ArrClientFactory = (config, apiKey) =>
	new ArrBaseClient(config.url, apiKey);

export type FollowScheduler = (fn: () => void, ms: number) => void;

export interface ActionExecuteInput {
	actionId: string;
	/** Exact integration instance — resolved by id, never first-match (§18). */
	integrationId: string;
	target: unknown;
	actor: string;
}

export interface ActionExecuteResult {
	id: string;
	state: IntegrationActionState;
	message: string | null;
	upstreamCommandId: number | null;
	cooldownRemainingMs: number;
}

interface ActionRow {
	id: string;
	action: string;
	integration_id: string | null;
	target: string;
	target_key: string;
	actor: string;
	state: string;
	message: string | null;
	upstream_command_id: number | null;
	requested_at: number;
	finished_at: number | null;
}

export class ActionsManager {
	private readonly nowFn: () => number;
	private readonly clientFactory: ArrClientFactory;
	private readonly scheduleFollow: FollowScheduler;

	constructor(
		opts: {
			now?: () => number;
			clientFactory?: ArrClientFactory;
			scheduleFollow?: FollowScheduler;
		} = {}
	) {
		this.nowFn = opts.now ?? Date.now;
		this.clientFactory = opts.clientFactory ?? defaultClientFactory;
		this.scheduleFollow = opts.scheduleFollow ?? ((fn, ms) => setTimeout(fn, ms));
	}

	/** Validate + execute one allowlisted action. Never throws to the caller. */
	async execute(input: ActionExecuteInput): Promise<ActionExecuteResult> {
		const action = getMediaAction(input.actionId);
		if (!action) {
			return this.rejectFresh(input.actor, 'unknown action', 'Action is not allowlisted');
		}
		const checked = validateMediaTarget(action, input.target);
		if (!checked.ok) {
			return this.rejectFresh(input.actor, 'invalid target', checked.error);
		}
		// Logical action identity: integration instance + allowlisted action id
		// + normalized target. target_key embeds the action id, so the pair
		// (integration_id, target_key) is the dedupe/claim key everywhere.
		const targetKey = `${action.id}:${checked.targetKey}`;

		// §18: exact instance, no fallback resolution. Type must match the
		// action — a radarr id must never hit a sonarr instance.
		const config = getIntegration(input.integrationId);
		if (!config || config.id !== input.integrationId) {
			return this.rejectFresh(
				input.actor,
				'unknown integration',
				'Unknown integration instance',
				input.integrationId,
				targetKey,
				action.id
			);
		}
		if (config.type !== action.integrationType) {
			return this.rejectFresh(
				input.actor,
				'wrong integration type',
				`Action targets ${action.integrationType}, but ${config.id} is a ${config.type} instance`,
				config.id,
				targetKey,
				action.id
			);
		}
		if (!config.enabled) {
			return this.rejectFresh(
				input.actor,
				'integration disabled',
				'Integration is disabled',
				config.id,
				targetKey,
				action.id
			);
		}
		const apiKey = getApiKey(config.id);
		if (!apiKey) {
			return this.rejectFresh(
				input.actor,
				'no api key',
				'Authentication failed — no API key configured for this integration',
				config.id,
				targetKey,
				action.id
			);
		}

		// §13a: atomic claim — cooldown check, in-flight dedupe and the
		// audit-first INSERT serialize inside one SQLite transaction.
		const claimed = this.claim(input.actor, config.id, targetKey, checked.targetKey, action);
		if ('result' in claimed) return claimed.result;
		const id = claimed.id;

		const client = this.clientFactory(config, apiKey);
		let accepted: { id?: number; status?: string };
		try {
			accepted = await this.postCommand(client, action, checked.target);
		} catch (err) {
			const message = upstreamErrorMessage(err);
			this.finish(id, 'failed', message, null);
			return { id, state: 'failed', message, upstreamCommandId: null, cooldownRemainingMs: 0 };
		}

		const commandId = typeof accepted.id === 'number' ? accepted.id : null;
		this.update(
			id,
			'accepted',
			`${action.acceptedMessage}${commandId !== null ? ` (command ${commandId})` : ''}`,
			commandId,
			null
		);
		if (commandId !== null) {
			this.scheduleFollow(() => {
				void this.followUp(id, action, config, apiKey, commandId, 0);
			}, ACTIONS_TUNING.followPollIntervalMs);
		} else {
			this.finish(id, 'unconfirmed', 'Accepted, but upstream did not report a command id', null);
		}
		return {
			id,
			state: 'accepted',
			message: action.acceptedMessage,
			upstreamCommandId: commandId,
			cooldownRemainingMs: action.cooldownMs
		};
	}

	/**
	 * §13a — atomic claim of one execution slot for a logical action
	 * (integration instance + allowlisted action id + normalized target).
	 *
	 * Cooldown check, in-flight dedupe check and the audit-first INSERT run
	 * inside one `BEGIN IMMEDIATE` transaction: SQLite has exactly one writer,
	 * so concurrent identical requests serialize here and exactly one wins.
	 * The partial UNIQUE index on active claims (migration v11) is the
	 * structural backstop — a duplicate INSERT cannot exist even if a future
	 * code path skips the SELECT. The loser receives a deterministic
	 * `rejected` result ("already in progress") and is audited; it never
	 * reaches upstream and learns nothing but ids and plain language.
	 */
	private claim(
		actor: string,
		integrationId: string,
		targetKey: string,
		rawTarget: string,
		action: MediaActionDefinition
	): { id: string } | { result: ActionExecuteResult } {
		const db = getDb();
		const now = this.nowFn();
		db.exec('BEGIN IMMEDIATE');
		try {
			const cooldown = this.cooldownRemainingMs(integrationId, targetKey, action.cooldownMs);
			if (cooldown > 0) {
				const result = this.rejectFresh(
					actor,
					'cooldown',
					`Cooldown active for this target (${Math.ceil(cooldown / 1000)}s remaining)`,
					integrationId,
					targetKey,
					action.id,
					cooldown
				);
				db.exec('COMMIT');
				return { result };
			}
			// One active execution per logical action. Stale actives of THIS
			// target are settled first (§13b self-heal): an orphan of a dead
			// process — outcome unknown, never "failed" — must never block a
			// fresh request, and this keeps the partial UNIQUE index
			// satisfiable even if startup reconciliation has not run yet.
			db.prepare(
				`UPDATE integration_actions
				 SET state = 'unconfirmed',
				     message = 'Interrupted by restart before a final state was recorded',
				     finished_at = COALESCE(finished_at, ?)
				 WHERE integration_id = ? AND target_key = ?
				   AND state IN ('requested','accepted') AND requested_at < ?`
			).run(now, integrationId, targetKey, now - ACTIONS_TUNING.reconcileAgeMs);
			// After the settle, any remaining active row is fresh: exactly one
			// live execution may own this logical action.
			const active = db
				.prepare(
					`SELECT id FROM integration_actions
					 WHERE integration_id = ? AND target_key = ?
					   AND state IN ('requested','accepted')`
				)
				.get(integrationId, targetKey);
			if (active) {
				const result = this.rejectFresh(
					actor,
					'duplicate',
					'An identical action is already in progress for this target',
					integrationId,
					targetKey,
					action.id
				);
				db.exec('COMMIT');
				return { result };
			}
			// Audit-first (§15): the attempt exists before any upstream I/O.
			const id = randomUUID();
			db.prepare(
				`INSERT INTO integration_actions
					(id, action, integration_id, target, target_key, actor, state, requested_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'requested', ?)`
			).run(id, action.id, integrationId, rawTarget, targetKey, actor, now);
			db.exec('COMMIT');
			return { id };
		} catch (err) {
			db.exec('ROLLBACK');
			if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
				// Structural backstop fired: another execution owns the claim.
				return {
					result: this.rejectFresh(
						actor,
						'duplicate',
						'An identical action is already in progress for this target',
						integrationId,
						targetKey,
						action.id
					)
				};
			}
			throw err;
		}
	}

	/**
	 * §13b — settle rows orphaned by a dead process. A `requested` or
	 * `accepted` row older than the conservative age bound can no longer have
	 * a live follow-up (the window is ~20 s): its upstream outcome is unknown,
	 * so the honest terminal state is `unconfirmed` — never "failed", and the
	 * action is never re-executed. Idempotent: reruns match nothing; fresh
	 * requests and terminal rows are untouched.
	 */
	reconcileInterrupted(now: number = this.nowFn()): number {
		const result = getDb()
			.prepare(
				`UPDATE integration_actions
				 SET state = 'unconfirmed',
				     message = 'Interrupted by restart before a final state was recorded',
				     finished_at = COALESCE(finished_at, ?)
				 WHERE state IN ('requested','accepted') AND requested_at < ?`
			)
			.run(now, now - ACTIONS_TUNING.reconcileAgeMs);
		return Number(result.changes);
	}

	/** Dispatch to the typed command wrapper for this action. */
	private postCommand(
		client: ArrCommandClient,
		action: MediaActionDefinition,
		target: MediaActionTarget
	): Promise<{ id?: number; status?: string }> {
		switch (action.id) {
			case 'sonarr.searchEpisode':
				return client.commandEpisodeSearch(target.episodeIds ?? []);
			case 'sonarr.searchSeason':
				return client.commandSeasonSearch(target.seriesId ?? 0, target.seasonNumber ?? 0);
			case 'sonarr.refreshSeries':
				return client.commandRefreshSeries(target.seriesId ?? 0);
			case 'radarr.searchMovie':
				return client.commandMoviesSearch([target.movieId ?? 0]);
			case 'radarr.refreshMovie':
				return client.commandRefreshMovie(target.movieId ?? 0);
		}
	}

	/**
	 * Bounded upstream status follow (§13). Runs detached from the request;
	 * every path terminates in a final state within `followMaxPolls` polls.
	 */
	private async followUp(
		rowId: string,
		action: MediaActionDefinition,
		config: IntegrationConfig,
		apiKey: string,
		commandId: number,
		poll: number
	): Promise<void> {
		const row = this.getRow(rowId);
		if (!row || row.state !== 'accepted') return; // superseded/pruned
		let status: string | undefined;
		try {
			const client = this.clientFactory(config, apiKey);
			status = (await client.commandStatus(commandId)).status;
		} catch {
			status = undefined; // transient — retry within the window
		}
		if (status === 'completed') {
			this.finish(rowId, 'completed', `${action.label}: upstream command completed`, commandId);
			return;
		}
		if (status === 'failed' || status === 'aborted' || status === 'cancelled') {
			this.finish(rowId, 'failed', `Upstream command reported ${status}`, commandId);
			return;
		}
		if (poll + 1 >= ACTIONS_TUNING.followMaxPolls) {
			this.finish(
				rowId,
				'unconfirmed',
				'Accepted — upstream did not report a final state within the follow window; check the Library/Queue',
				commandId
			);
			return;
		}
		this.scheduleFollow(() => {
			void this.followUp(rowId, action, config, apiKey, commandId, poll + 1);
		}, ACTIONS_TUNING.followPollIntervalMs);
	}

	/** Persist a rejection that happened before any upstream I/O. */
	private rejectFresh(
		actor: string,
		message: string,
		display: string,
		integrationId: string | null = null,
		targetKey = 'unresolved',
		actionId = 'unknown',
		cooldownRemainingMs = 0
	): ActionExecuteResult {
		getDb()
			.prepare(
				`INSERT INTO integration_actions
					(id, action, integration_id, target, target_key, actor, state, message, requested_at, finished_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'rejected', ?, ?, ?)`
			)
			.run(
				randomUUID(),
				actionId,
				integrationId,
				targetKey,
				targetKey,
				actor,
				message,
				this.nowFn(),
				this.nowFn()
			);
		return {
			id: '',
			state: 'rejected',
			message: display,
			upstreamCommandId: null,
			cooldownRemainingMs
		};
	}

	private update(
		id: string,
		state: IntegrationActionState,
		message: string | null,
		upstreamCommandId: number | null,
		finishedAt: number | null
	): void {
		getDb()
			.prepare(
				`UPDATE integration_actions
				 SET state = ?, message = ?, upstream_command_id = COALESCE(?, upstream_command_id), finished_at = COALESCE(?, finished_at)
				 WHERE id = ?`
			)
			.run(state, message, upstreamCommandId, finishedAt, id);
	}

	private finish(
		id: string,
		state: IntegrationActionState,
		message: string,
		commandId: number | null
	): void {
		this.update(id, state, message, commandId, this.nowFn());
	}

	private getRow(id: string): ActionRow | null {
		const row = getDb().prepare('SELECT * FROM integration_actions WHERE id = ?').get(id) as
			ActionRow | undefined;
		return row ?? null;
	}

	cooldownRemainingMs(integrationId: string, targetKey: string, cooldownMs: number): number {
		// Cooldown starts at acceptance (requested_at doubles as accepted_at —
		// acceptance is immediate); terminal rows use their finished_at.
		const row = getDb()
			.prepare(
				`SELECT MAX(COALESCE(finished_at, requested_at)) at FROM integration_actions
				 WHERE integration_id = ? AND target_key = ? AND state IN ('accepted','completed')`
			)
			.get(integrationId, targetKey) as { at: number | null };
		if (!row.at) return 0;
		const age = this.nowFn() - row.at;
		return age < cooldownMs ? cooldownMs - age : 0;
	}

	/** Bounded recent audit trail for the Activity view (§16). */
	recent(limit = ACTIONS_TUNING.recentLimit): IntegrationActionView[] {
		this.prune();
		const capped = Math.min(Math.max(1, limit), ACTIONS_TUNING.recentLimit);
		const rows = getDb()
			.prepare('SELECT * FROM integration_actions ORDER BY requested_at DESC, id DESC LIMIT ?')
			.all(capped) as unknown as ActionRow[];
		return rows.map((r) => this.toView(r));
	}

	/** Single action status for the UI's bounded result polling. */
	get(id: string): IntegrationActionView | null {
		const row = this.getRow(id);
		return row ? this.toView(row) : null;
	}

	private prune(): void {
		getDb()
			.prepare('DELETE FROM integration_actions WHERE requested_at < ?')
			.run(this.nowFn() - ACTIONS_TUNING.retentionMs);
	}

	private toView(row: ActionRow): IntegrationActionView {
		const action = getMediaAction(row.action);
		return {
			id: row.id,
			action: row.action,
			label: action?.label ?? row.action,
			integrationId: row.integration_id,
			target: row.target,
			actor: row.actor,
			state: row.state as IntegrationActionState,
			message: row.message,
			upstreamCommandId: row.upstream_command_id,
			requestedAt: row.requested_at,
			finishedAt: row.finished_at,
			cooldownRemainingMs: row.integration_id
				? this.cooldownRemainingMs(row.integration_id, row.target_key, action?.cooldownMs ?? 60_000)
				: 0
		};
	}
}

/** Honest upstream error naming (§23) — never a generic "something went wrong". */
export function upstreamErrorMessage(err: unknown): string {
	if (err instanceof ArrAuthError) return 'Authentication failed — upstream rejected the API key';
	if (err instanceof ArrError) {
		if (err.message.includes('timed out')) return 'Upstream command timed out';
		if (err.status === 400) return 'Search command rejected by upstream';
		if (err.status === 404) return 'Command endpoint not found — upstream version unsupported';
		if (err.status !== null) return `Upstream command failed (HTTP ${err.status})`;
		return 'Could not reach the upstream service';
	}
	return err instanceof Error ? err.message : 'Unknown upstream error';
}

// -----------------------------------------------------------------------------
// Singleton
// -----------------------------------------------------------------------------

let instance: ActionsManager | null = null;

export function getActionsManager(): ActionsManager {
	if (!instance) {
		instance = new ActionsManager();
		// §13b: startup reconciliation — the first time this process touches
		// Safe Actions, settle whatever a dead process left in flight. Runs
		// before any execute() and before the audit view reads rows.
		const reconciled = instance.reconcileInterrupted();
		if (reconciled > 0) {
			console.log(
				`[dumbscope] actions: settled ${reconciled} interrupted execution(s) as unconfirmed`
			);
		}
	}
	return instance;
}

/** Test helper. */
export function resetActionsManager(): void {
	instance = null;
}
