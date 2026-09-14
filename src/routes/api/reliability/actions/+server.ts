import { jsonError, jsonOk, readJson } from '$lib/server/security/validation';
import { getHub } from '$lib/server/telemetry/hub';
import { getRemediationManager } from '$lib/server/reliability/remediation';
import { rateLimit } from '$lib/server/security/rate-limit';
import { z } from 'zod';
import type { RequestHandler } from './$types';

const requestSchema = z.object({
	target: z.string().trim().min(1).max(128)
});

/** Action status + recent audit trail (admin view, read-only). */
export const GET: RequestHandler = async () => {
	return jsonOk({
		recent: getRemediationManager().recent(),
		automaticEnabled: false
	});
};

/**
 * Execute one allowlisted remediation action (currently only the single-
 * service restart via DUMB's official route).
 *
 * Security (brief §55-§58): admin session only, same-origin enforced by the
 * global hook for POSTs, rate limited per session, and the target is resolved
 * server-side against DUMB's managed registry — the client can never name an
 * arbitrary command or process. Duplicate in-flight requests conflict (409).
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return jsonError('Authentication required', 401);
	const limit = rateLimit(`remediation:${locals.user.id}`, 5, 60_000);
	if (!limit.allowed) return jsonError('Too many requests — slow down', 429);

	const body = await readJson(request);
	const parsed = requestSchema.safeParse(body);
	if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid payload');
	const target = parsed.data.target;

	const hub = getHub();
	// Target validation happens server-side: only names in DUMB's managed
	// registry (or live service map) are actionable.
	const known =
		hub.getDiscovered().some((d) => d.processName === target) ||
		hub.getServices().some((s) => s.processName === target);
	if (!known) return jsonError('Unknown service target', 400);

	const manager = getRemediationManager();
	const result = await manager.request({
		kind: 'restart-managed-service',
		target,
		actor: locals.user.username,
		reason: 'Requested from the reliability view',
		evidence: [],
		triggerSource: 'manual',
		findingFingerprint: null
	});
	if (result.state === 'rejected') {
		return jsonError(result.preflight.failures.join('; ') || 'Action rejected', 409);
	}
	if (result.state === 'failed') {
		return jsonError('DUMB did not accept the restart request', 502);
	}
	return jsonOk({ id: result.id, state: result.state });
};
