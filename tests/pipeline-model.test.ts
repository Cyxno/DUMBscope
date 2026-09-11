/**
 * PipelineViewModel tests: stage mapping, honest statuses, friendly naming,
 * infrastructure hiding, failure propagation and stale semantics.
 * These lock in the UX semantics of the pipeline redesign (ux/pipeline-overhaul).
 */
import { describe, expect, it } from 'vitest';
import {
	buildPipelineModel,
	pipelineStatusFor,
	stageForCategory,
	PIPELINE_STAGES,
	type PipelineModelInput
} from '../src/lib/pipeline/model';
import type { PipelineCategory, TopologyNode } from '$lib/types';

function node(
	overrides: Partial<TopologyNode> & { key: string; category: PipelineCategory }
): TopologyNode {
	return {
		name: overrides.key,
		health: 'healthy',
		runState: 'running',
		known: true,
		...overrides
	};
}

function build(nodes: TopologyNode[], extra: Partial<PipelineModelInput> = {}) {
	return buildPipelineModel({ nodes, managedKeys: [], ...extra });
}

describe('pipeline stage mapping', () => {
	it('maps every internal category to a user-facing stage', () => {
		expect(stageForCategory('request')).toBe('requests');
		expect(stageForCategory('manager')).toBe('automation');
		expect(stageForCategory('indexer')).toBe('automation');
		expect(stageForCategory('discovery')).toBe('automation');
		expect(stageForCategory('debrid')).toBe('acquisition');
		expect(stageForCategory('usenet')).toBe('acquisition');
		expect(stageForCategory('import')).toBe('acquisition');
		expect(stageForCategory('acquisition')).toBe('acquisition');
		expect(stageForCategory('bridge')).toBe('storage');
		expect(stageForCategory('mount')).toBe('storage');
		expect(stageForCategory('storage')).toBe('storage');
		expect(stageForCategory('media-server')).toBe('media');
		expect(stageForCategory('subtitles')).toBe('supporting');
		expect(stageForCategory('analytics')).toBe('supporting');
		expect(stageForCategory('auxiliary')).toBe('supporting');
		expect(stageForCategory('core')).toBe('infrastructure');
		expect(stageForCategory('database')).toBe('infrastructure');
	});

	it('hides infrastructure (core, database, gateway) from the flow', () => {
		const model = build([
			node({ key: 'dumb_frontend', name: 'dumb frontend', category: 'core' }),
			node({ key: 'postgres', name: 'PostgreSQL 16', category: 'database' }),
			node({
				key: 'traefik',
				name: 'traefik',
				category: 'auxiliary',
				known: false,
				runState: 'unknown',
				health: 'unknown'
			}),
			node({ key: 'plex', name: 'Plex Media Server', category: 'media-server' })
		]);
		expect(model.stages.map((s) => s.id)).toEqual(['media']);
		expect(model.infrastructure.map((s) => s.key)).toContain('dumb_frontend');
		expect(model.infrastructure.map((s) => s.key)).toContain('postgres');
		expect(model.infrastructure.map((s) => s.key)).toContain('traefik');
	});

	it('keeps running unknown-category services in supporting', () => {
		const model = build([
			node({ key: 'maintainerr', name: 'maintainerr', category: 'auxiliary', known: false })
		]);
		expect(model.supporting?.services.map((s) => s.key)).toEqual(['maintainerr']);
	});

	it('moves never-reported unmanaged entries out of supporting into infrastructure', () => {
		const model = build([
			node({
				key: 'cli_battery',
				name: 'cli_battery',
				category: 'auxiliary',
				known: false,
				runState: 'unknown',
				health: 'unknown'
			})
		]);
		expect(model.supporting).toBeNull();
		expect(model.infrastructure.map((s) => s.key)).toEqual(['cli_battery']);
	});

	it('omits empty stages from the flow', () => {
		const model = build([
			node({ key: 'plex', name: 'Plex Media Server', category: 'media-server' }),
			node({ key: 'decypharr', name: 'Decypharr', category: 'debrid' })
		]);
		// requests, automation and storage have no services and must not render.
		expect(model.stages.map((s) => s.id)).toEqual(['acquisition', 'media']);
		expect(PIPELINE_STAGES).toContain('requests');
	});

	it('counts configured-but-not-running entries per stage instead of drawing them', () => {
		const model = build([
			node({ key: 'sonarr', name: 'sonarr instances Default', category: 'manager' }),
			node({
				key: 'lidarr',
				name: 'lidarr instances Default',
				category: 'manager',
				runState: 'unknown',
				health: 'unknown'
			}),
			node({
				key: 'whisparr',
				name: 'whisparr instances Default',
				category: 'manager',
				runState: 'unknown',
				health: 'unknown'
			})
		]);
		const automation = model.stages[0]!;
		expect(automation.id).toBe('automation');
		expect(automation.services.map((s) => s.key)).toEqual(['sonarr']);
		expect(automation.notRunning.map((s) => s.key)).toEqual(['lidarr', 'whisparr']);
	});
});

