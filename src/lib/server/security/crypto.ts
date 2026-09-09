/**
 * Password hashing (scrypt) and secret encryption at rest (AES-256-GCM).
 *
 * - Admin passwords: scrypt with per-password random salt, constant-time compare.
 * - DUMB credentials: encrypted with a local application key stored at
 *   `<config>/secret.key` (32 random bytes, mode 0600). Ciphertext format is
 *   versioned: `v1:<iv b64>:<tag b64>:<ciphertext b64>`.
 *
 * No home-grown cryptography — only Node's `crypto` primitives.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../database/db';

const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 32;

export function hashPassword(password: string): string {
	const salt = crypto.randomBytes(16);
	const hash = crypto.scryptSync(password.normalize('NFKC'), salt, KEY_LEN, {
		N: SCRYPT_N,
		r: SCRYPT_r,
		p: SCRYPT_p,
		maxmem: 128 * 1024 * 1024
	});
	return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
	try {
		const [scheme, nStr, rStr, pStr, saltB64, hashB64] = stored.split('$');
		if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
		const N = parseInt(nStr ?? '', 10);
		const r = parseInt(rStr ?? '', 10);
		const p = parseInt(pStr ?? '', 10);
		if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
		const salt = Buffer.from(saltB64, 'base64');
		const expected = Buffer.from(hashB64, 'base64');
		const actual = crypto.scryptSync(password.normalize('NFKC'), salt, expected.length, {
			N,
			r,
			p,
			maxmem: 128 * 1024 * 1024
		});
		return crypto.timingSafeEqual(actual, expected);
	} catch {
		return false;
	}
}

let appKey: Buffer | null = null;

/** Load or create the local application key used for encrypting secrets at rest. */
export function getAppKey(): Buffer {
	if (appKey) return appKey;
	const file = path.join(configDir(), 'secret.key');
	if (fs.existsSync(file)) {
		const raw = fs.readFileSync(file);
		if (raw.length !== 32) {
			throw new Error('secret.key has an unexpected length; refusing to start');
		}
		appKey = raw;
	} else {
		appKey = crypto.randomBytes(32);
		fs.writeFileSync(file, appKey, { mode: 0o600 });
		try {
			fs.chmodSync(file, 0o600);
		} catch {
			// Best effort; some filesystems do not support chmod.
		}
	}
	return appKey;
}

/** Encrypt a secret for storage at rest. Returns a versioned envelope string. */
export function encryptSecret(plaintext: string): string {
	const key = getAppKey();
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/** Decrypt a value produced by {@link encryptSecret}. Returns null when invalid. */
export function decryptSecret(envelope: string): string | null {
	try {
		const [version, ivB64, tagB64, ctB64] = envelope.split(':');
		if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) return null;
		const decipher = crypto.createDecipheriv(
			'aes-256-gcm',
			getAppKey(),
			Buffer.from(ivB64, 'base64')
		);
		decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
		const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
		return pt.toString('utf8');
	} catch {
		return null;
	}
}

export function randomToken(bytes = 32): string {
	return crypto.randomBytes(bytes).toString('base64url');
}

/** Short human-transcribable setup code (no ambiguous characters). */
export function generateSetupCode(): string {
	const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
	const bytes = crypto.randomBytes(8);
	let out = '';
	for (let i = 0; i < 8; i++) {
		out += alphabet[bytes[i]! % alphabet.length];
		if (i === 3) out += '-';
	}
	return out;
}

export function sha256Hex(input: string): string {
	return crypto.createHash('sha256').update(input).digest('hex');
}
