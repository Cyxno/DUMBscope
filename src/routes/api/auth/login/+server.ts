import { jsonError, jsonOk, readJson, usernameSchema } from '$lib/server/security/validation';
import {
	createSession,
	SESSION_COOKIE,
	findUserByUsername,
	touchLastLogin,
	hasAdminUser
} from '$lib/server/security/sessions';
import { verifyPassword } from '$lib/server/security/crypto';
import { rateLimit } from '$lib/server/security/rate-limit';
import { requestIsHttps } from '$lib/server/security/trusted-proxy';
import type { RequestHandler } from './$types';

const SESSION_TTL_S = 7 * 24 * 60 * 60;

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	if (!hasAdminUser()) return jsonError('Setup has not completed yet', 409);

	const limit = rateLimit(`login:${getClientAddress()}`, 10, 15 * 60 * 1000);
	if (!limit.allowed) {
		return jsonError(
			`Too many login attempts; retry in ${Math.ceil(limit.retryAfterMs / 60000)} minutes`,
			429
		);
	}

	const body = await readJson(request);
	if (!body || typeof body !== 'object') return jsonError('Invalid request body');
	const { username, password } = body as Record<string, unknown>;
	if (typeof username !== 'string' || typeof password !== 'string') {
		return jsonError('Username and password are required');
	}
	if (!usernameSchema.safeParse(username).success)
		return jsonError('Invalid username or password', 401);

	const user = findUserByUsername(username);
	// Constant-shape failure: run a dummy verify even when the user is unknown.
	const ok = user
		? verifyPassword(password, user.passwordHash)
		: verifyPassword(
				password,
				'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
			);
	if (!user || !ok) return jsonError('Invalid username or password', 401);

	const token = createSession(user.id, request.headers.get('user-agent'));
	touchLastLogin(user.id);
	const secure = requestIsHttps(request);
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		maxAge: SESSION_TTL_S
	});
	return jsonOk({ ok: true, username: user.username });
};
