/** Client-side mirror of the server catalog matching (icon/category lookups). */
import { matchCatalog } from '$lib/shared/catalog';

export function matchCatalogId(name: string, key: string): string {
	return matchCatalog(name, key)?.id ?? 'generic';
}
