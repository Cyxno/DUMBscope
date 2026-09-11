/**
 * In-process integration manager: registry, polling scheduler, cache and
 * failure isolation (brief §53–§56).
 *
 * - One manager per process, started lazily on first request (like the hub).
 * - Each configured integration gets poller tasks; every task is failure
 *   isolated: an error only affects that integration's own status.
 * - Polling adapts: exponential backoff on failures, jitter so integrations
 *   never fire in lockstep. No browser request ever hits a service API
 *   directly — browsers read DUMBscope state (cache + last poll).
 */
import { randomUUID } from 'node:crypto';
import { getApiKey, getIntegration, listIntegrations, recordIntegrationTest } from './store';
import type {
	ActivityEvent,
	IntegrationConfig,
	IntegrationState,
	IntegrationStatus,
	IntegrationType
} from './types';
import { insertActivity } from './activity';

/** How often the diagnostics "next poll" view refreshes its math. */
const JITTER_FRACTION = 0.1;
const MAX_BACKOFF_MULTIPLIER = 8;
const MAX_BACKOFF_MS = 10 * 60_000;

export interface PollContext {
	config: IntegrationConfig;
	apiKey: string | null;
	/** Cached payload read/write with TTL; browsers read these values. */
	cache: {
		get<T>(key: string): T | null;
		set<T>(key: string, value: T, ttlMs: number): void;
	};
	/** Emit semantic activity events (deduplicated by id). */
	emit(events: ActivityEvent[]): void;
	/** Mark the connection status; state errors are classified automatically. */
	ok(version?: string | null, latencyMs?: number): void;
	failed(err: unknown): void;
}

export interface PollerSpec {
	name: string;
	intervalMs: number;
	run: (ctx: PollContext) => Promise<void>;
}

const stateListeners = new Set<(statuses: { id: string; failures: number }[]) => void>();

/** Subscribe to integration state changes (hub feeds the incident engine). */
export function onIntegrationStateChange(
	listener: (statuses: { id: string; failures: number }[]) => void
): () => void {
	stateListeners.add(listener);
	return () => stateListeners.delete(listener);
}

function notifyStateChange(): void {
	const snapshot = [...entries.values()].map((e) => ({
		id: e.config.id,
		failures: e.status.consecutiveFailures
	}));
	for (const listener of stateListeners) {
		try {
			listener(snapshot);
		} catch {
			// A broken listener must never break polling.
		}
	}
}

export interface IntegrationAdapter {
	type: IntegrationType;
	/** Cheap reachability + version probe used by the Settings test button. */
	test(config: IntegrationConfig, apiKey: string | null): Promise<{ version?: string }>;
	/** Data pollers; only ones relevant to the type are registered. */
	pollers(config: IntegrationConfig): PollerSpec[];
}

interface PollerEntry {
	spec: PollerSpec;
	timer: ReturnType<typeof setTimeout> | null;
	running: boolean;
	failures: number;
	/** Diagnostics (brief §3): per-poller observability, no credentials. */
	lastRunAt: number | null;
	lastOkAt: number | null;
	lastError: string | null;
	nextRunAt: number | null;
}

interface Entry {
	config: IntegrationConfig;
	status: IntegrationStatus;
	cache: Map<string, { value: unknown; expiresAt: number }>;
	pollers: PollerEntry[];
	lastTokenRefreshAt: number;
}

const entries = new Map<string, Entry>();
const adapters = new Map<IntegrationType, IntegrationAdapter>();
let started = false;

/** Read-only cache access for API routes (library intelligence, overview). */
export function readIntegrationCache<T>(id: string, key: string): T | null {
	const entry = entries.get(id);
	if (!entry) return null;
	const hit = entry.cache.get(key);
	return hit && hit.expiresAt > Date.now() ? (hit.value as T) : null;
}

/** Metadata for cache reading: which integrations exist and their type. */
export function listIntegrationTypes(): {
	id: string;
	type: IntegrationType;
	enabled: boolean;
}[] {
	return [...entries.values()].map((e) => ({
		id: e.config.id,
		type: e.config.type,
		enabled: e.config.enabled !== false
	}));
}

export function registerAdapter(adapter: IntegrationAdapter): void {
	adapters.set(adapter.type, adapter);
}

