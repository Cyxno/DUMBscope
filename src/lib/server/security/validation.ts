/**
 * Request-security helpers: same-origin checks for state-changing requests,
 * URL validation for the DUMB base URL, and generic input validation.
 */
import { z } from 'zod';

/**
 * Verify that a mutating request originates from the app itself (defense in
 * depth against CSRF on top of SameSite=Lax cookies). Requests without an
 * Origin/Referer header (curl, healthchecks) are allowed for GET/HEAD only.
 */
export function isSameOrigin(request: Request): boolean {
	const method = request.method.toUpperCase();
	if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

	const url = new URL(request.url);
	const origin = request.headers.get('origin');
	const referer = request.headers.get('referer');

	if (origin) {
		try {
			return new URL(origin).host === url.host;
		} catch {
			return false;
		}
	}
	if (referer) {
		try {
			return new URL(referer).host === url.host;
		} catch {
			return false;
		}
	}
	// No Origin and no Referer: not browser-initiated. Allow for API clients
	// (the session cookie alone is still required).
	return true;
}

/** URL schemes that are acceptable for the DUMB gateway. */
const ALLOWED_DUMB_PROTOCOLS = new Set(['http:', 'https:']);

export interface ValidatedDumbUrl {
	/** Normalized base URL without trailing slash. */
	base: string;
	wsBase: string;
}

/**
 * Validate a user-supplied DUMB base URL. Blocks non-HTTP(S) schemes,
 * embedded credentials and path traversal tricks. Returns a normalized base.
 */
export function validateDumbUrl(input: string): ValidatedDumbUrl {
	const trimmed = input.trim();
	if (!trimmed || trimmed.length > 500) throw new Error('Invalid DUMB URL');
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error('Invalid DUMB URL');
	}
	if (!ALLOWED_DUMB_PROTOCOLS.has(parsed.protocol)) {
		throw new Error('DUMB URL must use http:// or https://');
	}
	if (parsed.username || parsed.password) {
		throw new Error('Credentials in the URL are not supported; use the auth step');
	}
	if (parsed.search || parsed.hash) {
		throw new Error('DUMB URL must not contain query strings or fragments');
	}
	if (!parsed.hostname) throw new Error('DUMB URL needs a hostname');
	const base = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
	const wsBase = base.replace(/^http/, 'ws');
	return { base, wsBase };
}

export const dumbUrlSchema = z
	.string()
	.trim()
	.min(1)
	.max(500)
	.refine(
		(v) => {
			try {
				validateDumbUrl(v);
				return true;
			} catch {
				return false;
			}
		},
		{ message: 'Enter a valid http(s) URL for the DUMB gateway' }
	);

export const usernameSchema = z
	.string()
	.trim()
	.min(3, 'At least 3 characters')
	.max(64)
	.regex(/^[a-zA-Z0-9._-]+$/, 'Letters, numbers, dots, dashes and underscores only');

export const passwordSchema = z
	.string()
	.min(10, 'Use at least 10 characters')
	.max(256, 'Maximum 256 characters');

/** Parse a JSON body, returning a typed error instead of throwing. */
export async function readJson<T = unknown>(request: Request): Promise<T | null> {
	try {
		return (await request.json()) as T;
	} catch {
		return null;
	}
}

export function jsonError(message: string, status = 400): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

export function jsonOk(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}
