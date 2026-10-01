/**
 * Safe Actions tests (docs/ACTIONS.md §28): registry allowlist + target
 * validation, manager execution with audit-first rows, per-target cooldowns,
 * multi-instance routing (§18), upstream error naming (§23), bounded
 * follow-up, URL/link building (§2/§24/§26). Uses the real SQLite store plus
 * injected fake Arr clients — same style as remediation.test.ts.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
	MEDIA_ACTIONS,
	capabilitiesForType,
	getMediaAction,
	validateMediaTarget
} from '$lib/server/actions/registry';
import {
	ActionsManager,
	ACTIONS_TUNING,
	getActionsManager,
	resetActionsManager,
	upstreamErrorMessage
} from '$lib/server/actions/manager';
import type { ArrCommandClient } from '$lib/server/actions/manager';
import { ArrAuthError, ArrError } from '$lib/server/integrations/arr/base';
import {
	clearApiKey,
	deleteIntegration,
	setApiKey,
	upsertIntegration
} from '$lib/server/integrations/store';
import { getDb } from '$lib/server/database/db';
import { sonarrSeriesUrl, radarrMovieUrl, resolveWebUrl } from '$lib/utils/service-links';

// ---------------------------------------------------------------------------
// Fake Arr command client (records everything, no HTTP)
// ---------------------------------------------------------------------------

class FakeClient implements ArrCommandClient {
	calls: { command: string; args: unknown[] }[] = [];
	/** Statuses returned by commandStatus in order; last one repeats. */
	statuses: string[] = [];
	throwOnCommand: Error | null = null;

	async record(command: string, args: unknown[]): Promise<{ id?: number; status?: string }> {
		this.calls.push({ command, args });
		if (this.throwOnCommand) throw this.throwOnCommand;
		return { id: 4242, status: 'queued' };
	}
	commandEpisodeSearch(...args: Parameters<ArrCommandClient['commandEpisodeSearch']>) {
		return this.record('EpisodeSearch', args);
	}
	commandSeasonSearch(...args: Parameters<ArrCommandClient['commandSeasonSearch']>) {
		return this.record('SeasonSearch', args);
	}
	commandSeriesSearch(...args: Parameters<ArrCommandClient['commandSeriesSearch']>) {
		return this.record('SeriesSearch', args);
	}
	commandRefreshSeries(...args: Parameters<ArrCommandClient['commandRefreshSeries']>) {
		return this.record('RefreshSeries', args);
	}
	commandMoviesSearch(...args: Parameters<ArrCommandClient['commandMoviesSearch']>) {
		return this.record('MoviesSearch', args);
	}
	commandRefreshMovie(...args: Parameters<ArrCommandClient['commandRefreshMovie']>) {
		return this.record('RefreshMovie', args);
	}
	async commandStatus(commandId: number) {
		return { id: commandId, status: this.statuses[this.statuses.length - 1] ?? 'queued' };
	}
}

function makeHarness(): {
	manager: ActionsManager;
	clients: Map<string, FakeClient>;
	follows: (() => void)[];
	flushFollows: () => Promise<void>;
	now: () => number;
	advance: (ms: number) => void;
} {
	const clients = new Map<string, FakeClient>();
	const follows: (() => void)[] = [];
	let current = 1_700_000_000_000;
	const manager = new ActionsManager({
		now: () => current,
		clientFactory: (config) => {
			let client = clients.get(config.id);
			if (!client) {
				client = new FakeClient();
				clients.set(config.id, client);
			}
			return client;
		},
		scheduleFollow: (fn) => follows.push(fn)
	});
	const flushFollows = async () => {
		while (follows.length > 0) {
			const fn = follows.shift()!;
			fn();
			await new Promise((resolve) => setImmediate(resolve));
		}
	};
	return {
		manager,
		clients,
		follows,
		flushFollows,
		now: () => current,
		advance: (ms) => {
			current += ms;
		}
	};
}

function seedIntegration(id: string, type: 'sonarr' | 'radarr', enabled = true): void {
	deleteIntegration(id);
	upsertIntegration({ id, type, url: `http://127.0.0.1:1`, enabled });
	setApiKey(id, 'test-key-123');
}

