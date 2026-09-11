/**
 * Regression tests for the proven topology edge bug: `dependsOnCategory`
 * used to resolve to the *first* service in a category, producing arbitrary
 * and factually wrong service-to-service edges. Category-level relationships
 * must no longer create service edges — only explicit catalog dependencies
 * (`dependsOn` by id) may.
 *
 * Release gate (ux/pipeline-overhaul §62): no edge may exist purely because
 * a service happened to be first in a category array.
 */
import { describe, expect, it } from 'vitest';
import { buildTopology } from '../src/lib/server/topology/graph';
import type { DiscoveredService } from '$lib/types';

function discovered(name: string, key = name.toLowerCase()): DiscoveredService {
	return {
		key,
		name,
		processName: name,
		enabled: true,
		version: null,
		repoUrl: null,
		updateStatus: null
	};
}

describe('topology edge honesty', () => {
	it('does not bind Tautulli to Emby merely because Emby is first in media-server', () => {
		const graph = buildTopology(
			[
				discovered('Emby', 'emby'),
				discovered('Plex Media Server', 'plex'),
				discovered('Tautulli', 'tautulli')
			],
			new Map()
		);
		const tautulliEdges = graph.edges.filter((e) => e.to === 'tautulli');
		// Tautulli explicitly depends on Plex — and on nothing category-derived.
		expect(tautulliEdges).toHaveLength(1);
		expect(tautulliEdges[0]).toMatchObject({ from: 'plex', to: 'tautulli' });
	});

	it('does not bind Seerr to Lidarr solely due to category ordering', () => {
		const graph = buildTopology(
			[
				discovered('lidarr instances Default', 'lidarr'),
				discovered('radarr instances Default', 'radarr'),
				discovered('sonarr instances Default', 'sonarr'),
				discovered('seerr instances Default', 'seerr')
			],
			new Map()
		);
		// Seerr's "depends on managers" is a stage relationship, not a
		// service edge: with no explicit id dependency there is no edge.
		expect(graph.edges.filter((e) => e.to === 'seerr')).toHaveLength(0);
	});

	it('keeps explicit id-based dependencies working', () => {
		const graph = buildTopology(
			[
				discovered('Prowlarr', 'prowlarr'),
				discovered('Sonarr', 'sonarr'),
				discovered('InfiniDysk', 'infinidysk'),
				discovered('Decypharr', 'decypharr')
			],
			new Map()
		);
		expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'prowlarr', to: 'sonarr' }));
		expect(graph.edges).toContainEqual(
			expect.objectContaining({ from: 'infinidysk', to: 'decypharr' })
		);
	});

	it('creates no cross-category noise edges for a realistic mixed stack', () => {
		// The production replica snapshot produced 31 edges for 36 nodes under
		// the old rule; with explicit-only edges the count must drop sharply.
		const graph = buildTopology(
			[
				discovered('Emby', 'emby'),
				discovered('Jellyfin', 'jellyfin'),
				discovered('Plex Media Server', 'plex'),
				discovered('Tautulli', 'tautulli'),
				discovered('Bazarr', 'bazarr'),
				discovered('sonarr instances Default', 'sonarr'),
				discovered('lidarr instances Default', 'lidarr'),
				discovered('seerr instances Default', 'seerr')
			],
			new Map()
		);
		// Only plex→tautulli (explicit) survives; bazarr/seerr category deps
		// resolve to nothing without an explicit id dependency.
		expect(graph.edges).toHaveLength(1);
	});
});
