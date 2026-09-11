/**
 * Library overview API (brief §46): one bounded endpoint covering summary,
 * attention, queue groups and availability. Detail lists live in their own
 * paginated endpoints (/api/library/{tv,movies,subtitles}/missing, queue).
 */
import { jsonOk } from '$lib/server/security/validation';
import { getLibraryView, libraryTrend } from '$lib/server/library/service';
import { ensureIntegrationsUp } from '$lib/server/integrations/register';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	ensureIntegrationsUp();
	const view = getLibraryView();
	const windowParam = Number(url.searchParams.get('window') ?? 30);
	const windowDays = ([7, 30, 90] as readonly number[]).includes(windowParam)
		? (windowParam as 7 | 30 | 90)
		: 30;

	return jsonOk({
		availability: view.availability,
		fetchedAt: view.fetchedAt,
		summary: {
			tv: view.tv
				? {
						completionPct: view.tv.completionPct,
						missing: view.tv.monitoredMissing,
						upgrades: view.tv.upgradesAvailable,
						queue: view.tv.queue,
						series: view.tv.seriesTotal,
						backlogAges: view.tv.backlogAges
					}
				: null,
			movies: view.movies
				? {
						completionPct: view.movies.completionPct,
						missing: view.movies.monitoredMissing,
						upgrades: view.movies.upgradesAvailable,
						queue: view.movies.queue,
						movies: view.movies.moviesTotal,
						backlogAges: view.movies.backlogAges
					}
				: null,
			subtitles: view.subtitles
				? {
						coveragePct: view.subtitles.coveragePct,
						gaps: view.subtitles.totalGaps,
						episodeGaps: view.subtitles.episodeGaps,
						movieGaps: view.subtitles.movieGaps,
						topLanguages: view.subtitles.languages
							.slice()
							.sort((a, b) => b.missing - a.missing)
							.slice(0, 5)
							.map((l) => ({
								code2: l.code2,
								name: l.name,
								missing: l.missing,
								coveragePct: l.coveragePct
							}))
					}
				: null
		},
		queue: view.queue,
		healthWarnings: view.healthWarnings.slice(0, 20),
		attention: view.attention,
		trends: {
			windowDays,
			tv: libraryTrend('tv', windowDays),
			movies: libraryTrend('movies', windowDays),
			subtitles: libraryTrend('subtitles', windowDays)
		}
	});
};
