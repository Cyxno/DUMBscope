/**
 * Pure browse-list logic (§59/§60/§128): allowlisted filters and sorts,
 * bounded pagination, sanitized search. No I/O — fully unit-testable.
 */
import type { BrowseMovie, BrowseSeries } from './browse-models';

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 50;
export const MAX_SEARCH_LENGTH = 80;

export type SeriesFilter =
	'all' | 'incomplete' | 'continuing' | 'ended' | 'monitored' | 'unmonitored';
export type MovieFilter =
	'all' | 'available' | 'missing' | 'upgrades' | 'upcoming' | 'monitored' | 'unmonitored';

export type SeriesSort = 'name' | 'completion' | 'missing' | 'added' | 'year';
export type MovieSort = 'name' | 'year' | 'added' | 'missing-oldest' | 'missing-newest' | 'quality';

export interface BrowseListParams {
	limit: number;
	offset: number;
	q: string;
	filter: string;
	sort: string;
}

/** Allowlisted, bounded query params (§59/§128). Unknown values fall back. */
export function parseBrowseParams(
	url: URL,
	allowedFilters: readonly string[],
	allowedSorts: readonly string[],
	defaultSort: string
): BrowseListParams {
	const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
	const limit = Number.isFinite(limitRaw)
		? Math.max(1, Math.min(MAX_LIMIT, Math.floor(limitRaw)))
		: DEFAULT_LIMIT;
	const offsetRaw = Number(url.searchParams.get('offset') ?? 0);
	const offset = Number.isFinite(offsetRaw)
		? Math.max(0, Math.min(10_000, Math.floor(offsetRaw)))
		: 0;
	const qRaw = url.searchParams.get('q') ?? '';
	const q = qRaw.trim().slice(0, MAX_SEARCH_LENGTH);
	const filterRaw = url.searchParams.get('filter') ?? 'all';
	const filter = allowedFilters.includes(filterRaw) ? filterRaw : 'all';
	const sortRaw = url.searchParams.get('sort') ?? defaultSort;
	const sort = allowedSorts.includes(sortRaw) ? sortRaw : defaultSort;
	return { limit, offset, q, filter, sort };
}

export function matchesSearch(q: string, ...titles: (string | null)[]): boolean {
	if (q === '') return true;
	const needle = q.toLowerCase();
	return titles.some((t) => typeof t === 'string' && t.toLowerCase().includes(needle));
}

const SERIES_FILTERS: readonly SeriesFilter[] = [
	'all',
	'incomplete',
	'continuing',
	'ended',
	'monitored',
	'unmonitored'
];
const SERIES_SORTS: readonly SeriesSort[] = ['name', 'completion', 'missing', 'added', 'year'];

export function seriesListParams(
	url: URL
): BrowseListParams & { filter: SeriesFilter; sort: SeriesSort } {
	const params = parseBrowseParams(url, SERIES_FILTERS, SERIES_SORTS, 'name');
	return { ...params, filter: params.filter as SeriesFilter, sort: params.sort as SeriesSort };
}

export function filterSortSeries(
	items: BrowseSeries[],
	filter: SeriesFilter,
	sort: SeriesSort,
	q: string
): BrowseSeries[] {
	let list = items;
	switch (filter) {
		case 'incomplete':
			list = list.filter((s) => s.missingCount > 0);
			break;
		case 'continuing':
			list = list.filter((s) => s.status === 'continuing');
			break;
		case 'ended':
			list = list.filter((s) => s.status === 'ended');
			break;
		case 'monitored':
			list = list.filter((s) => s.monitored);
			break;
		case 'unmonitored':
			list = list.filter((s) => !s.monitored);
			break;
		default:
			break;
	}
	if (q !== '') list = list.filter((s) => matchesSearch(q, s.title, s.sortTitle, s.network));
	const sorted = [...list];
	switch (sort) {
		case 'completion':
			sorted.sort(
				(a, b) =>
					(a.completionPct ?? 100) - (b.completionPct ?? 100) ||
					a.sortTitle.localeCompare(b.sortTitle)
			);
			break;
		case 'missing':
			sorted.sort(
				(a, b) => b.missingCount - a.missingCount || a.sortTitle.localeCompare(b.sortTitle)
			);
			break;
		case 'added':
			sorted.sort(
				(a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0) || a.sortTitle.localeCompare(b.sortTitle)
			);
			break;
		case 'year':
			sorted.sort(
				(a, b) => (b.year ?? 0) - (a.year ?? 0) || a.sortTitle.localeCompare(b.sortTitle)
			);
			break;
		default:
			sorted.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
	}
	return sorted;
}