describe('pipeline status semantics', () => {
	it('treats a running process without health probe as running, not unknown', () => {
		const status = pipelineStatusFor({ health: 'unknown', runState: 'running' });
		expect(status).toBe('running');
	});

	it('keeps a stopped process visually offline but present', () => {
		const model = build([
			node({ key: 'plex', name: 'plex', category: 'media-server', runState: 'stopped' })
		]);
		expect(model.stages[0]!.services[0]!.status).toBe('offline');
	});

	it('does not let running-unverified make a stage look unhealthy', () => {
		const model = build([
			node({ key: 'zilean', name: 'zilean', category: 'discovery', health: 'unknown' })
		]);
		expect(model.stages[0]!.status).toBe('running');
	});

	it('marks everything stale when the connection is lost', () => {
		const model = build(
			[
				node({ key: 'sonarr', name: 'sonarr', category: 'manager' }),
				node({ key: 'plex', name: 'plex', category: 'media-server' })
			],
			{ stale: true }
		);
		expect(model.stale).toBe(true);
		for (const stage of model.stages) {
			expect(stage.status).toBe('stale');
			for (const service of stage.services) expect(service.status).toBe('stale');
		}
	});
});

describe('pipeline naming', () => {
	it('uses catalog display names and never truncates', () => {
		const model = build([
			node({
				key: 'sonarr',
				name: 'sonarr instances Default',
				category: 'manager'
			}),
			node({
				key: 'sonarr2',
				name: 'sonarr instances An Extremely Long Instance Name That Keeps Going',
				category: 'manager'
			})
		]);
		const names = model.stages[0]!.services.map((s) => s.name);
		expect(names).toContain('Sonarr');
		// No ellipsis truncation anywhere: full names always survive the model.
		for (const stage of model.stages)
			for (const service of stage.services) expect(service.name.includes('…')).toBe(false);
	});

	it('keeps meaningful instance labels and drops the generic "Default"', () => {
		const model = build([
			node({ key: 'zurg', name: 'zurg instances RealDebrid', category: 'bridge' }),
			node({ key: 'sonarr', name: 'sonarr instances Default', category: 'manager' })
		]);
		const zurg = model.stages.find((s) => s.id === 'storage')!.services[0]!;
		const sonarr = model.stages.find((s) => s.id === 'automation')!.services[0]!;
		expect(zurg.name).toBe('Zurg');
		expect(zurg.instanceLabel).toBe('RealDebrid');
		expect(sonarr.instanceLabel).toBeNull();
	});

	it('labels duplicate instances even without a raw instance suffix', () => {
		const model = build([
			node({ key: 'sonarr', name: 'sonarr', category: 'manager' }),
			node({ key: 'sonarr_anime', name: 'sonarr anime', category: 'manager' })
		]);
		const services = model.stages[0]!.services;
		expect(services).toHaveLength(2);
		for (const service of services) expect(service.instanceLabel).toBeTruthy();
	});

	it('describes known services from the central catalog', () => {
		const model = build([node({ key: 'sonarr', name: 'sonarr', category: 'manager' })]);
		expect(model.stages[0]!.services[0]!.descriptor).toBe('TV automation');
	});
});

