/**
 * Short-lived signed "setup session" cookie used by the first-run wizard after
 * a valid setup code. Stateless: HMAC(appKey, 'setup:<expiry>:<nonce>').
 */
import crypto from 'node:crypto';
import { getAppKey } from './crypto';

export const SETUP_COOKIE = 'dumbscope_setup';
const TTL_MS = 30 * 60 * 1000;

export function issueSetupCookie(): { value: string; maxAgeSeconds: number } {
	const expiresAt = Date.now() + TTL_MS;
	const nonce = crypto.randomBytes(8).toString('hex');
	const payload = `setup:${expiresAt}:${nonce}`;
	const mac = crypto.createHmac('sha256', getAppKey()).update(payload).digest('base64url');
	return { value: `${payload}:${mac}`, maxAgeSeconds: Math.floor(TTL_MS / 1000) };
}

function timingSafeEqualStr(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return crypto.timingSafeEqual(ab, bb);
}

export function verifySetupCookie(cookieValue: string | undefined | null): boolean {
	if (!cookieValue) return false;
	const parts = cookieValue.split(':');
	if (parts.length !== 4) return false;
	const [kind, expiresAt, nonce, mac] = parts as [string, string, string, string];
	if (kind !== 'setup') return false;
	const expiry = Number(expiresAt);
	if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
	const expected = crypto
		.createHmac('sha256', getAppKey())
		.update(`${kind}:${expiresAt}:${nonce}`)
		.digest('base64url');
	return timingSafeEqualStr(mac, expected);
}
