import {
	jsonError,
	jsonOk,
	passwordSchema,
	readJson,
	usernameSchema,
	validateDumbUrl
} from '$lib/server/security/validation';
import { verifySetupCookie, SETUP_COOKIE } from '$lib/server/security/setup-session';
import {
	hasAdminUser,
	createAdminUser,
	createSession,
	SESSION_COOKIE
} from '$lib/server/security/sessions';
import { hashPassword } from '$lib/server/security/crypto';
import { rateLimit } from '$lib/server/security/rate-limit';
import { setDumbUrl, setDumbCredentials, setSetupCompleted } from '$lib/server/config/settings';
import { clearSetupCode } from '$lib/server/setup';
import { resetHub } from '$lib/server/telemetry/hub';
import { requestIsHttps } from '$lib/server/security/trusted-proxy';
import type { RequestHandler } from './$types';

/**
 * Complete first-run setup: create the admin account, persist (encrypted) DUMB
 * connection details, mark setup done and start the hub.
 */
export const POST: RequestHandler = async ({ request, cookies, locals }) => {
	if (hasAdminUser()) return jsonError('Setup has already completed', 409);
	if (!verifySetupCookie(cookies.get(SETUP_COOKIE))) {
		return jsonError('Setup session expired — re-enter the setup code', 403);
	}
	const limit = rateLimit('setup-complete', 5, 5 * 60 * 1000);
	if (!limit.allowed) return jsonError('Too many attempts; wait a moment', 429);

	const body = (await readJson(request)) as {
		url?: unknown;
		username?: unknown;
		password?: unknown;
		adminUsername?: unknown;
		adminPassword?: unknown;
	} | null;
	if (!body) return jsonError('Invalid request body');

	const { adminUsername, adminPassword } = body;
	if (typeof adminUsername !== 'string' || !usernameSchema.safeParse(adminUsername).success) {
		return jsonError('Choose a valid admin username (letters, numbers, dots, dashes)');
	}
	if (typeof adminPassword !== 'string' || !passwordSchema.safeParse(adminPassword).success) {
		return jsonError('Admin password must be at least 10 characters');
	}
	if (typeof body.url !== 'string') return jsonError('A DUMB URL is required');
	let base: string;
	try {
		base = validateDumbUrl(body.url).base;
	} catch (err) {
		return jsonError(err instanceof Error ? err.message : 'Invalid DUMB URL');
	}

	// Optional but validated DUMB credentials.
	const dumbUsername = typeof body.username === 'string' ? body.username : null;
	const dumbPassword = typeof body.password === 'string' ? body.password : null;

	setDumbUrl(base);
	if (dumbUsername && dumbPassword) {
		setDumbCredentials({ username: dumbUsername, password: dumbPassword });
	}
	const userId = createAdminUser(adminUsername, hashPassword(adminPassword));
	setSetupCompleted();
	clearSetupCode();

	const token = createSession(userId, request.headers.get('user-agent'));
	const secure = requestIsHttps(request);
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: 7 * 24 * 60 * 60
	});
	cookies.delete(SETUP_COOKIE, { path: '/' });

	locals.user = { id: userId, username: adminUsername.toLowerCase() };
	resetHub(); // picks up the new configuration on next getHub()
	return jsonOk({ ok: true });
};
