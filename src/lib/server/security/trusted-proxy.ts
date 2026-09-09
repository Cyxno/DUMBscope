/**
 * Reverse-proxy trust. Forwarded headers are only honored when the operator
 * explicitly opts in via DUMBSCOPE_TRUST_PROXY=true (documented in README).
 */
export function trustProxy(): boolean {
	return process.env.DUMBSCOPE_TRUST_PROXY === 'true';
}

/**
 * True when the browser-facing request is HTTPS as far as we can tell.
 *
 * request.url must NOT be consulted: adapter-node fabricates an
 * `https://` URL for every request when it cannot see the wire protocol
 * (no ORIGIN/PROTOCOL_HEADER configured), so on plain-HTTP LAN deployments
 * it always claims HTTPS. Cookies marked Secure would then be dropped by
 * browsers and neither login nor the setup wizard can work. Operators
 * serving genuine HTTPS can force the secure flag with DUMBSCOPE_HTTPS=true.
 */
export function requestIsHttps(request: Request): boolean {
	if (process.env.DUMBSCOPE_HTTPS === 'true') return true;
	const forwarded = request.headers.get('x-forwarded-proto');
	if (forwarded === 'https') return trustProxy();
	if (forwarded === 'http') return false;
	return false;
}
