/** Client-side mirror of the server catalog matching (icon/category lookups). */
import { matchCatalog } from '$lib/shared/catalog';

export function matchCatalogId(name: string, key: string): string {
	return matchCatalog(name, key)?.id ?? 'generic';
}

export function categoryLabel(category: string): string {
	const labels: Record<string, string> = {
		core: 'Core',
		request: 'Requests',
		discovery: 'Discovery',
		manager: 'Library managers',
		indexer: 'Indexers',
		acquisition: 'Acquisition',
		usenet: 'Usenet',
		debrid: 'Debrid',
		bridge: 'Bridge',
		mount: 'Mount',
		storage: 'Storage / cache',
		database: 'Database',
		import: 'Import',
		subtitles: 'Subtitles',
		'media-server': 'Media server',
		analytics: 'Analytics',
		auxiliary: 'Other services'
	};
	return labels[category] ?? category;
}