beforeEach(() => {
	// Start every test from a clean actions table.
	getDb().prepare('DELETE FROM integration_actions').run();
});

// ---------------------------------------------------------------------------
// Registry: allowlist + structural target validation
// ---------------------------------------------------------------------------

describe('actions registry', () => {
	it('exposes exactly the five allowlisted media commands', () => {
		expect(MEDIA_ACTIONS.map((a) => a.id).sort()).toEqual(
			[
				'sonarr.searchEpisode',
				'sonarr.searchSeason',
				'sonarr.refreshSeries',
				'radarr.searchMovie',
				'radarr.refreshMovie'
			].sort()
		);
		expect(getMediaAction('service.restart')).toBeNull();
		expect(getMediaAction('MoviesSearch')).toBeNull();
	});

	it('rejects malformed targets per action', () => {
		const search = getMediaAction('sonarr.searchEpisode')!;
		expect(validateMediaTarget(search, null).ok).toBe(false);
		expect(validateMediaTarget(search, { episodeIds: [] }).ok).toBe(false);
		expect(validateMediaTarget(search, { episodeIds: [1.5] }).ok).toBe(false);
		expect(validateMediaTarget(search, { episodeIds: [-3] }).ok).toBe(false);
		expect(validateMediaTarget(search, { episodeIds: ['1'] }).ok).toBe(false);
		expect(validateMediaTarget(search, { seriesId: 3 }).ok).toBe(false);

		const season = getMediaAction('sonarr.searchSeason')!;
		expect(validateMediaTarget(season, { seriesId: 3 }).ok).toBe(false);
		expect(validateMediaTarget(season, { seriesId: 3, seasonNumber: -1 }).ok).toBe(false);
		expect(validateMediaTarget(season, { seriesId: 3, seasonNumber: 5000 }).ok).toBe(false);

		const refresh = getMediaAction('sonarr.refreshSeries')!;
		expect(validateMediaTarget(refresh, {}).ok).toBe(false);
		expect(validateMediaTarget(refresh, { seriesId: 0 }).ok).toBe(false);

		const movie = getMediaAction('radarr.searchMovie')!;
		expect(validateMediaTarget(movie, { movieId: '9' }).ok).toBe(false);
	});

	it('accepts valid targets and derives a stable target key', () => {
		const search = getMediaAction('sonarr.searchEpisode')!;
		const ok = validateMediaTarget(search, { episodeIds: [30, 10, 30] });
		expect(ok).toEqual({
			ok: true,
			target: { episodeIds: [10, 30] },
			targetKey: 'episode:10,30'
		});

		const season = getMediaAction('sonarr.searchSeason')!;
		expect(validateMediaTarget(season, { seriesId: 3, seasonNumber: 2 })).toEqual({
			ok: true,
			target: { seriesId: 3, seasonNumber: 2 },
			targetKey: 'season:3:2'
		});
	});

	it('publishes capabilities per integration type (§19)', () => {
		const sonarr = capabilitiesForType('sonarr');
		expect(sonarr).toMatchObject({
			canSearchEpisode: true,
			canSearchSeason: true,
			canRefreshSeries: true,
			canSearchMovie: false,
			canRefreshMovie: false
		});
		const radarr = capabilitiesForType('radarr');
		expect(radarr.canSearchMovie).toBe(true);
		expect(radarr.canSearchEpisode).toBe(false);
		// Everything else: no media commands.
		expect(capabilitiesForType('plex')).toEqual({
			canSearchEpisode: false,
			canSearchSeason: false,
			canRefreshSeries: false,
			canSearchMovie: false,
			canRefreshMovie: false
		});
	});
});

// ---------------------------------------------------------------------------
// Manager: execution, audit, cooldown, routing, follow-up
// ---------------------------------------------------------------------------

