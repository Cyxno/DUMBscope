/**
 * ConnectivityTracker: the single writer behind the hub's connection state
 * (FASE A reliability).
 *
 * Production incident (2026-09-13): the hub's connection state used to have
 * several independent writers. A failed REST bootstrap forced state='offline'
 * and clobbered live stream flags; a later successful bootstrap only patched
 * the rest flag and never recomputed the overall state. With the WebSocket
 * streams quietly live, no further transition ever fired and the false
 * "DUMB gateway unreachable" state (and its critical incident) stuck for 8+
 * hours while DUMB was healthy.
 *
 * Fix: the state is *derived*, never assigned. Every consumer asks
 `snapshot()`, which recomputes from current layer facts — stream sockets,
 * REST/auth probe results and data freshness. There is no code path that can
 * leave a stale verdict behind: when facts change, the next snapshot changes.
 *
 * Amber semantics (brief §4/§5/§12):
 * - `starting`  — bounded grace after DUMBscope/hub start; DUMB may still be
 *   booting after a host reboot. Exits on the first real success; it is a
 *   ceiling, not a fixed delay.
 * - `reconnecting` — contact existed before and dropped (DUMB restart
 *   suspected); bounded recovery window while backoff retries run.
 * - `degraded` — honest partial state: HTTP/REST reachable but streams down,
 *   or only some streams delivering.
 * Only `offline` claims DUMB is genuinely unreachable, and only after the
 * grace windows expired with failing probes.
 */
import type {
	ConnectionProbe,
	ConnectionSnapshot,
	ConnectionState,
	StreamName
} from '$lib/types';

export const CONNECTIVITY_TUNING = {
	/** Amber ceiling after DUMBscope/hub start while DUMB may still be booting.
	 *  Exits immediately on the first successful probe or data frame. */
	startupGraceMs: 120_000,
	/** Amber ceiling for re-establishing contact after a lost connection
	 *  (DUMB restart suspected). */
	recoveryGraceMs: 90_000,
	/** A REST probe result counts as "reachable" for the degraded derivation.
	 *  Matches the periodic discovery-refresh cadence so a healthy stack never
	 *  flips back to amber between refreshes. */
	probeFreshMs: 10 * 60_000,
	/** Connected but no data for this long → stale. */
	staleAfterMs: 90_000
} as const;

export interface ProbeResult {
	ok: boolean;
	code?: ConnectionProbe['code'];
	detail?: string | null;
}

export interface ConnectivityTrackerOptions {
	now?: () => number;
	startupGraceMs?: number;
	recoveryGraceMs?: number;
	probeFreshMs?: number;
	staleAfterMs?: number;
}

const STREAM_NAMES: StreamName[] = ['rest', 'status', 'metrics', 'logs'];

function emptyProbe(): ConnectionProbe {
	return { status: 'unknown', code: null, detail: null, at: null, okAt: null };
}

/**
 * Classify a failed DUMB request into a stable probe code plus a plain-language
 * detail (brief §6/§186): "connection refused", "timed out after 10s", DNS
 * failure, HTTP status — never raw errno in user-facing copy.
 */
export function classifyProbeError(err: unknown): { code: ConnectionProbe['code']; detail: string } {
	if (err instanceof Error && err.name === 'AbortError') {
		return { code: 'timeout', detail: 'request timed out' };
	}
	const causeCode =
		err instanceof Error && err.cause instanceof Error && 'code' in err.cause
			? String((err.cause as { code?: unknown }).code ?? '')
			: '';
	switch (causeCode) {
		case 'ECONNREFUSED':
			return { code: 'refused', detail: 'connection refused' };
		case 'ENOTFOUND':
		case 'EAI_AGAIN':
			return { code: 'dns', detail: 'hostname could not be resolved' };
		case 'ETIMEDOUT':
			return { code: 'timeout', detail: 'connection timed out' };
		case 'ECONNRESET':
		case 'EPIPE':
			return { code: 'network', detail: 'connection reset' };
		case 'EHOSTUNREACH':
		case 'ENETUNREACH':
			return { code: 'network', detail: 'host unreachable' };
		default:
			break;
	}
	const status = (err as { status?: number | null }).status ?? null;
	if (typeof status === 'number' && status >= 400) {
		if (status === 401 || status === 403) {
			return { code: 'auth-rejected', detail: `authentication rejected (HTTP ${status})` };
		}
		return { code: 'http-error', detail: `HTTP ${status}` };
	}
	const message = err instanceof Error ? err.message : String(err);
	return { code: 'error', detail: message || 'request failed' };
}

