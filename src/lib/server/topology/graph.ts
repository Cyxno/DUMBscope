/**
 * Topology builder: turns discovered services + their status into a dependency
 * graph for the pipeline view.
 *
 * Edges come from the integration catalog (declared dependencies between known
 * services) and are resolved against the services that actually exist. The
 * graph never assumes a specific stack layout: unknown services become generic
 * auxiliary nodes without edges.
 */
import type {
	DiscoveredService,
	ServiceStatus,
	TopologyEdge,
	TopologyGraph,
	TopologyNode
} from '$lib/types';
import { integrationRegistry } from '../integrations/registry';

export function buildTopology(
	discovered: DiscoveredService[],
	statuses: ReadonlyMap<string, ServiceStatus>
): TopologyGraph {
	const nodes: TopologyNode[] = [];
	const byId = new Map<string, TopologyNode>();
	const adapterByKey = new Map<string, ReturnType<typeof integrationRegistry.resolve>>();

	for (const service of discovered) {
		const adapter = integrationRegistry.resolve(service);
		const status = statuses.get(service.key);
		const node: TopologyNode = {
			key: service.key,
			name: service.name,
			category: adapter.category,
			health: status?.health ?? 'unknown',
			runState: status?.runState ?? 'unknown',
			known: adapter.id !== 'generic'
		};
		nodes.push(node);
		byId.set(node.key, node);
		adapterByKey.set(node.key, adapter);
	}

	// Resolve only *explicit* dependencies (catalog id → concrete service).
	// Category-level "dependsOnCategory" entries are deliberately NOT turned
	// into per-service edges: picking the first service in a category produced
	// arbitrary, wrong relations (e.g. Tautulli → Emby, Seerr → Lidarr).
	// Stage-level relationships belong to the PipelineViewModel, which draws
	// stage-to-stage trunks instead of invented service edges.
	const keyByCatalogId = new Map<string, string>();
	for (const node of nodes) {
		const adapter = adapterByKey.get(node.key);
		if (adapter && adapter.id !== 'generic' && !keyByCatalogId.has(adapter.id)) {
			keyByCatalogId.set(adapter.id, node.key);
		}
	}

	const edges: TopologyEdge[] = [];
	const seen = new Set<string>();
	for (const node of nodes) {
		const adapter = adapterByKey.get(node.key);
		if (!adapter) continue;
		const targets = new Set<string>();
		for (const depId of adapter.dependsOn) {
			// Dependency ids may reference a service key or a catalog id
			// ("postgres" vs "postgresql"); resolve both, deterministically.
			const target = byId.has(depId) ? depId : keyByCatalogId.get(depId);
			if (target && target !== node.key) targets.add(target);
		}
		for (const target of targets) {
			const edgeKey = `${target}->${node.key}`;
			if (seen.has(edgeKey)) continue;
			seen.add(edgeKey);
			edges.push({ from: target, to: node.key, health: edgeHealth(byId.get(target)) });
		}
	}

	return { nodes, edges };
}

/** Edge severity reflects the *upstream* (dependency) side: a broken database makes every edge into it red. */
function edgeHealth(node: TopologyNode | undefined): TopologyEdge['health'] {
	if (!node) return 'unknown';
	if (node.health === 'unhealthy' || node.runState === 'stopped') return 'failed';
	if (node.health === 'degraded' || node.health === 'starting') return 'degraded';
	if (node.health === 'healthy') return 'healthy';
	return 'unknown';
}
