/**
 * Resilient outbound WebSocket connection to one DUMB stream.
 *
 * Features: exponential backoff with jitter, ping/pong keepalive, stale
 * detection, connection-state tracking and clean teardown. Payload handling is
 * delegated to the `onMessage` callback; reconnect decisions stay here.
 */
import type { ConnectionState } from '$lib/types';

export interface DumbStreamOptions {
	name: 'status' | 'metrics' | 'logs';
	url: () => string;
	onMessage: (data: string) => void;
	onStateChange: (state: ConnectionState, detail?: { error?: string }) => void;
	/** Consider the stream stale when no message arrived for this long. */
	staleAfterMs?: number;
	/** Send a ping when idle for this long (logs stream only). */
	pingAfterMs?: number;
	maxBackoffMs?: number;
}

export class DumbStream {
	private ws: WebSocket | null = null;
	private state: ConnectionState = 'connecting';
	private attempts = 0;
	private lastMessageAt = 0;
	private closedByUs = false;
	private staleTimer: ReturnType<typeof setInterval> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private connectTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly options: DumbStreamOptions) {}

	start(): void {
		this.closedByUs = false;
		this.connect();
	}

	stop(): void {
		this.closedByUs = true;
		this.clearTimers();
		if (this.connectTimer) {
			clearTimeout(this.connectTimer);
			this.connectTimer = null;
		}
		this.ws?.close(1000, 'dumbscope stopping');
		this.ws = null;
		this.setState('offline');
	}

	get connectionState(): ConnectionState {
		return this.state;
	}

	get reconnectAttempts(): number {
		return this.attempts;
	}

	get lastMessageAtMs(): number {
		return this.lastMessageAt;
	}

	private setState(state: ConnectionState, detail?: { error?: string }, force = false): void {
		if (force || this.state !== state) {
			this.state = state;
			this.options.onStateChange(state, detail);
		}
	}

	private clearTimers(): void {
		if (this.staleTimer) {
			clearInterval(this.staleTimer);
			this.staleTimer = null;
		}
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}

	private connect(): void {
		if (this.closedByUs) return;
		const url = this.options.url();
		this.clearTimers();
		this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting', undefined, true);

		let ws: WebSocket;
		try {
			ws = new WebSocket(url);
		} catch (err) {
			this.scheduleReconnect(err instanceof Error ? err.message : 'WebSocket construction failed');
			return;
		}
		this.ws = ws;

		ws.onopen = () => {
			this.attempts = 0;
			this.lastMessageAt = Date.now();
			this.setState('live');
			this.startTimers();
		};

		ws.onmessage = (event: MessageEvent) => {
			this.lastMessageAt = Date.now();
			const data = typeof event.data === 'string' ? event.data : '';
			if (data.length > 0) this.options.onMessage(data);
		};

		ws.onerror = () => {
			// Node's WebSocket fires only 'error' on a failed handshake (e.g. 401);
			// treat it as a connection failure so reconnect logic engages.
			if (this.state === 'live') {
				this.setState('reconnecting', { error: 'stream error' });
			} else if (!this.connectTimer && !this.closedByUs) {
				this.scheduleReconnect('stream error');
			}
		};

		ws.onclose = (event: CloseEvent) => {
			this.clearTimers();
			this.ws = null;
			if (this.closedByUs) {
				this.setState('offline');
				return;
			}
			if (this.connectTimer) {
				// onerror already scheduled a reconnect.
				return;
			}
			// 440x codes are DUMB-specific auth failures; do not hot-loop those.
			const authRejection = event.code === 4401 || event.code === 4403;
			this.scheduleReconnect(
				authRejection ? 'authentication rejected by DUMB' : `connection closed (${event.code})`,
				authRejection ? 15_000 : undefined
			);
		};
	}

	private startTimers(): void {
		const staleAfterMs = this.options.staleAfterMs ?? 60_000;
		this.staleTimer = setInterval(() => {
			if (this.state === 'live' && Date.now() - this.lastMessageAt > staleAfterMs) {
				this.setState('stale');
			} else if (this.state === 'stale' && Date.now() - this.lastMessageAt <= staleAfterMs) {
				this.setState('live');
			}
		}, 5_000);

		const pingAfterMs = this.options.pingAfterMs;
		if (pingAfterMs) {
			this.pingTimer = setInterval(() => {
				if (this.ws?.readyState === WebSocket.OPEN) {
					try {
						this.ws.send(JSON.stringify({ type: 'ping' }));
					} catch {
						// The close handler will pick up a dead socket.
					}
				}
			}, pingAfterMs);
		}
	}

	private scheduleReconnect(reason: string, floorMs?: number): void {
		if (this.closedByUs) return;
		this.attempts += 1;
		this.setState(this.attempts > 1 ? 'reconnecting' : 'connecting', { error: reason });
		const maxBackoffMs = this.options.maxBackoffMs ?? 60_000;
		const base = Math.min(1000 * 2 ** Math.min(this.attempts - 1, 6), maxBackoffMs);
		const jitter = base * (0.5 + Math.random() * 0.5);
		const delay = floorMs ? Math.max(floorMs, jitter) : jitter;
		this.connectTimer = setTimeout(() => this.connect(), delay);
	}
}
