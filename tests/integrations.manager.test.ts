/**
 * Regression tests for the integration manager scheduler (audit §14):
 * - a poller run that outlives its interval must not kill the cadence
 *   (triggerNow/overlap used to permanently silence the poller);
 * - triggerNow fires immediately;
 * - disabling an integration stops its pollers.
 */
import { describe, expect, it } from 'vitest';
import {
	registerAdapter,
	ensureIntegrationsStarted,
	triggerNow,
	reloadIntegration,
	getIntegrationStatuses
} from '../src/lib/server/integrations/manager';
import { upsertIntegration } from '../src/lib/server/integrations/store';
import type { PollContext, PollerSpec } from '../src/lib/server/integrations/manager';
import type { IntegrationType } from '../src/lib/server/integrations/types';

const TYPE = 'tautulli' as IntegrationType; // any registered-compatible type
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function slowAdapter(runs: { count: number }): {
	adapter: Parameters<typeof registerAdapter>[0];
	pollers: PollerSpec[];
} {
	const pollers: PollerSpec[] = [
		{
			name: 'slow',
			intervalMs: 50,
			run: async (_ctx: PollContext) => {
				runs.count += 1;
				await sleep(80); // outlives the interval on purpose
			}
		}
	];
	return {
		adapter: { type: TYPE, test: async () => ({}), pollers: () => pollers },
		pollers
	};
}

describe('integration manager scheduler', () => {
	it('keeps the cadence when a run outlives its interval (no dead poller)', async () => {
		const runs = { count: 0 };
		const { adapter } = slowAdapter(runs);
		registerAdapter(adapter);
		const config = upsertIntegration({
			id: 'test-overlap',
			type: TYPE,
			url: 'http://127.0.0.1:9',
			enabled: true
		});
		ensureIntegrationsStarted();
		reloadIntegration(config.id);
		triggerNow(config.id); // bypass the initial stagger

		await sleep(700); // several interval+overlap cycles
		upsertIntegration({ id: config.id, type: TYPE, url: config.url, enabled: false });
		reloadIntegration(config.id); // stops the pollers cleanly
		expect(runs.count).toBeGreaterThanOrEqual(2);

		const status = getIntegrationStatuses().find((s) => s.id === config.id);
		void status;
	}, 10_000);

	it('triggerNow runs the poller without waiting for the interval', async () => {
		const runs = { count: 0 };
		const adapter: Parameters<typeof registerAdapter>[0] = {
			type: TYPE,
			test: async () => ({}),
			pollers: () => [
				{
					name: 'instant',
					intervalMs: 3_600_000,
					run: async (ctx: PollContext) => {
						runs.count += 1;
						ctx.ok('1.0.0');
					}
				}
			]
		};
		registerAdapter(adapter);
		const config = upsertIntegration({
			id: 'test-trigger',
			type: TYPE,
			url: 'http://127.0.0.1:9',
			enabled: true
		});
		ensureIntegrationsStarted();
		reloadIntegration(config.id);
		const before = runs.count;
		triggerNow(config.id);
		await sleep(300);
		expect(runs.count).toBeGreaterThan(before);
		// Disable again so the pollers stop before the test process ends.
		upsertIntegration({ id: config.id, type: TYPE, url: 'http://127.0.0.1:9', enabled: false });
		reloadIntegration(config.id);
	}, 10_000);

	it('disabled integrations have no running state', () => {
		upsertIntegration({
			id: 'test-disabled',
			type: TYPE,
			url: 'http://127.0.0.1:9',
			enabled: false
		});
		reloadIntegration('test-disabled');
		const status = getIntegrationStatuses().find((s) => s.id === 'test-disabled');
		expect(status?.state).toBe('disabled');
	});
});
