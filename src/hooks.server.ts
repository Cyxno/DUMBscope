/**
 * Global request pipeline: security headers, session resolution, route guards
 * and same-origin enforcement for state-changing requests.
 */
import type { Handle } from '@sveltejs/kit';
import { jsonError, isSameOrigin } from '$lib/server/security/validation';
import { SESSION_COOKIE, getSessionUser, hasAdminUser } from '$lib/server/security/sessions';
import { getSettings } from '$lib/server/config/settings';
import { issueSetupCode, setupNeeded } from '$lib/server/setup';
import { getDb } from '$lib/server/database/db';
import { getHub } from '$lib/server/telemetry/hub';
import { installShutdownHooks } from '$lib/server/lifecycle';
import { ensureIntegrationsUp } from '$lib/server/integrations/register';

installShutdownHooks();

// Boot the telemetry hub eagerly with the server module (once per process):
// monitoring must start with the process, not with the first UI request —
// an instance nobody has opened yet still has to watch the stack. The
// liveness probe itself stays side-effect-free; this module-level boot runs
// on the first request of any kind, as it did before v0.8.1 via
// /api/health calling getHub().
try {
	getHub();
} catch (err) {
	console.error('[dumbscope] hub startup failed:', err instanceof Error ? err.message : err);
}

const PUBLIC_PATHS = new Set<string>([
	'/api/health',
	'/login',
	'/setup',
	'/api/auth/login',
	'/api/auth/logout',
	'/api/setup/status',
	'/api/setup/begin',
	'/api/setup/test-dumb',
	'/api/setup/complete'
]);

function isConfigured(): boolean {
	try {
		getDb();
		return hasAdminUser() && getSettings().setupCompleted && Boolean(getSettings().dumbUrl);
	} catch (err) {
		console.error(
			'[dumbscope] configuration check failed:',
			err instanceof Error ? err.message : err
		);
		return false;
	}
}

function applySecurityHeaders(response: Response): void {
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

export const handle: Handle = async ({ event, resolve }) => {
	const { request, url, cookies, locals } = event;
	const pathname = url.pathname;

	// Integration pollers are idempotent/lazy: no-op before setup or when empty.
	ensureIntegrationsUp();

	// Same-origin check for mutating requests (CSRF defense in depth).
	if (
		!isSameOrigin(request) &&
		pathname.startsWith('/api/') &&
		request.method !== 'GET' &&
		request.method !== 'HEAD'
	) {
		return jsonError('Cross-origin request rejected', 403);
	}

	// Session resolution.
	locals.sessionToken = cookies.get(SESSION_COOKIE);
	locals.user = getSessionUser(locals.sessionToken);

	// First-run convenience: make sure a setup code exists in the container log.
	if (!isConfigured() && !pathname.startsWith('/_app') && setupNeeded()) {
		issueSetupCode();
	}

	const isPublic =
		PUBLIC_PATHS.has(pathname) || pathname === '/api/health' || pathname.startsWith('/api/health/');

	let response: Response;
	if (pathname.startsWith('/api/')) {
		if (!isPublic && !locals.user) {
			response = jsonError('Authentication required', 401);
		} else {
			response = await resolve(event);
		}
	} else if (pathname === '/login') {
		response =
			locals.user && isConfigured()
				? new Response(null, { status: 302, headers: { location: '/' } })
				: await resolve(event);
	} else if (pathname === '/setup') {
		response = await resolve(event);
	} else if (!isConfigured()) {
		response = new Response(null, { status: 302, headers: { location: '/setup' } });
	} else if (!locals.user) {
		response = new Response(null, { status: 302, headers: { location: '/login' } });
	} else {
		response = await resolve(event);
	}

	applySecurityHeaders(response);
	return response;
};
