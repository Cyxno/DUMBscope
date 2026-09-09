/**
 * Reverse-proxy trust. Forwarded headers are only honored when the operator
 * explicitly opts in via DUMBSCOPE_TRUST_PROXY=true (documented in README).
 */
export const TRUST_PROXY = process.env.DUMBSCOPE_TRUST_PROXY === 'true';

/** True when this request arrived over HTTPS as far as we can tell. */
export function requestIsHttps(request: Request): boolean {
	if (request.headers.get('x-forwarded-proto') === 'https') {
		return TRUST_PROXY;
	}
	try {
		return new URL(request.url).protocol === 'https:';
	} catch {
		return false;
	}
}
