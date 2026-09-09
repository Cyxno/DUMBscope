import { jsonOk } from '$lib/server/security/validation';
import { destroySession, SESSION_COOKIE } from '$lib/server/security/sessions';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies, locals }) => {
	destroySession(locals.sessionToken);
	cookies.delete(SESSION_COOKIE, { path: '/' });
	return jsonOk({ ok: true });
};
