/**
 * Server-side list handling for the library detail endpoints: bounded pages,
 * validated params and high-value sorts only (brief §48/§94/§96).
 */
import type { MissingItem } from './models';

const MAX_LIMIT = 100;

export interface ListParams {
	limit: number;
	offset: number;
	sort: string;
	filter: string;
}

export function parseListParams(url: URL, defaultSort = 'most'): ListParams {
	const limit = Math.max(1, Math.min(MAX_LIMIT, Number(url.searchParams.get('limit') ?? 50) || 50));
	const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
	const sortRaw = url.searchParams.get('sort') ?? defaultSort;
	const sort = ['most', 'oldest', 'recent', 'name'].includes(sortRaw) ? sortRaw : defaultSort;
	const filterRaw = url.searchParams.get('filter') ?? 'all';
	const filter = ['all', 'monitored'].includes(filterRaw) ? filterRaw : 'all';
	return { limit, offset, sort, filter };
}

export function sortAndFilterMissing(
	items: MissingItem[],
	sort: string,
	filter: string
): MissingItem[] {
	let list = items.filter((item) => item.status === 'missing');
	if (filter === 'monitored') list = list.filter((item) => item.monitored);
	switch (sort) {
		case 'oldest':
			list.sort(
				(a, b) =>
					(a.releasedAt ?? Number.MAX_SAFE_INTEGER) - (b.releasedAt ?? Number.MAX_SAFE_INTEGER)
			);
			break;
		case 'recent':
			list.sort((a, b) => (b.releasedAt ?? 0) - (a.releasedAt ?? 0));
			break;
		case 'name':
			list.sort((a, b) => a.title.localeCompare(b.title));
			break;
		default: {
			// "most": titles with the most missing entries first, oldest first within.
			const counts = new Map<string, number>();
			for (const item of list) counts.set(item.title, (counts.get(item.title) ?? 0) + 1);
			list.sort((a, b) => {
				const diff = (counts.get(b.title) ?? 0) - (counts.get(a.title) ?? 0);
				return diff !== 0
					? diff
					: (a.releasedAt ?? Number.MAX_SAFE_INTEGER) - (b.releasedAt ?? Number.MAX_SAFE_INTEGER);
			});
		}
	}
	return list;
}

export function pageOf<T>(
	list: T[],
	params: ListParams
): { total: number; limit: number; offset: number; items: T[] } {
	return {
		total: list.length,
		limit: params.limit,
		offset: params.offset,
		items: list.slice(params.offset, params.offset + params.limit)
	};
}
