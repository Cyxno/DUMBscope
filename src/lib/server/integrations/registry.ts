/**
 * Integration adapter registry.
 *
 * Every discovered service is monitored generically through DUMB. Adapters may
 * add metadata (category, icon, dependencies) and later richer detail. A
 * failing adapter must never take down generic monitoring: `safeSummary`
 * catches everything and falls back.
 */
import type { DiscoveredService, PipelineCategory, ServiceStatus } from '$lib/types';
import { CATALOG, matchCatalog, type CatalogEntry } from '$lib/shared/catalog';

export interface IntegrationAdapter {
	id: string;
	/** Canonical display metadata. */
	displayName: string;
	category: PipelineCategory;
	icon: string;
	/** Which catalog ids this adapter depends on (edges). */
	dependsOn: string[];
	dependsOnCategory: PipelineCategory[];
	/** Extra, adapter-specific summary strings for drawers. */
	getSummary?(service: DiscoveredService, status: ServiceStatus | null): Record<string, string>;
}

function adapterFromCatalog(entry: CatalogEntry): IntegrationAdapter {
	return {
		id: entry.id,
		displayName: entry.displayName,
		category: entry.category,
		icon: entry.id,
		dependsOn: entry.dependsOn ?? [],
		dependsOnCategory: entry.dependsOnCategory ?? [],
		getSummary(service) {
			const summary: Record<string, string> = {};
			if (service.version) summary['Version'] = service.version;
			if (service.updateStatus && service.updateStatus.status === 'update_available') {
				summary['Update'] =
					`${service.updateStatus.currentVersion ?? '?'} → ${service.updateStatus.availableVersion ?? '?'}`;
			}
			return summary;
		}
	};
}

/** Generic fallback adapter: every unknown service still gets full monitoring. */
export const genericAdapter: IntegrationAdapter = {
	id: 'generic',
	displayName: 'Service',
	category: 'auxiliary',
	icon: 'generic',
	dependsOn: [],
	dependsOnCategory: [],
	getSummary(service) {
		const summary: Record<string, string> = {};
		if (service.version) summary['Version'] = service.version;
		if (service.repoUrl) summary['Project'] = service.repoUrl;
		return summary;
	}
};

export class IntegrationRegistry {
	private readonly adapters = new Map<string, IntegrationAdapter>();

	constructor() {
		this.add(genericAdapter);
	}

	add(adapter: IntegrationAdapter): void {
		this.adapters.set(adapter.id, adapter);
	}

	/** Resolve the adapter for a discovered service (never null — generic fallback). */
	resolve(service: DiscoveredService): IntegrationAdapter {
		const entry = matchCatalog(service.name, service.key);
		if (entry && this.adapters.has(entry.id)) return this.adapters.get(entry.id)!;
		// A catalog entry without a registered adapter still provides metadata.
		if (entry) return adapterFromCatalog(entry);
		return genericAdapter;
	}

	/** Wrap getSummary so a broken adapter can never break the UI. */
	safeSummary(
		adapter: IntegrationAdapter,
		service: DiscoveredService,
		status: ServiceStatus | null
	): Record<string, string> {
		if (!adapter.getSummary) return {};
		try {
			return adapter.getSummary(service, status) ?? {};
		} catch (err) {
			console.warn(
				`[dumbscope] adapter ${adapter.id} getSummary failed:`,
				err instanceof Error ? err.message : err
			);
			return {};
		}
	}
}

export const integrationRegistry = new IntegrationRegistry();

for (const entry of CATALOG) {
	integrationRegistry.add(adapterFromCatalog(entry));
}
