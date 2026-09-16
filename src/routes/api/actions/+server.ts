import { jsonError, jsonOk, readJson } from '$lib/server/security/validation';
import { getActionsManager } from '$lib/server/actions/manager';
import { rateLimit } from '$lib/server/security/rate-limit';
import { z } from 'zod';
import type { RequestHandler } from './$types';

const requestSchema = z.object({
	actionId: z.string().trim().min(1).max(64),
	integrationId: z.string().trim().min(1).max(64),
	// Structural target validation happens per-action in the registry — the
	// schema only pins the envelope.
	target: z.unknown()
});

/** Recent Safe Actions audit trail (bounded, §16). */
export const GET: RequestHandler = async () => {
	return jsonOk({ recent: getActionsManager().recent() });
};

/**
 * Execute one allowlisted Safe Action (docs/ACTIONS.md).
 *
 * Security (§17): admin session only, same-origin enforced by the global
 * hook, rate limited per session, action allowlist + target shape validated
 * server-side, and the integration instance is resolved by exact stable id —
 * the client can never name an arbitrary endpoint, command or URL.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return jsonError('Authentication required', 401);
	const limit = rateLimit(`actions:${locals.user.id}`, 10, 60_000);
	if (!limit.allowed) return jsonError('Too many requests — slow down', 429);

	const body = await readJson(request);
	const parsed = requestSchema.safeParse(body);
	if (!parsed.success) {
		return jsonError(parsed.error.issues[0]?.message ?? 'Invalid payload');
	}

	const result = await getActionsManager().execute({
		actionId: parsed.data.actionId,
		integrationId: parsed.data.integrationId,
		target: parsed.data.target,
		actor: locals.user.username
	});

	if (result.state === 'rejected') {
		return jsonError(
			result.message ?? 'Action rejected',
			result.message?.includes('Cooldown') ? 409 : 400
		);
	}
	if (result.state === 'failed') {
		return jsonError(result.message ?? 'Action failed upstream', 502);
	}
	return jsonOk(result);
};