describe('actions manager', () => {
	it('executes a targeted episode search audit-first and follows to completed', async () => {
		const h = makeHarness();
		seedIntegration('sonarr-a', 'sonarr');
		const result = await h.manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-a',
			target: { episodeIds: [101] },
			actor: 'admin'
		});
		expect(result.state).toBe('accepted');
		expect(result.upstreamCommandId).toBe(4242);
		expect(result.message).toContain('Search requested');
		// The exact wrapper was called with the exact ids (§4).
		const client = h.clients.get('sonarr-a')!;
		expect(client.calls).toEqual([{ command: 'EpisodeSearch', args: [[101]] }]);

		// Audit row exists while the command is still running (audit-first).
		const pending = h.manager.get(result.id);
		expect(pending?.state).toBe('accepted');
		expect(pending?.actor).toBe('admin');

		h.clients.get('sonarr-a')!.statuses = ['started', 'completed'];
		await h.flushFollows();
		const done = h.manager.get(result.id);
		expect(done?.state).toBe('completed');
		expect(done?.finishedAt).not.toBeNull();
	});

	it('routes to the exact integration instance — no first-match (§18)', async () => {
		const h = makeHarness();
		seedIntegration('sonarr-main', 'sonarr');
		seedIntegration('sonarr-anime', 'sonarr');
		await h.manager.execute({
			actionId: 'sonarr.refreshSeries',
			integrationId: 'sonarr-anime',
			target: { seriesId: 7 },
			actor: 'admin'
		});
		expect(h.clients.get('sonarr-main')).toBeUndefined();
		expect(h.clients.get('sonarr-anime')!.calls[0]?.command).toBe('RefreshSeries');
	});

	it('refuses cross-type actions against an instance (§18)', async () => {
		const h = makeHarness();
		seedIntegration('sonarr-main', 'sonarr');
		const result = await h.manager.execute({
			actionId: 'radarr.searchMovie',
			integrationId: 'sonarr-main',
			target: { movieId: 9 },
			actor: 'admin'
		});
		expect(result.state).toBe('rejected');
		expect(result.message).toContain('radarr');
	});

	it('rejects unknown, disabled and keyless integrations', async () => {
		const h = makeHarness();
		seedIntegration('sonarr-b', 'sonarr');
		clearApiKey('sonarr-b');
		const noKey = await h.manager.execute({
			actionId: 'sonarr.refreshSeries',
			integrationId: 'sonarr-b',
			target: { seriesId: 1 },
			actor: 'admin'
		});
		expect(noKey.state).toBe('rejected');
		expect(noKey.message).toContain('Authentication failed');

		const disabled = makeHarness();
		seedIntegration('sonarr-c', 'sonarr', false);
		const off = await disabled.manager.execute({
			actionId: 'sonarr.refreshSeries',
			integrationId: 'sonarr-c',
			target: { seriesId: 1 },
			actor: 'admin'
		});
		expect(off.state).toBe('rejected');

		const ghost = await h.manager.execute({
			actionId: 'sonarr.refreshSeries',
			integrationId: 'sonarr-ghost',
			target: { seriesId: 1 },
			actor: 'admin'
		});
		expect(ghost.state).toBe('rejected');
		expect(ghost.message).toBe('Unknown integration instance');
	});

	it('enforces the per-target cooldown and reports remaining time', async () => {
		const h = makeHarness();
		seedIntegration('sonarr-cool', 'sonarr');
		const first = await h.manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-cool',
			target: { episodeIds: [555] },
			actor: 'admin'
		});
		expect(first.state).toBe('accepted');

		const spam = await h.manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-cool',
			target: { episodeIds: [555] },
			actor: 'admin'
		});
		expect(spam.state).toBe('rejected');
		expect(spam.message).toContain('Cooldown');
		expect(spam.cooldownRemainingMs).toBeGreaterThan(0);
		// Rejected attempts never start a cooldown of their own.
		expect(spam.upstreamCommandId).toBeNull();

		// A different episode of the same instance is not blocked.
		const other = await h.manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-cool',
			target: { episodeIds: [556] },
			actor: 'admin'
		});
		expect(other.state).toBe('accepted');

		// After the cooldown window the same target is allowed again.
		h.advance(61_000);
		const later = await h.manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-cool',
			target: { episodeIds: [555] },
			actor: 'admin'
		});
		expect(later.state).toBe('accepted');
	});

	it('maps upstream failures to honest messages (§23)', async () => {
		const h = makeHarness();
		seedIntegration('sonarr-err', 'sonarr');
		const client = (() => {
			// Pre-seed the client so the error is configured before execute().
			const c = new FakeClient();
			h.clients.set('sonarr-err', c);
			return c;
		})();

		client.throwOnCommand = new ArrAuthError();
		const auth = await h.manager.execute({
			actionId: 'radarr.searchMovie',
			integrationId: 'sonarr-err', // wrong type on purpose → rejected earlier
			target: { movieId: 1 },
			actor: 'admin'
		});
		expect(auth.state).toBe('rejected');

		client.throwOnCommand = new ArrError('Arr request failed (HTTP 400)', 400);
		const rejected = await h.manager.execute({
			actionId: 'sonarr.searchSeason',
			integrationId: 'sonarr-err',
			target: { seriesId: 1, seasonNumber: 1 },
			actor: 'admin'
		});
		expect(rejected.state).toBe('failed');
		expect(rejected.message).toContain('rejected by upstream');

		client.throwOnCommand = new ArrError('Arr request timed out', null);
		const timeout = await h.manager.execute({
			actionId: 'sonarr.searchSeason',
			integrationId: 'sonarr-err',
			target: { seriesId: 1, seasonNumber: 2 },
			actor: 'admin'
		});
		expect(timeout.state).toBe('failed');
		expect(timeout.message).toContain('timed out');
		// The audit row records the failure.
		expect(h.manager.recent().filter((r) => r.state === 'failed').length).toBeGreaterThanOrEqual(2);
	});

	it('settles unconfirmed when upstream never reports a final state', async () => {
		const h = makeHarness();
		seedIntegration('sonarr-slow', 'sonarr');
		const result = await h.manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-slow',
			target: { episodeIds: [42] },
			actor: 'admin'
		});
		h.clients.get('sonarr-slow')!.statuses = ['queued'];
		// Follow polls stay 'queued' — the bound must still terminate.
		for (let i = 0; i < ACTIONS_TUNING.followMaxPolls + 1; i++) await h.flushFollows();
		const row = h.manager.get(result.id);
		expect(row?.state).toBe('unconfirmed');
		expect(row?.message).toContain('follow window');
	});

	it('records a follow-up upstream command failure', async () => {
		const h = makeHarness();
		seedIntegration('radarr-f', 'radarr');
		const result = await h.manager.execute({
			actionId: 'radarr.searchMovie',
			integrationId: 'radarr-f',
			target: { movieId: 9 },
			actor: 'admin'
		});
		h.clients.get('radarr-f')!.statuses = ['failed'];
		await h.flushFollows();
		expect(h.manager.get(result.id)?.state).toBe('failed');
	});

	it('keeps the recent audit bounded, secret-free and replayable (§15)', async () => {
		const h = makeHarness();
		seedIntegration('sonarr-audit', 'sonarr');
		await h.manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-audit',
			target: { episodeIds: [1] },
			actor: 'admin'
		});
		const rows = h.manager.recent();
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(JSON.stringify(row)).not.toContain('test-key-123');
			expect(row.actor.length).toBeGreaterThan(0);
			expect(row.requestedAt).toBeGreaterThan(0);
		}
	});
});

