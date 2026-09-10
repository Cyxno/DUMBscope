import { jsonOk } from '$lib/server/security/validation';
import { recentActivity, type ActivityEntry } from '$lib/server/telemetry/activity';
import { listActivity } from '$lib/server/integrations/activity';
import type { ActivityEvent } from '$lib/server/integrations/types';
import type { RequestHandler } from './$types';

/**
 * Combined activity feed (brief §15/§16): the in-memory DUMB event ring plus
 * persisted semantic integration events, newest first. `source=dumb` narrows
 * to the legacy ring; integration filters hit the persisted store.
 */
export const GET: RequestHandler = async ({ url }) => {
	const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 60)));
	const before = url.searchParams.get('before');
	const beforeId = before !== null ? Number(before) : undefined;
	const service = url.searchParams.get('service');
	const category = url.searchParams.get('category');

	const dumbEntries: ActivityEntry[] = recentActivity(
		limit,
		Number.isFinite(beforeId) ? beforeId : undefined
	);
	const semantic: ActivityEvent[] =
		service || category
			? listActivity({ serviceKey: service ?? undefined, category: category ?? undefined, limit })
			: listActivity({ limit });

	const LEGACY_CATEGORY: Record<string, string> = {
		incident: 'health',
		'health-transition': 'health',
		restart: 'system',
		connection: 'system',
		'service-started': 'system',
		'service-stopped': 'system'
	};
	const legacyCategory = (kind: string) => LEGACY_CATEGORY[kind] ?? 'system';

	type FeedItem = {
		id: string | number;
		at: number;
		source: string;
		serviceKey: string | null;
		category: string;
		title: string;
		detail: string | null;
		severity: string | null;
		observed: boolean;
	};
	const feed: FeedItem[] = [
		...dumbEntries.map((e) => ({
			id: e.id,
			at: e.at,
			source: 'dumb',
			serviceKey: e.serviceKey ?? null,
			category: legacyCategory(e.kind) ?? 'system',
			title: e.message,
			detail: null,
			severity: null,
			observed: true
		})),
		...semantic.map((e) => ({
			id: e.id,
			at: e.at,
			source: e.source,
			serviceKey: e.serviceKey,
			category: e.category,
			title: e.title,
			detail: e.detail,
			severity: e.severity,
			observed: e.observed
		}))
	]
		.sort((a, b) => b.at - a.at)
		.slice(0, limit);

	return jsonOk({ entries: feed });
};