const MOVIE_FILTERS: readonly MovieFilter[] = [
	'all',
	'available',
	'missing',
	'upgrades',
	'upcoming',
	'monitored',
	'unmonitored'
];
const MOVIE_SORTS: readonly MovieSort[] = [
	'name',
	'year',
	'added',
	'missing-oldest',
	'missing-newest',
	'quality'
];

export function movieListParams(
	url: URL
): BrowseListParams & { filter: MovieFilter; sort: MovieSort } {
	const params = parseBrowseParams(url, MOVIE_FILTERS, MOVIE_SORTS, 'name');
	return { ...params, filter: params.filter as MovieFilter, sort: params.sort as MovieSort };
}

/** Released-and-wanted flag: missing means Radarr says available without a file. */
export function isMovieMissing(movie: BrowseMovie): boolean {
	return movie.isAvailable && !movie.hasFile;
}

export function movieReleaseDate(movie: BrowseMovie): number | null {
	return movie.digitalRelease ?? movie.inCinemas ?? movie.physicalRelease;
}

export function filterSortMovies(
	items: BrowseMovie[],
	filter: MovieFilter,
	sort: MovieSort,
	q: string
): BrowseMovie[] {
	let list = items;
	switch (filter) {
		case 'available':
			list = list.filter((m) => m.hasFile);
			break;
		case 'missing':
			list = list.filter(isMovieMissing);
			break;
		case 'upgrades':
			list = list.filter((m) => m.upgradeAvailable);
			break;
		case 'upcoming':
			list = list.filter((m) => !m.isAvailable);
			break;
		case 'monitored':
			list = list.filter((m) => m.monitored);
			break;
		case 'unmonitored':
			list = list.filter((m) => !m.monitored);
			break;
		default:
			break;
	}
	if (q !== '') list = list.filter((m) => matchesSearch(q, m.title, m.sortTitle, m.studio));
	const sorted = [...list];
	switch (sort) {
		case 'year':
			sorted.sort(
				(a, b) => (b.year ?? 0) - (a.year ?? 0) || a.sortTitle.localeCompare(b.sortTitle)
			);
			break;
		case 'added':
			sorted.sort(
				(a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0) || a.sortTitle.localeCompare(b.sortTitle)
			);
			break;
		case 'missing-oldest':
			sorted.sort(
				(a, b) =>
					(movieReleaseDate(a) ?? Number.MAX_SAFE_INTEGER) -
					(movieReleaseDate(b) ?? Number.MAX_SAFE_INTEGER)
			);
			break;
		case 'missing-newest':
			sorted.sort((a, b) => (movieReleaseDate(b) ?? 0) - (movieReleaseDate(a) ?? 0));
			break;
		case 'quality':
			sorted.sort(
				(a, b) =>
					(b.qualityResolution ?? -1) - (a.qualityResolution ?? -1) ||
					a.sortTitle.localeCompare(b.sortTitle)
			);
			break;
		default:
			sorted.sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
	}
	return sorted;
}

export function pageOf<T>(
	items: T[],
	limit: number,
	offset: number
): { total: number; items: T[] } {
	return { total: items.length, items: items.slice(offset, offset + limit) };
}