// ---------------------------------------------------------------------------
// Atomic duplicate suppression (§13a) — the claim is decided at the SQLite
// layer: one BEGIN IMMEDIATE transaction around cooldown check, in-flight
// dedupe check and audit-first INSERT, backed by a partial UNIQUE index on
// active claims (migration v11). Regression: 8 concurrent identical requests
// must produce exactly ONE upstream command, not eight.
// ---------------------------------------------------------------------------

describe('atomic duplicate suppression (§13a)', () => {
	/**
	 * Deterministic concurrency barrier: arms `n` identical executions and
	 * releases them together, so they interleave exactly like simultaneous
	 * HTTP requests — every caller is in flight before any upstream answer
	 * arrives.
	 */
	async function raceIdentical(
		h: ReturnType<typeof makeHarness>,
		integrationId: string,
		n: number
	): Promise<Awaited<ReturnType<ActionsManager['execute']>>[]> {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const attempts = Array.from({ length: n }, () => {
			return (async () => {
				await gate;
				return h.manager.execute({
					actionId: 'sonarr.searchEpisode',
					integrationId,
					target: { episodeIds: [42] },
					actor: 'admin'
				});
			})();
		});
		release();
		return Promise.all(attempts);
	}

	it.each([2, 8, 20])(
		'%i concurrent identical requests → exactly one upstream call, losers rejected deterministically',
		async (n) => {
			const h = makeHarness();
			seedIntegration('sonarr-race', 'sonarr');
			const results = await raceIdentical(h, 'sonarr-race', n);

			const accepted = results.filter((r) => r.state === 'accepted');
			const rejected = results.filter((r) => r.state === 'rejected');
			expect(accepted).toHaveLength(1);
			expect(rejected).toHaveLength(n - 1);
			expect(h.clients.get('sonarr-race')!.calls).toHaveLength(1);
			expect(h.clients.get('sonarr-race')!.calls[0]?.command).toBe('EpisodeSearch');

			// Losers: deterministic conflict result — same message, no upstream
			// command id, no cooldown claim of their own.
			for (const loser of rejected) {
				expect(loser.message).toBe('An identical action is already in progress for this target');
				expect(loser.upstreamCommandId).toBeNull();
				expect(loser.cooldownRemainingMs).toBe(0);
			}
			// Every attempt is audited (audit-first includes rejections), and no
			// row leaks secrets: actor + ids + plain language only. The winner
			// has already settled to 'accepted' (its upstream answer arrived).
			const rows = getDb()
				.prepare('SELECT state, target_key, actor FROM integration_actions')
				.all() as { state: string; target_key: string; actor: string }[];
			expect(rows).toHaveLength(n);
			expect(rows.filter((r) => r.state === 'accepted')).toHaveLength(1);
			expect(rows.filter((r) => r.state === 'rejected')).toHaveLength(n - 1);
			for (const row of rows) {
				expect(row.target_key).toBe('sonarr.searchEpisode:episode:42');
				expect(row.actor).toBe('admin');
			}
		}
	);

	it('the partial UNIQUE index is the structural backstop — a second active claim cannot exist', () => {
		const h = makeHarness();
		seedIntegration('sonarr-claim', 'sonarr');
		const now = h.now();
		const insert = (id: string) =>
			getDb()
				.prepare(
					`INSERT INTO integration_actions
						(id, action, integration_id, target, target_key, actor, state, requested_at)
					 VALUES (?, 'sonarr.searchEpisode', 'sonarr-claim', 'episode-42', 'sonarr.searchEpisode:episode-42', 'admin', 'requested', ?)`
				)
				.run(id, now);
		insert('first');
		expect(() => insert('second')).toThrow(/UNIQUE constraint failed/);
	});

	it('a live in-flight claim blocks a new request even past a manual INSERT (check + index agree)', async () => {
		const h = makeHarness();
		seedIntegration('sonarr-live', 'sonarr');
		const first = await h.manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-live',
			target: { episodeIds: [7] },
			actor: 'admin'
		});
		expect(first.state).toBe('accepted');
		// The accepted row is inside the follow window; the cooldown also
		// counts it (requested_at starts the window). Either way: no upstream.
		const dup = await h.manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-live',
			target: { episodeIds: [7] },
			actor: 'admin'
		});
		expect(dup.state).toBe('rejected');
		expect(h.clients.get('sonarr-live')!.calls).toHaveLength(1);
	});

	it('rejections carry the claimed integration/action for the audit trail', async () => {
		const h = makeHarness();
		await h.manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-ghost',
			target: { episodeIds: [1] },
			actor: 'admin'
		});
		const rows = getDb()
			.prepare(
				"SELECT action, integration_id, target_key, state FROM integration_actions WHERE state = 'rejected'"
			)
			.all() as { action: string; integration_id: string; target_key: string; state: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0]).toEqual({
			action: 'sonarr.searchEpisode',
			integration_id: 'sonarr-ghost',
			target_key: 'sonarr.searchEpisode:episode:1',
			state: 'rejected'
		});
	});
});

