import { jsonError, jsonOk, readJson, validateDumbUrl } from '$lib/server/security/validation';
import { verifySetupCookie, SETUP_COOKIE } from '$lib/server/security/setup-session';
import { rateLimit } from '$lib/server/security/rate-limit';
import { DumbClient, DumbAuthError, DumbError } from '$lib/server/dumb/client';
import { parseCapabilities } from '$lib/server/dumb/capabilities';
import type { RequestHandler } from './$types';

/**
 * Test a candidate DUMB connection during setup: reachability, health,
 * auth mode, optional credential check, and a service-count preview.
 */
export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
	if (!verifySetupCookie(cookies.get(SETUP_COOKIE))) {
		return jsonError('Setup session expired — re-enter the setup code', 403);
	}
	const limit = rateLimit(`setup-test:${getClientAddress()}`, 15, 5 * 60 * 1000);
	if (!limit.allowed) return jsonError('Too many connection tests; wait a moment', 429);

	const body = (await readJson(request)) as {
		url?: unknown;
		username?: unknown;
		password?: unknown;
	} | null;
	if (!body || typeof body.url !== 'string') return jsonError('A DUMB URL is required');

	let base: string;
	try {
		base = validateDumbUrl(body.url).base;
	} catch (err) {
		return jsonError(err instanceof Error ? err.message : 'Invalid DUMB URL');
	}

	const username = typeof body.username === 'string' ? body.username : '';
	const password = typeof body.password === 'string' ? body.password : '';
	const client = new DumbClient({ baseUrl: base, getCredentials: () => null, timeoutMs: 8000 });

	try {
		const probe = await client.probe();
		const authRequired = probe.authStatus?.enabled === true;

		let credentialsOk: boolean | null = null;
		let serviceCount: number | null = null;
		let capabilitiesCount: number | null = null;

		if (authRequired) {
			if (username.length === 0 || password.length === 0) {
				return jsonOk({
					reachable: true,
					health: probe.status,
					authRequired,
					authMode: probe.authStatus?.mode ?? 'local',
					credentialsOk: null,
					serviceCount: null,
					capabilitiesCount: null
				});
			}
			try {
				await client.loginWith(username, password);
				credentialsOk = true;
			} catch (err) {
				return jsonOk({
					reachable: true,
					health: probe.status,
					authRequired,
					authMode: probe.authStatus?.mode ?? 'local',
					credentialsOk: false,
					error:
						err instanceof DumbAuthError
							? 'DUMB rejected these credentials'
							: 'Login attempt failed',
					serviceCount: null,
					capabilitiesCount: null
				});
			}
		}

		try {
			const processes = await client.processes();
			serviceCount = Array.isArray(processes.processes) ? processes.processes.length : null;
			const caps = await client.capabilities().catch(() => ({}));
			capabilitiesCount = Object.keys(parseCapabilities(caps).raw).length;
		} catch {
			// Readable but not authorized for process data; surface auth state only.
		}

		return jsonOk({
			reachable: true,
			health: probe.status,
			authRequired,
			authMode: probe.authStatus?.mode ?? 'none',
			credentialsOk,
			serviceCount,
			capabilitiesCount
		});
	} catch (err) {
		const message = err instanceof DumbError ? err.message : 'Could not reach the DUMB gateway';
		return jsonOk({ reachable: false, error: message });
	}
};
