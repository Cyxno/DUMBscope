import { jsonError, jsonOk, isSameOrigin, readJson } from '$lib/server/security/validation';
import { incidentRepository } from '$lib/server/incidents/repository';
import { z } from 'zod';
import type { RequestHandler } from './$types';

const schema = z.object({
	/** Archive only resolved incidents older than this many hours; omit = all. */
	olderThanHours: z
		.number()
		.finite()
		.min(0)
		.max(24 * 90)
		.nullable()
		.optional()
});

/**
 * Bulk "Clear resolved" (§2): soft-archives resolved incidents — optionally
 * only those resolved before 24h / 7d / 30d ago. Active and acknowledged
 * incidents are never touched; archived history stays queryable.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return jsonError('Authentication required', 401);
	if (!isSameOrigin(request)) return jsonError('Invalid origin', 403);
	const body = await readJson(request);
	const parsed = schema.safeParse(body ?? {});
	if (!parsed.success) return jsonError('Invalid payload');

	const now = Date.now();
	const olderThanHours = parsed.data.olderThanHours ?? null;
	const beforeMs =
		olderThanHours === null || olderThanHours === undefined
			? null
			: now - olderThanHours * 3_600_000;
	const archived = incidentRepository.archiveResolved(
		beforeMs,
		now,
		olderThanHours == null
			? 'Archived by operator (clear resolved)'
			: `Archived by operator (resolved more than ${olderThanHours}h ago)`
	);
	return jsonOk({ archived });
};