describe('pipeline failure propagation', () => {
	const stack = () => [
		node({ key: 'seerr', name: 'seerr instances Default', category: 'request' }),
		node({ key: 'sonarr', name: 'sonarr instances Default', category: 'manager' }),
		node({ key: 'decypharr', name: 'Decypharr', category: 'debrid' }),
		node({ key: 'infinidysk', name: 'InfiniDysk', category: 'bridge' }),
		node({ key: 'plex', name: 'Plex Media Server', category: 'media-server' }),
		node({ key: 'tautulli', name: 'Tautulli', category: 'analytics' })
	];

	it('propagates downstream impact without painting everything red', () => {
		const model = build(stack(), { rootCauseKeys: ['infinidysk'] });
		expect(model.rootCause?.key).toBe('infinidysk');

		const storage = model.stages.find((s) => s.id === 'storage')!;
		const media = model.stages.find((s) => s.id === 'media')!;
		const automation = model.stages.find((s) => s.id === 'automation')!;

		expect(storage.status).toBe('critical');
		expect(storage.services[0]!.status).toBe('critical');

		// Plex is healthy — the pipeline *presents* it as affected, not critical.
		expect(media.affected).toBe(true);
		expect(media.services[0]!.status).toBe('affected');
		expect(media.services[0]!.status).not.toBe('critical');

		// Upstream stages stay calm.
		expect(automation.affected).toBe(false);
		expect(automation.status).toBe('healthy');

		// Supporting is beside the flow and never inherits impact.
		expect(model.supporting?.affected ?? false).toBe(false);

		// The trunk breaks after storage; the inbound edge only degrades.
		const inEdge = model.connections.find((c) => c.to === 'storage');
		const outEdge = model.connections.find((c) => c.from === 'storage');
		expect(inEdge?.status).toBe('degraded');
		expect(outEdge?.status).toBe('broken');
	});

	it('matches root causes by service name as well as key', () => {
		const model = build(stack(), { rootCauseKeys: ['InfiniDysk'] });
		expect(model.rootCause?.key).toBe('infinidysk');
	});

	it('renders the demo failure story for QA', () => {
		const model = build(stack(), { rootCauseKeys: ['infinidysk'] });
		expect(model.stages.find((s) => s.id === 'media')!.affected).toBe(true);
	});
});

describe('pipeline robustness', () => {
	const stack = () => [
		node({ key: 'seerr', name: 'seerr instances Default', category: 'request' }),
		node({ key: 'sonarr', name: 'sonarr instances Default', category: 'manager' }),
		node({ key: 'prowlarr', name: 'prowlarr instances Default', category: 'indexer' }),
		node({ key: 'decypharr', name: 'Decypharr', category: 'debrid' }),
		node({ key: 'infinidysk', name: 'InfiniDysk', category: 'bridge' }),
		node({ key: 'plex', name: 'Plex Media Server', category: 'media-server' })
	];

	it('deduplicates duplicate service keys from malformed upstream data', () => {
		const nodes = [
			...stack(),
			node({ key: 'plex', name: 'Plex Media Server', category: 'media-server' })
		];
		const model = build(nodes);
		const allKeys = model.stages.flatMap((s) => s.services.map((svc) => svc.key));
		expect(new Set(allKeys).size).toBe(allKeys.length);
	});

	it('renders identical card order regardless of input order', () => {
		const forward = build(stack());
		const shuffled = build([...stack()].reverse());
		expect(shuffled.stages.map((s) => s.id)).toEqual(forward.stages.map((s) => s.id));
		for (let i = 0; i < forward.stages.length; i++) {
			expect(shuffled.stages[i]!.services.map((s) => s.key)).toEqual(
				forward.stages[i]!.services.map((s) => s.key)
			);
		}
	});

	it('orders cards by friendly name inside each stage', () => {
		const model = build(stack());
		const automation = model.stages.find((s) => s.id === 'automation')!;
		expect(automation.services.map((s) => s.name)).toEqual(['Prowlarr', 'Sonarr']);
	});

	it('draws stage trunks between present stages only, in flow order', () => {
		const model = build(stack());
		expect(model.connections.map((c) => `${c.from}->${c.to}`)).toEqual([
			'requests->automation',
			'automation->acquisition',
			'acquisition->storage',
			'storage->media'
		]);
	});

	it('handles a 30-service synthetic stack without duplicates or overflow risk', () => {
		const categories: PipelineCategory[] = [
			'request',
			'manager',
			'indexer',
			'debrid',
			'bridge',
			'media-server',
			'analytics',
			'auxiliary'
		];
		const nodes: TopologyNode[] = Array.from({ length: 30 }, (_, i) =>
			node({
				key: `svc-${i}`,
				name: `Service ${String(i + 1).padStart(2, '0')}`,
				category: categories[i % categories.length]!,
				runState: i % 6 === 0 ? 'unknown' : 'running',
				health: i % 6 === 0 ? 'unknown' : 'healthy',
				known: i % 5 !== 0
			})
		);
		const model = build(nodes, { managedKeys: nodes.map((n) => n.key) });
		const allKeys = [
			...model.stages.flatMap((s) => [
				...s.services.map((x) => x.key),
				...s.notRunning.map((x) => x.key)
			]),
			...(model.supporting?.services.map((x) => x.key) ?? []),
			...(model.supporting?.notRunning.map((x) => x.key) ?? []),
			...model.infrastructure.map((x) => x.key)
		];
		expect(allKeys).toHaveLength(30);
		expect(new Set(allKeys).size).toBe(30);
	});
});