export class ConnectivityTracker {
	private readonly nowFn: () => number;
	private readonly startupGraceMs: number;
	private readonly recoveryGraceMs: number;
	private readonly probeFreshMs: number;
	private readonly staleAfterMs: number;

	private configured = false;
	private credentialsInvalid = false;
	private streams: Record<StreamName, ConnectionState> = {
		rest: 'unconfigured',
		status: 'connecting',
		metrics: 'connecting',
		logs: 'connecting'
	};
	private probes: Record<'http' | 'auth' | 'rest', ConnectionProbe> = {
		http: emptyProbe(),
		auth: emptyProbe(),
		rest: emptyProbe()
	};

	private bootAt: number;
	private lastUpdateAt: number | null = null;
	private lastSuccessAt: number | null = null;
	private connectedSince: number | null = null;
	/** Instant the current working mode fully broke (both core streams lost,
	 *  or the last fresh layer failed with nothing left) — starts the bounded
	 *  recovery window. */
	private sessionLostAt: number | null = null;
	private lastError: string | null = null;
	private reconnectAttempts = 0;
	private dumbVersion: string | null = null;
	private authMode: ConnectionSnapshot['authMode'] = 'unknown';
	private lastState: ConnectionState = 'starting';
	private stateSince: number | null = null;

	constructor(options: ConnectivityTrackerOptions = {}) {
		this.nowFn = options.now ?? (() => Date.now());
		this.startupGraceMs = options.startupGraceMs ?? CONNECTIVITY_TUNING.startupGraceMs;
		this.recoveryGraceMs = options.recoveryGraceMs ?? CONNECTIVITY_TUNING.recoveryGraceMs;
		this.probeFreshMs = options.probeFreshMs ?? CONNECTIVITY_TUNING.probeFreshMs;
		this.staleAfterMs = options.staleAfterMs ?? CONNECTIVITY_TUNING.staleAfterMs;
		this.bootAt = this.nowFn();
	}

	// -------------------------------------------------------------------------
	// Facts in
	// -------------------------------------------------------------------------

	/** Hub (re)started: fresh boot clock and stream sockets, contact history
	 *  (last successful contact, probes) is preserved — a stale-bounce reload
	 *  must not erase evidence. */
	hubRestart(): void {
		this.bootAt = this.nowFn();
		this.streams = { rest: this.streams.rest, status: 'connecting', metrics: 'connecting', logs: 'connecting' };
		this.credentialsInvalid = false;
		// A reload drops live sockets: if contact existed before, this instant
		// starts the recovery window (never an unbounded sticky state).
		if (this.lastSuccessAt !== null) this.sessionLostAt ??= this.nowFn();
	}

	setConfigured(configured: boolean): void {
		this.configured = configured;
		if (configured) this.streams.rest = 'connecting';
	}

	/** REST bootstrap hit an unrecoverable auth wall. */
	noteCredentialsInvalid(detail: string | null): void {
		this.credentialsInvalid = true;
		this.lastError = detail;
	}

	setLastError(detail: string | null): void {
		this.lastError = detail;
	}

	setAuthMode(mode: ConnectionSnapshot['authMode']): void {
		this.authMode = mode;
	}

	setDumbVersion(version: string | null): void {
		this.dumbVersion = version;
	}

	setReconnectAttempts(attempts: number): void {
		this.reconnectAttempts = attempts;
	}

	/** One WebSocket stream reported a state change. */
	streamState(name: Exclude<StreamName, 'rest'>, state: ConnectionState): void {
		const wasLive = this.streams[name] === 'live';
		this.streams[name] = state;
		const now = this.nowFn();
		if (name !== 'status' && name !== 'metrics') return;
		const coreBothLive =
			this.streams.status === 'live' && this.streams.metrics === 'live';
		const anyCoreLive = this.streams.status === 'live' || this.streams.metrics === 'live';
		if (coreBothLive) {
			// The working mode is fully restored — reset the recovery clock.
			this.sessionLostAt = null;
		} else if (wasLive && state !== 'live' && !anyCoreLive) {
			// The last core stream just died: full loss, recovery clock starts.
			this.sessionLostAt ??= now;
		}
	}

