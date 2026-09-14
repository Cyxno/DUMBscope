/**
 * DEEL 2 — bounded remediation framework.
 *
 * Pins the safety envelope (brief §36-§62): allowlisted action kinds only,
 * server-resolved targets, preflight gates, one action per target, cooldown +
 * attempt caps, success only after verification (never on HTTP 200), crash
 * recovery for orphaned rows, and a complete audit trail.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
	RemediationManager,
	resetRemediationManager,
	type ActionExecutor,
	type TargetStatus
} from '../src/lib/server/reliability/remediation';
import { getDb } from '../src/lib/server/database/db';

const MIN = 60_000;

function makeExecutor(
	overrides: Partial<ActionExecutor> = {}
): ActionExecutor & { executed: string[]; state: { executed: string[]; fail: boolean } } {
	const state = { executed: [] as string[], fail: false };
	const base: ActionExecutor & {
		executed: string[];
		state: { executed: string[]; fail: boolean };
	} = {
		executed: state.executed,
		state,
		execute: async (target) => {
			if (state.fail) throw new Error('DUMB unreachable');
			state.executed.push(target);
			return true;
		},
		targetStatus: (): TargetStatus => ({
			managed: true,
			running: true,
			restartPending: false,
			pid: 123
		}),
		targetMemoryRss: () => 0.4 * 1024 ** 3,
		activeWorkReliablyVisible: () => true,
		activeWorkDetected: () => false
	};
	return Object.assign(base, overrides);
}

describe('remediation framework', () => {
	let now: number;
	let manager: RemediationManager;
	let executor: ActionExecutor & {
		executed: string[];
		state: { executed: string[]; fail: boolean };
	};

	function request(target = 'NzbWebDAV', overrides = {}) {
		return manager.request({
			kind: 'restart-managed-service',
			target,
			actor: 'qaadmin',
			reason: 'sustained memory anomaly',
			evidence: ['Current 4.4 GB', 'Typical 0.8 GB', '+1.9 GB over 6h'],
			triggerSource: 'manual',
			findingFingerprint: null,
			...overrides
		});
	}

	beforeEach(() => {
		now = 1_750_000_000_000;
		// Test isolation: the SQLite store is per-file, so clear prior actions.
		getDb().prepare('DELETE FROM remediation_actions').run();
		resetRemediationManager();
		manager = new RemediationManager(() => now);
		executor = makeExecutor();
		manager.bindExecutor(executor);
	});

	it('happy path: requested → running → verifying; success only after verification', async () => {
		const result = await request();
		expect(result.state).toBe('verifying');
		expect(executor.executed).toEqual(['NzbWebDAV']);

		// Before post-conditions the action is NOT successful.
		expect(manager.recent()[0]!.state).toBe('verifying');

		manager.verifyPending();
		const done = manager.recent()[0]!;
		expect(done.state).toBe('succeeded');
		expect(done.verification).toContain('verified');
		expect(done.verifiedAt).not.toBeNull();
	});

	it('execute failure (rejected request) records failed — never success', async () => {
		executor.state.fail = true;
		const result = await request();
		expect(result.state).toBe('failed');
		expect(manager.recent()[0]!.state).toBe('failed');
	});

	it('preflight blocks unmanaged targets, pending restarts and cooldown', async () => {
		// Unmanaged target.
		const unmanaged = makeExecutor({
			targetStatus: (): TargetStatus => ({
				managed: false,
				running: true,
				restartPending: false,
				pid: null
			})
		});
		resetRemediationManager();
		manager = new RemediationManager(() => now);
		manager.bindExecutor(unmanaged);
		let result = await request('NotAService');
		expect(result.state).toBe('rejected');
		expect(result.preflight.failures.join(' ')).toContain('not a managed');

		// Restart already pending.
		const pending = makeExecutor({
			targetStatus: (): TargetStatus => ({
				managed: true,
				running: true,
				restartPending: true,
				pid: 5
			})
		});
		resetRemediationManager();
		manager = new RemediationManager(() => now);
		manager.bindExecutor(pending);
		result = await request();
		expect(result.state).toBe('rejected');
		expect(result.preflight.failures.join(' ')).toContain('already pending');
	});

	it('cooldown: second success inside 6h is blocked; after expiry allowed', async () => {
		await request();
		manager.verifyPending();
		expect(manager.recent()[0]!.state).toBe('succeeded');
		// Inside cooldown: rejected.
		now += 60 * MIN;
		const second = await request();
		expect(second.state).toBe('rejected');
		expect(second.preflight.failures.join(' ')).toContain('cooldown');
		// After cooldown: allowed.
		now += 7 * 60 * MIN;
		const third = await request();
		expect(third.state).toBe('verifying');
	});

	it('attempt cap: two executed attempts per 24h, then suspended', async () => {
		await request();
		manager.verifyPending();
		now += 7 * 60 * MIN; // clear cooldown
		await request();
		manager.verifyPending();
		expect(manager.attempts24h('NzbWebDAV')).toBe(2);
		now += 7 * 60 * MIN;
		const third = await request();
		expect(third.state).toBe('rejected');
		expect(third.preflight.failures.join(' ')).toContain('attempt limit');
		const rec = manager.recent()[0]!;
		expect(rec.suspended).toBe(true);
	});

	it('concurrency: a second action while one is active is rejected (409 semantics)', async () => {
		const slow = makeExecutor({
			execute: async () => {
				await new Promise((r) => setTimeout(r, 30));
				return true;
			}
		});
		resetRemediationManager();
		manager = new RemediationManager(() => now);
		manager.bindExecutor(slow);
		const first = request();
		const second = request();
		const [a, b] = await Promise.all([first, second]);
		const states = [a.state, b.state].sort();
		expect(states[0]).toBe('rejected');
	});

	it('verification window expiry yields partially-recovered, never silent success', async () => {
		let running = true;
		const neverRecovers = makeExecutor({
			targetStatus: (): TargetStatus => ({
				managed: true,
				running,
				restartPending: !running,
				pid: null
			})
		});
		resetRemediationManager();
		manager = new RemediationManager(() => now);
		manager.bindExecutor(neverRecovers);
		const result = await request();
		expect(result.state).toBe('verifying');
		running = false; // the process did not come back
		now += 20 * MIN;
		manager.verifyPending();
		expect(manager.recent()[0]!.state).toBe('partially-recovered');
	});

	it('crash recovery: orphaned running row is re-evaluated on boot (§59)', async () => {
		// Simulate a crash: an action row stuck in 'running'.
		getDb()
			.prepare(
				`INSERT INTO remediation_actions (id, kind, target, actor, trigger_source, reason, evidence, state, finding_fingerprint, requested_at)
				 VALUES ('orphan', 'restart-managed-service', 'NzbWebDAV', 'qa', 'manual', 'r', '[]', 'running', NULL, ?)`
			)
			.run(now - 30 * MIN);
		resetRemediationManager();
		manager = new RemediationManager(() => now);
		manager.bindExecutor(executor); // bind triggers recoverOrphans
		const row = manager.recent().find((r) => r.id === 'orphan')!;
		expect(['partially-recovered', 'succeeded']).toContain(row.state);
		expect(row.verification).toBeTruthy();
	});

	it('audit trail records actor, evidence, trigger and verification (§53)', async () => {
		await request();
		manager.verifyPending();
		const row = getDb()
			.prepare('SELECT * FROM remediation_actions ORDER BY requested_at DESC LIMIT 1')
			.get() as {
			actor: string;
			trigger_source: string;
			evidence: string;
			verification: string | null;
			target: string;
		};
		expect(row.actor).toBe('qaadmin');
		expect(row.trigger_source).toBe('manual');
		expect(JSON.parse(row.evidence)).toContain('Typical 0.8 GB');
		expect(row.verification).toContain('verified');
		expect(row.target).toBe('NzbWebDAV');
	});
});
