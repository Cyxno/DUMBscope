import { jsonError, jsonOk, readJson } from '$lib/server/security/validation';
import { verifySetupCode } from '$lib/server/setup';
import { rateLimit } from '$lib/server/security/rate-limit';
import { SETUP_COOKIE, issueSetupCookie } from '$lib/server/security/setup-session';
import { hasAdminUser } from '$lib/server/security/sessions';
import { requestIsHttps } from '$lib/server/security/trusted-proxy';
import { getSettings } from '$lib/server/config/settings';
import type { RequestHandler } from './$types';

/**
 * Verify the setup code from the container log and issue a short-lived,
 * signed setup-session cookie for the remaining wizard steps. The response
 * includes the seeded DUMB URL (DUMB_URL env default), if any, so the wizard
 * can prefill the gateway field — never exposed before the code is verified.
 */
export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	if (hasAdminUser()) return jsonError('Setup has already completed', 409);

	const limit = rateLimit(`setup-begin:${getClientAddress()}`, 10, 15 * 60 * 1000);
	if (!limit.allowed) {
		return jsonError(
			`Too many attempts; retry in ${Math.ceil(limit.retryAfterMs / 60000)} minutes`,
			429
		);
	}

	const body = await readJson(request);
	const code = (body as { code?: unknown } | null)?.code;
	if (typeof code !== 'string' || code.length === 0 || code.length > 16) {
		return jsonError('Enter the setup code shown in the container log');
	}
	if (!verifySetupCode(code, getClientAddress())) {
		return jsonError('That setup code is not valid (or has expired)', 403);
	}

	const { value, maxAgeSeconds } = issueSetupCookie();
	cookies.set(SETUP_COOKIE, value, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		// Kit defaults Secure=true for non-localhost, which would make the
		// wizard unusable over plain-HTTP LAN deployments — browsers refuse to
		// send the cookie back. Match login/complete: Secure only on HTTPS.
		secure: requestIsHttps(request),
		maxAge: maxAgeSeconds
	});
	return jsonOk({ ok: true, defaultUrl: getSettings().dumbUrl });
};