	/** One layered probe (http | auth | rest) completed. */
	probe(layer: 'http' | 'auth' | 'rest', result: ProbeResult): void {
		const now = this.nowFn();
		const current = this.probes[layer];
		this.probes[layer] = {
			status: result.ok ? 'ok' : 'failed',
			code: result.ok ? null : (result.code ?? 'error'),
			detail: result.ok ? null : (result.detail ?? null),
			at: now,
			okAt: result.ok ? now : current.okAt
		};
		if (result.ok) {
			this.lastSuccessAt = now;
			// A REST success re-opens a partial (REST-only) working mode.
			if (layer === 'rest') {
				this.credentialsInvalid = false;
				const coreBothLive =
					this.streams.status === 'live' && this.streams.metrics === 'live';
				if (!coreBothLive) this.sessionLostAt = null;
			}
		} else if (
			layer === 'rest' &&
			this.lastSuccessAt !== null &&
			this.restRecentlyOkBefore(now, current.okAt)
		) {
			// The last fresh layer failed with nothing delivering: this instant
			// starts the recovery window.
			this.sessionLostAt ??= now;
		}
	}

	/** Real telemetry arrived (status frame, metrics snapshot, log line). */
	dataReceived(at?: number): void {
		const now = at ?? this.nowFn();
		this.lastUpdateAt = now;
		this.lastSuccessAt = now;
	}

	// -------------------------------------------------------------------------
	// Derived snapshot
	// -------------------------------------------------------------------------

	snapshot(): ConnectionSnapshot {
		const now = this.nowFn();
		const next = this.derive(now);

		if (next !== this.lastState) {
			this.stateSince = now;
			if (next === 'live' && this.lastState !== 'live') this.connectedSince = now;
			this.lastState = next;
		}
		if (this.stateSince === null) this.stateSince = now;

		return {
			state: next,
			streams: { ...this.streams, rest: this.restStreamState(now) },
			lastUpdateAt: this.lastUpdateAt,
			lastSuccessAt: this.lastSuccessAt,
			connectedSince: this.connectedSince,
			stateSince: this.stateSince,
			lastError: this.lastError,
			reconnectAttempts: this.reconnectAttempts,
			dumbVersion: this.dumbVersion,
			authMode: this.authMode,
			probes: {
				http: { ...this.probes.http },
				auth: { ...this.probes.auth },
				rest: { ...this.probes.rest }
			}
		};
	}

	// -------------------------------------------------------------------------
	// Derivation — the only place a verdict is formed
	// -------------------------------------------------------------------------

	private derive(now: number): ConnectionState {
		if (!this.configured) return 'unconfigured';
		if (this.credentialsInvalid) return 'credentials-invalid';

		const status = this.streams.status;
		const metrics = this.streams.metrics;
		const logs = this.streams.logs;
		const coreBothLive = status === 'live' && metrics === 'live';

		// Data freshness overrules nominal sockets: connected but frozen.
		const dataFrozen =
			this.lastUpdateAt !== null && now - this.lastUpdateAt > this.staleAfterMs;
		if (status === 'stale' || metrics === 'stale') return 'stale';
		if (coreBothLive) return dataFrozen ? 'stale' : 'live';

		// The full working mode broke at a known instant (both core streams
		// lost, hub reload with prior contact, or the last fresh layer failed).
		// It is being re-established: amber within the recovery window, then an
		// honest offline verdict. A stale REST success must not mask this.
		if (this.sessionLostAt !== null) {
			return now - this.sessionLostAt <= this.recoveryGraceMs ? 'reconnecting' : 'offline';
		}

		// Partial WebSocket connectivity.
		if (status === 'live' || metrics === 'live' || logs === 'live') return 'degraded';

		// REST reachable but streams unavailable: honest partial state, not a
		// blanket "unreachable" (brief §6).
		if (this.restRecentlyOk(now)) return 'degraded';

		// No layer is delivering. Grace semantics apply — amber first, only
		// then offline (brief §5/§12).
		if (this.lastSuccessAt === null) {
			return now - this.bootAt <= this.startupGraceMs ? 'starting' : 'offline';
		}
		// Had success and no recorded loss instant (e.g. first evaluation after
		// hydrate): treat as within the recovery window until probes fail
		// again — never sticky offline without evidence.
		return 'reconnecting';
	}

	private restStreamState(now: number): ConnectionState {
		if (this.credentialsInvalid) return 'credentials-invalid';
		if (!this.configured) return 'unconfigured';
		const rest = this.probes.rest;
		if (rest.okAt !== null && now - rest.okAt <= this.probeFreshMs) return 'live';
		if (rest.status === 'failed') return 'reconnecting';
		return 'connecting';
	}

	private restRecentlyOk(now: number): boolean {
		const okAt = this.probes.rest.okAt;
		return okAt !== null && now - okAt <= this.probeFreshMs;
	}

	/** Whether the rest probe was fresh *before* this failure recorded. */
	private restRecentlyOkBefore(now: number, okAtBefore: number | null): boolean {
		return okAtBefore !== null && now - okAtBefore <= this.probeFreshMs;
	}
}