// ---------------------------------------------------------------------------
// Cooldown semantics (§13a interaction) — what a repeat after each outcome
// does. The six-hour remediation cooldown (reliability layer) is untouched.
// ---------------------------------------------------------------------------

describe('action repeat semantics per prior outcome', () => {
	it('simultaneous duplicate → rejected as in progress; after success → cooldown; after expiry → allowed', async () => {
		const h = makeHarness();
		seedIntegration('sonarr-sem', 'sonarr');
		const first = await h.manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-sem',
			target: { episodeIds: [9] },
			actor: 'admin'
		});
		expect(first.state).toBe('accepted');

		// 1. Simultaneous duplicate (still in the follow window): in-progress.
		const dup = await h.manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-sem',
			target: { episodeIds: [9] },
			actor: 'admin'
		});
		expect(dup.state).toBe('rejected');

		// 2. Repeat immediately after upstream success: cooldown.
		h.clients.get('sonarr-sem')!.statuses = ['started', 'completed'];
		await h.flushFollows();
		expect(
			getDb().prepare('SELECT state FROM integration_actions WHERE id = ?').get(first.id)
		).toMatchObject({ state: 'completed' });
		const afterSuccess = await h.manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-sem',
			target: { episodeIds: [9] },
			actor: 'admin'
		});
		expect(afterSuccess.state).toBe('rejected');
		expect(afterSuccess.message).toContain('Cooldown');

		// 3. Repeat after the cooldown expired: allowed again.
		h.advance(61_000);
		const later = await h.manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-sem',
			target: { episodeIds: [9] },
			actor: 'admin'
		});
		expect(later.state).toBe('accepted');
	});

	it('repeat after upstream failure is allowed immediately — a failed attempt starts no cooldown', async () => {
		seedIntegration('sonarr-fail', 'sonarr');
		const client = new FakeClient();
		let throwing = true;
		const throwingClient: ArrCommandClient = {
			commandStatus: (id) => client.commandStatus(id),
			commandEpisodeSearch: async (...args) => {
				if (throwing) throw new Error('connection refused');
				return client.commandEpisodeSearch(...args);
			},
			commandSeasonSearch: (...args) => client.commandSeasonSearch(...args),
			commandSeriesSearch: (...args) => client.commandSeriesSearch(...args),
			commandRefreshSeries: (...args) => client.commandRefreshSeries(...args),
			commandMoviesSearch: (...args) => client.commandMoviesSearch(...args),
			commandRefreshMovie: (...args) => client.commandRefreshMovie(...args)
		};
		const manager = new ActionsManager({ clientFactory: () => throwingClient });

		const first = await manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-fail',
			target: { episodeIds: [5] },
			actor: 'admin'
		});
		expect(first.state).toBe('failed');

		throwing = false;
		const retry = await manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-fail',
			target: { episodeIds: [5] },
			actor: 'admin'
		});
		expect(retry.state).toBe('accepted');
		expect(client.calls.filter((c) => c.command === 'EpisodeSearch')).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Startup reconciliation (§13b) — rows orphaned by a dead process settle to
