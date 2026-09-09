import { describe, expect, it } from 'vitest';
import { buildTopology } from '../src/lib/server/topology/graph';
import { integrationRegistry, genericAdapter } from '../src/lib/server/integrations/registry';
import type { DiscoveredService, ServiceStatus } from '$lib/types';

function discovered(name: string, key?: string): DiscoveredService {
	return {
		key: key ?? name.toLowerCase(),
		name,
		processName: name,
		enabled: true,
		version: null,
		repoUrl: null,
		updateStatus: null
	};
}

function status(key: string, health: ServiceStatus['health']): ServiceStatus {
	return {
		key,
		name: key,
		processName: key,
		enabled: true,
		runState: 'running',
		health,
		healthReason: null,
		healthDetails: null,
		restart: null,
		cpuPercent: null,
		memoryBytes: null,
		pid: null,
		observedAt: Date.now()
	};
}

describe('topology', () => {
	it('places known services in their pipeline categories', () => {
		const graph = buildTopology(
			[
				discovered('Sonarr', 'sonarr'),
				discovered('Plex Media Server', 'plex'),
				discovered('PostgreSQL 16', 'postgres')
			],
			new Map()
		);
		const categories = Object.fromEntries(graph.nodes.map((n) => [n.key, n.category]));
		expect(categories['sonarr']).toBe('manager');
		expect(categories['plex']).toBe('media-server');
		expect(categories['postgres']).toBe('database');
	});

	it('builds dependency edges only for services that actually exist', () => {
		// Sonarr depends on an indexer; without Prowlarr there is no edge.
		const without = buildTopology([discovered('Sonarr')], new Map());
		expect(without.edges).toHaveLength(0);

		const withProwlarr = buildTopology([discovered('Sonarr'), discovered('Prowlarr')], new Map());
		expect(withProwlarr.edges).toContainEqual({
			from: 'prowlarr',
			to: 'sonarr',
			health: 'unknown'
		});
	});

	it('colors edges by upstream health including stopped dependencies', () => {
		const graph = buildTopology(
			[discovered('PostgreSQL 16', 'postgres'), discovered('InfiniDysk')],
			new Map([['postgres', status('postgres', 'unhealthy')]])
		);
		const edge = graph.edges.find((e) => e.from === 'postgres');
		expect(edge?.health).toBe('failed');

		const degraded = buildTopology(
			[discovered('PostgreSQL 16', 'postgres'), discovered('InfiniDysk')],
			new Map([['postgres', status('postgres', 'degraded')]])
		);
		expect(degraded.edges.find((e) => e.from === 'postgres')?.health).toBe('degraded');
	});

	it('routes unknown services to the generic auxiliary node', () => {
		const graph = buildTopology([discovered('Brand New Service X')], new Map());
		expect(graph.nodes).toHaveLength(1);
		expect(graph.nodes[0]!.category).toBe('auxiliary');
		expect(graph.nodes[0]!.known).toBe(false);
		expect(graph.edges).toHaveLength(0);
	});
});

describe('integration registry', () => {
	it('falls back to the generic adapter for unknown services', () => {
		const adapter = integrationRegistry.resolve(discovered('Mystery Service'));
		expect(adapter.id).toBe('generic');
		expect(adapter).toBe(genericAdapter);
	});

	it('never throws from adapter summaries', () => {
		const broken = {
			...genericAdapter,
			id: 'broken',
			getSummary: () => {
				throw new Error('boom');
			}
		};
		integrationRegistry.add(broken);
		const summary = integrationRegistry.safeSummary(broken, discovered('Broken'), null);
		expect(summary).toEqual({});
	});
});
