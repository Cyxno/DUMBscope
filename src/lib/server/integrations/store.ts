/**
 * Persistence for deep-integration connections.
 *
 * API keys are stored as AES-256-GCM envelopes and are exposed only through
 * {@link getApiKey} for server-side adapter use — never through list/get.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../database/db';
import { decryptSecret, encryptSecret } from '../security/crypto';
import type { IntegrationConfig } from './types';

interface IntegrationRow {
	id: string;
	type: string;
	url: string;
	api_key_enc: string | null;
	enabled: number;
	created_at: number;
	updated_at: number;
	last_test_at: number | null;
	last_test_ok: number | null;
	last_test_error: string | null;
}

function toConfig(row: IntegrationRow): IntegrationConfig {
	return {
		id: row.id,
		type: row.type as IntegrationConfig['type'],
		url: row.url,
		hasApiKey: row.api_key_enc !== null,
		enabled: row.enabled === 1,
		lastTestAt: row.last_test_at,
		lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === 1,
		lastTestError: row.last_test_error
	};
}

export function listIntegrations(): IntegrationConfig[] {
	return getDb()
		.prepare('SELECT * FROM integrations ORDER BY type, id')
		.all()
		.map((r) => toConfig(r as unknown as IntegrationRow));
}

export function getIntegration(id: string): IntegrationConfig | null {
	const row = getDb().prepare('SELECT * FROM integrations WHERE id = ?').get(id) as
		IntegrationRow | undefined;
	return row ? toConfig(row) : null;
}

export function upsertIntegration(input: {
	id: string;
	type: IntegrationConfig['type'];
	url: string;
	enabled: boolean;
}): IntegrationConfig {
	const db = getDb();
	const now = Date.now();
	db.prepare(
		`INSERT INTO integrations (id, type, url, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   url = excluded.url, enabled = excluded.enabled, updated_at = excluded.updated_at`
	).run(input.id, input.type, input.url, input.enabled ? 1 : 0, now, now);
	return getIntegration(input.id)!;
}

/** Store (or replace) the API key. Read-back of the plaintext is impossible. */
export function setApiKey(id: string, apiKey: string): void {
	getDb()
		.prepare('UPDATE integrations SET api_key_enc = ?, updated_at = ? WHERE id = ?')
		.run(encryptSecret(apiKey), Date.now(), id);
}

export function clearApiKey(id: string): void {
	getDb()
		.prepare('UPDATE integrations SET api_key_enc = NULL, updated_at = ? WHERE id = ?')
		.run(Date.now(), id);
}

/** Server-side only: decrypt the stored key for adapter use. */
export function getApiKey(id: string): string | null {
	const row = getDb().prepare('SELECT api_key_enc FROM integrations WHERE id = ?').get(id) as
		{ api_key_enc: string | null } | undefined;
	if (!row?.api_key_enc) return null;
	return decryptSecret(row.api_key_enc);
}

export function deleteIntegration(id: string): void {
	getDb().prepare('DELETE FROM integrations WHERE id = ?').run(id);
}

export function recordIntegrationTest(id: string, ok: boolean, error: string | null): void {
	getDb()
		.prepare(
			'UPDATE integrations SET last_test_at = ?, last_test_ok = ?, last_test_error = ?, updated_at = ? WHERE id = ?'
		)
		.run(Date.now(), ok ? 1 : 0, error, Date.now(), id);
}

/** Stable id for a new integration instance of a type. */
export function newIntegrationId(type: string): string {
	return `${type}-${randomUUID().slice(0, 8)}`;
}