// `unconfirmed`, never "failed", never re-executed, fresh + terminal untouched.
// ---------------------------------------------------------------------------

describe('startup reconciliation (§13b)', () => {
	function seedRow(overrides: {
		id: string;
		state: string;
		ageMs: number;
		upstreamCommandId?: number | null;
		finishedAt?: number | null;
		message?: string | null;
	}): void {
		const now = 1_700_000_000_000;
		getDb()
			.prepare(
				`INSERT INTO integration_actions
					(id, action, integration_id, target, target_key, actor, state, message, upstream_command_id, requested_at, finished_at)
				 VALUES (?, 'sonarr.searchEpisode', 'sonarr-recon', ?, ?, 'admin', ?, ?, ?, ?, ?)`
			)
			.run(
				overrides.id,
				`episode:${overrides.id}`,
				`sonarr.searchEpisode:episode:${overrides.id}`,
				overrides.state,
				overrides.message ?? null,
				overrides.upstreamCommandId ?? null,
				now - overrides.ageMs,
				overrides.finishedAt ?? null
			);
	}

	function rowOf(id: string): {
		state: string;
		message: string | null;
		upstream_command_id: number | null;
		finished_at: number | null;
	} {
		return getDb()
			.prepare(
				'SELECT state, message, upstream_command_id, finished_at FROM integration_actions WHERE id = ?'
			)
			.get(id) as never;
	}

	it('settles stale requested/accepted rows to unconfirmed — fresh and terminal rows untouched', () => {
		const h = makeHarness();
		seedRow({ id: 'stale-requested', state: 'requested', ageMs: 10 * 60_000 });
		seedRow({
			id: 'stale-accepted',
			state: 'accepted',
			ageMs: 10 * 60_000,
			upstreamCommandId: 4242,
			message: 'Search requested (command 4242)'
		});
		seedRow({ id: 'fresh-requested', state: 'requested', ageMs: 5_000 });
		seedRow({
			id: 'done',
			state: 'completed',
			ageMs: 10 * 60_000,
			finishedAt: h.now() - 9 * 60_000,
			message: 'done'
		});
		seedRow({
			id: 'failed-row',
			state: 'failed',
			ageMs: 10 * 60_000,
			finishedAt: h.now() - 9 * 60_000,
			message: 'boom'
		});
		seedRow({
			id: 'rejected-row',
			state: 'rejected',
			ageMs: 10 * 60_000,
			finishedAt: h.now() - 9 * 60_000,
			message: 'no'
		});
		seedRow({
			id: 'unconfirmed-row',
			state: 'unconfirmed',
			ageMs: 10 * 60_000,
			finishedAt: h.now() - 9 * 60_000,
			message: 'earlier window'
		});

		const settled = h.manager.reconcileInterrupted(h.now());
		expect(settled).toBe(2);

		const staleReq = rowOf('stale-requested');
		expect(staleReq.state).toBe('unconfirmed');
		expect(staleReq.message).toBe('Interrupted by restart before a final state was recorded');
		expect(staleReq.finished_at).toBe(h.now());

		const staleAcc = rowOf('stale-accepted');
		expect(staleAcc.state).toBe('unconfirmed');
		// The recorded upstream command id survives — evidence, not fabrication.
		expect(staleAcc.upstream_command_id).toBe(4242);
		expect(staleAcc.finished_at).toBe(h.now());

		expect(rowOf('fresh-requested').state).toBe('requested');
		expect(rowOf('done').state).toBe('completed');
		expect(rowOf('failed-row').state).toBe('failed');
		expect(rowOf('rejected-row').state).toBe('rejected');
		const untouched = rowOf('unconfirmed-row');
		expect(untouched.state).toBe('unconfirmed');
		expect(untouched.message).toBe('earlier window');

		// Idempotent: a second pass matches nothing.
		expect(h.manager.reconcileInterrupted(h.now())).toBe(0);
	});

	it('never re-executes a settled action — no client is constructed, no upstream call happens', () => {
		let clientsBuilt = 0;
		const manager = new ActionsManager({
			clientFactory: () => {
				clientsBuilt++;
				return new FakeClient();
			}
		});
		getDb()
			.prepare(
				`INSERT INTO integration_actions
					(id, action, integration_id, target, target_key, actor, state, requested_at)
				 VALUES ('orphan', 'sonarr.searchEpisode', 'sonarr-recon', 'episode:3', 'sonarr.searchEpisode:episode:3', 'admin', 'requested', ?)`
			)
			.run(Date.now() - 10 * 60_000);
		const settled = manager.reconcileInterrupted();
		expect(settled).toBe(1);
		expect(clientsBuilt).toBe(0);
	});

	it('the singleton reconciles on first creation, and the claim is unblocked afterwards', async () => {
		resetActionsManager();
		getDb().prepare('DELETE FROM integration_actions').run();
		seedIntegration('sonarr-recon', 'sonarr');
		getDb()
			.prepare(
				`INSERT INTO integration_actions
					(id, action, integration_id, target, target_key, actor, state, requested_at)
				 VALUES ('orphan-block', 'sonarr.searchEpisode', 'sonarr-recon', 'episode:3', 'sonarr.searchEpisode:episode:3', 'admin', 'requested', ?)`
			)
			.run(Date.now() - 10 * 60_000);

		// First touch of the subsystem in this "process": reconciliation runs
		// before any execute.
		const manager = getActionsManager();
		expect(rowOf('orphan-block').state).toBe('unconfirmed');

		// F1 ↔ F2 interaction: the settled orphan no longer blocks a fresh
		// request for the same logical action. The singleton's default client
		// factory points at the unreachable integration URL, so the attempt
		// fails fast upstream — the point is that it got PAST the claim (a
		// blocked duplicate would be 'rejected', never reach upstream).
		const result = await manager.execute({
			actionId: 'sonarr.searchEpisode',
			integrationId: 'sonarr-recon',
			target: { episodeIds: [3] },
			actor: 'admin'
		});
		expect(result.state).toBe('failed');
		resetActionsManager();
	});
});

