/**
 * Admin session management backed by SQLite.
 *
 * The session cookie holds a random token; the database stores only its SHA-256
 * hash. Cookies are HttpOnly + SameSite=Lax; `Secure` is applied when the app
 * runs behind a trusted proxy that reports HTTPS.
 */
import { getDb } from '../database/db';
import { randomToken, sha256Hex } from './crypto';

export const SESSION_COOKIE = 'dumbscope_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionUser {
	id: number;
	username: string;
}

export function createSession(userId: number, userAgent: string | null): string {
	const token = randomToken(32);
	const db = getDb();
	const now = Date.now();
	db.prepare(
		'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
	).run(sha256Hex(token), userId, now, now + SESSION_TTL_MS, now, userAgent?.slice(0, 200) ?? null);
	// Opportunistic cleanup of expired sessions.
	db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
	return token;
}

export function getSessionUser(token: string | undefined | null): SessionUser | null {
	if (!token) return null;
	const db = getDb();
	const row = db
		.prepare(
			`SELECT s.id AS session_id, s.expires_at, u.id AS user_id, u.username
			 FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.id = ?`
		)
		.get(sha256Hex(token));
	if (!row) return null;
	const expiresAt = row.expires_at as number;
	if (Date.now() > expiresAt) {
		db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256Hex(token));
		return null;
	}
	// Sliding expiry, throttled to once per hour per session.
	if (expiresAt - Date.now() < SESSION_TTL_MS - 60 * 60 * 1000) {
		db.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?').run(
			Date.now() + SESSION_TTL_MS,
			Date.now(),
			sha256Hex(token)
		);
	}
	return { id: row.user_id as number, username: row.username as string };
}

export function destroySession(token: string | undefined | null): void {
	if (!token) return;
	getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sha256Hex(token));
}

export function destroyAllSessionsForUser(userId: number): void {
	getDb().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function sessionCount(): number {
	const row = getDb().prepare('SELECT COUNT(*) AS c FROM sessions').get();
	return (row?.c as number) ?? 0;
}

/** True when at least one admin account exists (i.e. setup has completed). */
export function hasAdminUser(): boolean {
	const row = getDb().prepare('SELECT COUNT(*) AS c FROM users').get();
	return ((row?.c as number) ?? 0) > 0;
}

export function createAdminUser(username: string, passwordHash: string): number {
	const db = getDb();
	const result = db
		.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
		.run(username.toLowerCase(), passwordHash, Date.now());
	return Number(result.lastInsertRowid);
}

export function findUserByUsername(
	username: string
): { id: number; username: string; passwordHash: string } | null {
	const row = getDb()
		.prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
		.get(username.toLowerCase());
	if (!row) return null;
	return {
		id: row.id as number,
		username: row.username as string,
		passwordHash: row.password_hash as string
	};
}

export function touchLastLogin(userId: number): void {
	getDb().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), userId);
}

export function changePassword(userId: number, passwordHash: string): void {
	getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}