/** Error bodies from third-party services can be huge; store a bounded form. */
function truncateError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return message.length > 300 ? message.slice(0, 300) + '… [truncated]' : message;
}

function classifyError(err: unknown): IntegrationState {
	const message = err instanceof Error ? err.message : String(err);
	if (/\b(401|403)\b|api key|unauthorized|credential/i.test(message)) return 'auth_error';
	if (/\b(404|400)\b|version|not found/i.test(message)) return 'unsupported_version';
	if (/timeout|aborted|econnrefused|enotfound|eai_again|could not reach|network/i.test(message))
		return 'unreachable';
	return 'error';
}

function entryFor(config: IntegrationConfig): Entry {
	let entry = entries.get(config.id);
	if (!entry || entry.config.type !== config.type) {
		entry = {
			config,
			status: {
				id: config.id,
				type: config.type,
				state: config.enabled ? 'connecting' : 'disabled',
				version: null,
				latencyMs: null,
				lastSuccessAt: null,
				lastError: null,
				consecutiveFailures: 0,
				nextPollAt: null,
				pollers: []
			},
			cache: new Map(),
			pollers: [],
			lastTokenRefreshAt: 0
		};
		entries.set(config.id, entry);
	}
	return entry;
}

function jitter(ms: number): number {
	return Math.round(ms * (1 - JITTER_FRACTION + Math.random() * 2 * JITTER_FRACTION));
}

function schedulePoll(entry: Entry, poller: PollerEntry, delayMs: number): void {
	const wait = Math.max(250, delayMs);
	if (poller.timer) clearTimeout(poller.timer);
	poller.timer = setTimeout(() => void runPoller(entry, poller), wait);
	poller.nextRunAt = Date.now() + wait;
	entry.status.nextPollAt = Math.min(
		entry.status.nextPollAt ?? Number.MAX_SAFE_INTEGER,
		Date.now() + wait
	);
}

async function runPoller(entry: Entry, poller: PollerEntry): Promise<void> {
	if (poller.running) {
		// Overlap guard: never stack runs of the same task, but keep the
		// cadence alive — a dead scheduler here would silence the poller
		// until the next config change.
		schedulePoll(entry, poller, 1_000);
		return;
	}
	if (entry.config.enabled === false) return;
	poller.running = true;
	poller.lastRunAt = Date.now();
	const adapter = adapters.get(entry.config.type);
	try {
		if (!adapter) throw new Error(`no adapter for ${entry.config.type}`);
		const apiKey = getApiKey(entry.config.id);
		const ctx: PollContext = {
			config: entry.config,
			apiKey,
			cache: {
				get: <T>(key: string) => {
					const hit = entry.cache.get(key);
					return hit && hit.expiresAt > Date.now() ? (hit.value as T) : null;
				},
				set: <T>(key: string, value: T, ttlMs: number) => {
					entry.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
				}
			},
			emit: (events) => {
				for (const e of events) if (!e.id) e.id = randomUUID();
				insertActivity(events);
			},
			ok: (version, latencyMs) => {
				entry.status.state = 'connected';
				entry.status.lastError = null;
				entry.status.consecutiveFailures = 0;
				notifyStateChange();
				entry.status.lastSuccessAt = Date.now();
				if (version !== undefined) entry.status.version = version;
				if (latencyMs !== undefined) entry.status.latencyMs = latencyMs;
			},
			failed: (err) => {
				entry.status.consecutiveFailures += 1;
				notifyStateChange();
				entry.status.state = classifyError(err);
				entry.status.lastError = truncateError(err);
			}
		};
		await poller.spec.run(ctx);
		poller.failures = 0;
		poller.lastOkAt = Date.now();
		poller.lastError = null;
		if (entry.status.state === 'connecting') entry.status.state = 'connected';
	} catch (err) {
		poller.failures += 1;
		entry.status.consecutiveFailures += 1;
		entry.status.state = classifyError(err);
		entry.status.lastError = truncateError(err);
		poller.lastError = entry.status.lastError;
	} finally {
		poller.running = false;
		poller.lastRunAt = Date.now();
		if (entry.status.lastError) poller.lastError = entry.status.lastError;
		// Backoff policy (brief §2): a single failure retries quickly (60s)
		// so a transient error never silences a poller for its whole interval;
		// sustained failures grow exponentially up to the cap.
		const delay =
			poller.failures <= 0
				? poller.spec.intervalMs
				: poller.failures === 1
					? Math.min(60_000, poller.spec.intervalMs)
					: Math.min(
							poller.spec.intervalMs * 2 ** Math.min(poller.failures - 1, MAX_BACKOFF_MULTIPLIER),
							MAX_BACKOFF_MS
						);
		schedulePoll(entry, poller, jitter(delay));
	}
}