// ---------------------------------------------------------------------------
// Upstream error naming
// ---------------------------------------------------------------------------

describe('upstreamErrorMessage', () => {
	it('names the known causes', () => {
		expect(upstreamErrorMessage(new ArrAuthError())).toContain('Authentication failed');
		expect(upstreamErrorMessage(new ArrError('Arr request timed out', null))).toContain(
			'timed out'
		);
		expect(upstreamErrorMessage(new ArrError('Arr request failed (HTTP 404)', 404))).toContain(
			'unsupported'
		);
		expect(upstreamErrorMessage(new ArrError('x', 503))).toContain('503');
		expect(upstreamErrorMessage(new Error('boom'))).toBe('boom');
	});
});

// ---------------------------------------------------------------------------
// Client link building (§2/§24/§26)
// ---------------------------------------------------------------------------

describe('service links', () => {
	it('resolves internal/public/auto base URLs and rejects non-http schemes', () => {
		const config = { url: 'http://192.168.1.50:8989', publicUrl: 'https://sonarr.example.com' };
		expect(resolveWebUrl(config, 'internal', 'sonarr.example.com')).toBe(
			'http://192.168.1.50:8989'
		);
		expect(resolveWebUrl(config, 'public', '192.168.1.50:8989')).toBe('https://sonarr.example.com');
		// auto: off-host browser → public, on-host → internal.
		expect(resolveWebUrl(config, 'auto', 'box.local')).toBe('https://sonarr.example.com');
		expect(resolveWebUrl(config, 'auto', '192.168.1.50:8989')).toBe('http://192.168.1.50:8989');
		// No public URL configured → always internal.
		expect(resolveWebUrl({ url: 'http://a:1', publicUrl: null }, 'public', 'x')).toBe('http://a:1');
		expect(resolveWebUrl({ url: 'javascript:alert(1)', publicUrl: null }, 'auto', 'x')).toBeNull();
	});

	it('builds deep links only from safe ids, falling back to the root', () => {
		expect(sonarrSeriesUrl('http://a:8989', 'dark-meadow')).toBe(
			'http://a:8989/series/dark-meadow'
		);
		expect(sonarrSeriesUrl('http://a:8989', '../etc/passwd')).toBe('http://a:8989');
		expect(sonarrSeriesUrl('http://a:8989', null)).toBe('http://a:8989');
		expect(sonarrSeriesUrl(null, 'dark-meadow')).toBeNull();
		expect(radarrMovieUrl('http://b:7878', 424242)).toBe('http://b:7878/movie/424242');
		expect(radarrMovieUrl('http://b:7878', null)).toBe('http://b:7878');
		expect(radarrMovieUrl(null, 1)).toBeNull();
	});
});

// Singleton hygiene for other suites.
resetActionsManager();
