/**
 * First-run setup protection.
 *
 * When no admin account exists, DUMBscope prints a short-lived setup code to
 * the container log. The wizard requires this code before it will accept a
 * DUMB URL or create the admin account. Codes live in memory only (hashed),
 * expire after 30 minutes and verification is rate limited.
 */
import { generateSetupCode, sha256Hex } from './security/crypto';
import { rateLimit, resetRateLimit } from './security/rate-limit';

const CODE_TTL_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

interface ActiveCode {
	hash: string;
	expiresAt: number;
}

let active: ActiveCode | null = null;

export function issueSetupCode(reason: 'startup' | 'expired' = 'startup'): string {
	const code = process.env.DUMBSCOPE_SETUP_CODE || generateSetupCode();
	active = { hash: sha256Hex(code), expiresAt: Date.now() + CODE_TTL_MS };
	const expiry = new Date(active.expiresAt).toISOString();
	console.log(
		`[dumbscope] ==============================================================\n` +
			`[dumbscope]  DUMBscope is not configured yet.\n` +
			`[dumbscope]  Setup code (${reason}): ${code}\n` +
			`[dumbscope]  Valid until ${expiry} — enter it in the setup wizard.\n` +
			`[dumbscope] ==============================================================`
	);
	return code;
}

export function setupNeeded(): boolean {
	return active === null || Date.now() > active.expiresAt;
}

/** Verify a setup code. Returns false when wrong, expired or rate limited. */
export function verifySetupCode(code: string, clientKey: string): boolean {
	const limit = rateLimit(`setup:${clientKey}`, MAX_ATTEMPTS, ATTEMPT_WINDOW_MS);
	if (!limit.allowed) return false;
	if (!active || Date.now() > active.expiresAt) return false;
	if (sha256Hex(code.trim().toUpperCase()) !== active.hash) return false;
	resetRateLimit(`setup:${clientKey}`);
	return true;
}

export function clearSetupCode(): void {
	active = null;
}