/**
 * Force every poller of an integration to run right away (brief §2). Used
 * after config changes / successful tests so fresh, correct configuration is
 * never stuck behind an old backoff. Running pollers are not overlapped.
 */
export function triggerNow(integrationId: string): void {
	const entry = entries.get(integrationId);
	if (!entry) return;
	for (const poller of entry.pollers) {
		if (poller.running) continue;
		schedulePoll(entry, poller, 250);
	}
}

function startEntry(config: IntegrationConfig): void {
	const adapter = adapters.get(config.type);
	if (!adapter) return;
	const entry = entryFor(config);
	entry.config = config;
	entry.status.state = config.enabled ? 'connecting' : 'disabled';
	entry.pollers = [];
	if (!config.enabled) return;
	for (const spec of adapter.pollers(config)) {
		const poller: PollerEntry = {
			spec,
			timer: null,
			running: false,
			failures: 0,
			lastRunAt: null,
			lastOkAt: null,
			lastError: null,
			nextRunAt: null
		};
		entry.pollers.push(poller);
		// Stagger initial runs so a dozen integrations never poll in lockstep.
		schedulePoll(entry, poller, jitter(2_000 + Math.random() * 10_000));
	}
}

/** Idempotent: (re)starts pollers for every configured integration. */
export function ensureIntegrationsStarted(): void {
	if (started) return;
	started = true;
	for (const config of listIntegrations()) startEntry(config);
}

/** Called after settings changes: restarts pollers for the affected id. */
export function reloadIntegration(id: string): void {
	const config = getIntegration(id);
	const existing = entries.get(id);
	if (existing) {
		for (const p of existing.pollers) if (p.timer) clearTimeout(p.timer);
		entries.delete(id);
	}
	if (config) startEntry(config);
}

function statusView(entry: Entry): IntegrationStatus {
	return {
		...entry.status,
		pollers: entry.pollers.map((p) => ({
			name: p.spec.name,
			intervalMs: p.spec.intervalMs,
			lastRunAt: p.lastRunAt,
			lastOkAt: p.lastOkAt,
			lastError: p.lastError,
			nextRunAt: p.nextRunAt
		}))
	};
}

export function getIntegrationStatuses(): IntegrationStatus[] {
	return [...entries.values()].map(statusView);
}

export function getIntegrationStatus(id: string): IntegrationStatus | null {
	const entry = entries.get(id);
	return entry ? statusView(entry) : null;
}

/** Read cached poll data for API routes (never triggers a service call). */
export function getCachedData<T>(id: string, key: string): T | null {
	const hit = entries.get(id)?.cache.get(key);
	return hit && hit.expiresAt > Date.now() ? (hit.value as T) : null;
}

/** Whole cache for an integration, keyed by poller cache-key. */
export function getIntegrationCache(id: string): Record<string, unknown> {
	const entry = entries.get(id);
	if (!entry) return {};
	const out: Record<string, unknown> = {};
	for (const [key, hit] of entry.cache) {
		if (hit.expiresAt > Date.now()) out[key] = hit.value;
	}
	return out;
}

/** Settings "Test connection": probe + persist the result. */
export async function testIntegration(
	id: string
): Promise<{ ok: boolean; version: string | null; error: string | null }> {
	const config = getIntegration(id);
	if (!config) return { ok: false, version: null, error: 'Unknown integration' };
	const adapter = adapters.get(config.type);
	if (!adapter) return { ok: false, version: null, error: 'No adapter for this type' };
	try {
		const result = await adapter.test(config, getApiKey(id));
		recordIntegrationTest(id, true, null);
		return { ok: true, version: result.version ?? null, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		recordIntegrationTest(id, false, message);
		return { ok: false, version: null, error: message };
	}
}

export type { IntegrationConfig };
