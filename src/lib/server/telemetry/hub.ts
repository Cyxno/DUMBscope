/**
 * The hub: one shared server-side connection to DUMB feeding every browser.
 *
 * The hub owns the DUMB client, the three realtime streams, the normalized
 * live state (services, metrics history, logs, connection health), the incident
 * engine and SSE fan-out. Browser tabs never talk to DUMB directly and never
 * see its credentials.
 */
import type {
	ConnectionSnapshot,
	ConnectionState,
	DiscoveredService,
	LogLine,
	MetricsHistoryPoint,
	MetricsSnapshot,
	ServiceStatus,
	StackOverview,
	TopologyGraph
} from '$lib/types';
import { DumbClient, DumbAuthError, DumbError } from '../dumb/client';
import { parseCapabilities } from '../dumb/capabilities';
import { normalizeDiscovered, normalizeMetrics, normalizeServiceStatus } from '../dumb/normalize';
import { DumbStream } from '../dumb/streams';
import type { DumbMetricsSnapshot, DumbProcessesResponse, DumbServiceStatus } from '../dumb/types';
import { getSettings, getDumbCredentials } from '../config/settings';
import { appInfo } from '$lib/shared/app-info';
import { configDir } from '../database/db';
import { splitLines, parseLogLine } from '../logs/parse';
import { IncidentEngine } from '../incidents/engine';
import { buildTopology } from '../topology/graph';
import { onActivity, recordActivity, recentActivity, type ActivityEntry } from './activity';

const METRICS_RING_SIZE = 1800; // ~1h at the default 2s interval
const LOG_RING_SIZE = 5000;
const STATUS_INTERVAL_FRESH_MS = 15_000;
/** Minimum spacing between proactive token refreshes. */
const TOKEN_REFRESH_THROTTLE_MS = 4 * 60_000;
/** Minimum spacing between stale-recovery stream restarts. */
const STREAMS_BOUNCE_THROTTLE_MS = 60_000;

export interface HubEvent {
	event: string;
	data: unknown;
}

interface Subscriber {
	id: number;
	send: (event: HubEvent) => void;
	close: () => void;
}

export class Hub {
	// ----- live state --------------------------------------------------------
	private services = new Map<string, ServiceStatus>();
	private discovered: DiscoveredService[] = [];
	private discoveredByProcess = new Map<string, DiscoveredService>();
	private capabilities = parseCapabilities(null);
	private metricsLatest: MetricsSnapshot | null = null;
	private metricsHistory: MetricsHistoryPoint[] = [];
	private logBuffer: LogLine[] = [];
	private connection: ConnectionSnapshot = {
		state: 'unconfigured',
		streams: {
			rest: 'unconfigured',
			status: 'unconfigured',
			metrics: 'unconfigured',
			logs: 'unconfigured'
		},
		lastUpdateAt: null,
		lastError: null,
		reconnectAttempts: 0,
		dumbVersion: null,
		authMode: 'unknown'
	};

	// ----- infrastructure ----------------------------------------------------
	private client: DumbClient | null = null;
	private streams: DumbStream[] = [];
	private engine = new IncidentEngine({
		onIncidentChange: (incident) => this.broadcast('incident', incident)
	});
	private subscribers = new Map<number, Subscriber>();
	private nextSubscriberId = 1;
	private housekeeper: ReturnType<typeof setInterval> | null = null;
	private lastTokenRefreshAt = 0;
	private lastStreamsBounceAt = 0;
	private lastStatusEmit = 0;
	private configured = false;
	private stopped = false;

	// -- cached REST payloads for initial render ------------------------------
	private cachedProcessesResponse: DumbProcessesResponse | null = null;

	/**
	 * (Re)configure and start. Safe to call again after settings changes;
	 * tears down existing streams first.
	 */
	start(): void {
		this.stopped = false;
		const settings = getSettings();
		this.configured = Boolean(settings.dumbUrl);
		this.stopStreams();

		if (!settings.dumbUrl) {
			this.setConnection({ state: 'unconfigured' });
			return;
		}

		this.client = new DumbClient({
			baseUrl: settings.dumbUrl,
			getCredentials: () => getDumbCredentials()
		});

		this.setConnection({ state: 'connecting', lastError: null, reconnectAttempts: 0 });
		void this.bootstrapRest();

		const statusStream = new DumbStream({
			name: 'status',
			url: () =>
				this.client!.wsUrl('/ws/status', {
					health: 'true',
					interval: String(settings.statusInterval)
				}),
			onMessage: (data) => this.handleStatusMessage(data),
			onStateChange: (state, detail) => this.handleStreamState('status', state, detail?.error),
			staleAfterMs: Math.max(30_000, settings.statusInterval * 10_000)
		});
		const metricsStream = new DumbStream({
			name: 'metrics',
			url: () =>
				this.client!.wsUrl('/ws/metrics', {
					interval: String(settings.metricsInterval),
					bootstrap: 'true'
				}),
			onMessage: (data) => this.handleMetricsMessage(data),
			onStateChange: (state, detail) => this.handleStreamState('metrics', state, detail?.error),
			staleAfterMs: Math.max(30_000, settings.metricsInterval * 10_000)
		});
		const logsStream = new DumbStream({
			name: 'logs',
			url: () => this.client!.wsUrl('/ws/logs'),
			onMessage: (data) => this.handleLogMessage(data),
			onStateChange: (state, detail) => this.handleStreamState('logs', state, detail?.error),
			staleAfterMs: 120_000,
			pingAfterMs: 30_000
		});
		this.streams = [statusStream, metricsStream, logsStream];
		for (const stream of this.streams) stream.start();

		this.housekeeper ??= setInterval(() => this.housekeep(), 10_000);
	}

	private stopStreams(): void {
		for (const stream of this.streams) stream.stop();
		this.streams = [];
	}

	stop(): void {
		this.stopped = true;
		this.activityUnsubscribe?.();
		this.activityUnsubscribe = null;
		this.stopStreams();
		if (this.housekeeper) {
			clearInterval(this.housekeeper);
			this.housekeeper = null;
		}
	}

	reload(): void {
		this.start();
	}

	// -------------------------------------------------------------------------
	// REST bootstrap (discovery + capabilities)
	// -------------------------------------------------------------------------

	private async bootstrapRest(): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			const authStatus = await client.authStatus().catch(() => null);
			if (authStatus) {
				const mode = authStatus.enabled ? (authStatus.mode ?? 'local') : 'none';
				this.setConnection({
					authMode: (mode as ConnectionSnapshot['authMode']) ?? 'unknown'
				});
				if (authStatus.enabled && !getDumbCredentials()) {
					this.setConnection({
						state: 'credentials-invalid',
						streams: emptyStreams('unconfigured'),
						lastError: 'DUMB requires authentication but no credentials are stored'
					});
					return;
				}
			}

			await client.ensureAuthenticated();
			const [processes, capabilities] = await Promise.all([
				client.processes(),
				client.capabilities().catch(() => ({}))
			]);
			this.cachedProcessesResponse = processes;
			this.capabilities = parseCapabilities(capabilities);
			this.applyDiscovered(processes);
			this.setConnection({ streams: { ...this.connection.streams, rest: 'live' } });
		} catch (err) {
			if (err instanceof DumbAuthError) {
				this.setConnection({
					state: 'credentials-invalid',
					lastError: err.message,
					streams: emptyStreams('offline')
				});
			} else {
				const message = err instanceof DumbError ? err.message : 'Could not reach DUMB';
				this.setConnection({
					state: 'offline',
					lastError: message,
					streams: emptyStreams('offline')
				});
			}
			// Keep retrying REST in the background via the housekeeper.
		}
	}

	private applyDiscovered(response: DumbProcessesResponse): void {
		const discovered: DiscoveredService[] = [];
		const byProcess = new Map<string, DiscoveredService>();
		for (const entry of response.processes ?? []) {
			const service = normalizeDiscovered(entry);
			if (!service) continue;
			discovered.push(service);
			byProcess.set(service.processName, service);
		}
		this.discovered = discovered;
		this.discoveredByProcess = byProcess;
		// Merge enabled/versions into current statuses.
		for (const service of discovered) {
			const existing = this.services.get(service.key);
			if (existing) {
				existing.enabled = service.enabled;
				existing.name = service.name;
			}
		}
		this.emitServices();
	}

	// -------------------------------------------------------------------------
	// Stream message handlers
	// -------------------------------------------------------------------------

	private handleStatusMessage(data: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return; // Malformed payload: ignore, next tick will arrive.
		}
		const msg = parsed as { type?: string; processes?: DumbServiceStatus[]; running?: string[] };
		if (msg.type !== 'status') return;

		const now = Date.now();
		const previous = new Map(this.services);
		const incoming = msg.processes ?? [];

		if (incoming.length > 0) {
			const seen = new Set<string>();
			for (const raw of incoming) {
				const status = normalizeServiceStatus(raw, this.discoveredByProcess);
				if (!status) continue;
				seen.add(status.key);
				const prev = previous.get(status.key);
				if (prev && prev.health !== status.health && prev.health !== 'unknown') {
					recordActivity(
						'health-transition',
						`${status.name} became ${status.health}${status.healthReason ? ` — ${status.healthReason}` : ''}`,
						status.key
					);
					if (status.runState === 'running' && prev.runState !== 'running') {
						recordActivity('service-started', `${status.name} started`, status.key);
					}
					if (prev.runState === 'running' && status.runState === 'stopped') {
						recordActivity('service-stopped', `${status.name} stopped`, status.key);
					}
				}
				if (prev) {
					status.cpuPercent = prev.cpuPercent;
					status.memoryBytes = prev.memoryBytes;
					status.pid = prev.pid;
				}
				this.services.set(status.key, status);
			}
			// Services that disappeared from the running snapshot: mark stopped.
			for (const [key, status] of this.services) {
				if (!seen.has(key) && status.runState === 'running') {
					status.runState = 'stopped';
					status.observedAt = now;
				}
			}
		} else if (Array.isArray(msg.running)) {
			// Legacy format without health details: at least track names.
			for (const name of msg.running) {
				const info = this.discoveredByProcess.get(name);
				const key = info?.key ?? name.toLowerCase();
				const existing = this.services.get(key);
				if (existing) {
					existing.runState = 'running';
					existing.observedAt = now;
				} else {
					this.services.set(key, {
						key,
						name,
						processName: name,
						enabled: info?.enabled ?? true,
						runState: 'running',
						health: 'unknown',
						healthReason: null,
						healthDetails: null,
						restart: null,
						cpuPercent: null,
						memoryBytes: null,
						pid: null,
						observedAt: now
					});
				}
			}
		}

		this.setConnection({ lastUpdateAt: now });
		this.engine.onStatus(previous, new Map(this.services));
		this.emitServices(now);
	}

	private handleMetricsMessage(data: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch {
			return;
		}
		const msg = parsed as {
			type?: string;
			data?: DumbMetricsSnapshot;
			snapshot?: DumbMetricsSnapshot;
		};
		const rawSnapshot = msg.data ?? (msg.type === 'snapshot' ? msg.data : msg.snapshot) ?? null;
		if (msg.type !== 'snapshot' && msg.type !== 'bootstrap') return;
		const snapshotRaw = msg.type === 'bootstrap' ? msg.snapshot : rawSnapshot;
		if (!snapshotRaw) return;

		const snapshot = normalizeMetrics(snapshotRaw);
		this.metricsLatest = snapshot;
		this.pushHistoryPoint(snapshot);

		// Attach per-process metrics to services by name.
		for (const proc of snapshot.processes) {
			const info = this.discoveredByProcess.get(proc.name);
			const key = info?.key ?? proc.name.toLowerCase();
			const status = this.services.get(key);
			if (status) {
				status.cpuPercent = proc.cpuPercent;
				status.memoryBytes = proc.memoryBytes;
				status.pid = proc.pid;
			}
		}

		this.engine.onMetrics(snapshot);
		this.broadcast('metrics', snapshot);
		this.emitServices();
	}

	private handleLogMessage(data: string): void {
		const processNames = new Set(this.discovered.map((d) => d.processName));
		for (const line of splitLines(data)) {
			const logLine = parseLogLine(line, { processNames });
			this.logBuffer.push(logLine);
			this.engine.onLogLine(logLine);
			this.broadcast('log', logLine);
		}
		if (this.logBuffer.length > LOG_RING_SIZE) {
			this.logBuffer = this.logBuffer.slice(-LOG_RING_SIZE);
		}
	}

	private handleStreamState(
		stream: 'status' | 'metrics' | 'logs',
		state: ConnectionState,
		error?: string
	): void {
		const streams = { ...this.connection.streams, [stream]: state };
		let overall: ConnectionState = this.connection.state;
		if (state === 'live') {
			overall = 'live';
		} else if (state === 'reconnecting' && this.connection.state === 'live') {
			// One stream flapping does not take the whole dashboard down.
			overall = 'live';
		} else if (this.connection.state === 'live' && state === 'stale') {
			overall = 'stale';
		}

		if (state === 'reconnecting' || state === 'connecting') {
			overall = overall === 'live' ? 'live' : 'reconnecting';
		}
		if (
			streams.status === 'offline' &&
			streams.metrics === 'offline' &&
			streams.logs === 'offline' &&
			streams.rest !== 'live'
		) {
			overall = 'offline';
		}

		this.setConnection({
			streams,
			state: overall === 'unconfigured' ? 'offline' : overall,
			lastError: error ?? this.connection.lastError,
			reconnectAttempts: Math.max(
				this.streams[0]?.reconnectAttempts ?? 0,
				this.streams[1]?.reconnectAttempts ?? 0,
				this.streams[2]?.reconnectAttempts ?? 0
			)
		});
		if (state === 'offline') {
			void this.bootstrapRest();
		}
	}

	// -------------------------------------------------------------------------
	// Housekeeping
	// -------------------------------------------------------------------------

	private housekeep(): void {
		if (this.stopped) return;
		const now = Date.now();
		const statusLive = this.connection.streams.status === 'live';
		this.engine.onTick(this.metricsLatest?.receivedAt ?? null, statusLive);
		this.engine.correlate(this.topology());
		this.engine.onConnection(this.connection);

		// REST recovery when the bootstrap failed at startup.
		if (this.connection.streams.rest !== 'live' && this.configured) {
			void this.bootstrapRest();
		}
		// Keep the access token fresh. WS reconnects embed the cached token;
		// DUMB rejects upgrades carrying an expired one, so after a DUMB
		// restart the streams would otherwise 401 forever. ensureAuthenticated
		// no-ops while the token is young; the throttle keeps us from
		// hammering the gateway.
		if (
			this.client &&
			this.configured &&
			now - this.lastTokenRefreshAt > TOKEN_REFRESH_THROTTLE_MS
		) {
			this.lastTokenRefreshAt = now;
			void this.client.ensureAuthenticated().catch(() => {
				// Gateway unreachable: the streams' reconnect/backoff handles it.
			});
		}
		// Freshness: connected but nothing new for a long time → stale.
		if (
			this.connection.state === 'live' &&
			this.connection.lastUpdateAt !== null &&
			now - this.connection.lastUpdateAt > STATUS_INTERVAL_FRESH_MS * 6
		) {
			this.setConnection({ state: 'stale' });
		}
		// A stale stream whose socket quietly died (gateway restart, dropped
		// NAT table) never fires onclose, so the backoff loop never kicks in.
		// Bounce the streams periodically while telemetry stays frozen; each
		// bounce reconnects with freshly authenticated credentials.
		if (
			this.connection.state === 'stale' &&
			this.configured &&
			now - this.lastStreamsBounceAt > STREAMS_BOUNCE_THROTTLE_MS
		) {
			this.lastStreamsBounceAt = now;
			console.log('[dumbscope] telemetry stale — restarting DUMB streams');
			this.reload();
		}
	}

	// -------------------------------------------------------------------------
	// Public snapshot getters
	// -------------------------------------------------------------------------

	get isConfigured(): boolean {
		return this.configured;
	}

	/** Load persisted active incidents so restarts can't orphan them. */
	hydrateIncidents(): void {
		this.engine.hydrate();
	}

	getConnection(): ConnectionSnapshot {
		return this.connection;
	}

	getServices(): ServiceStatus[] {
		return [...this.services.values()];
	}

	getDiscovered(): DiscoveredService[] {
		return this.discovered;
	}

	getCapabilities(): ReturnType<typeof parseCapabilities> {
		return this.capabilities;
	}

	getMetrics(): MetricsSnapshot | null {
		return this.metricsLatest;
	}

	getMetricsHistory(maxPoints = 600): MetricsHistoryPoint[] {
		if (this.metricsHistory.length <= maxPoints) return this.metricsHistory;
		// Downsample evenly to maxPoints.
		const step = this.metricsHistory.length / maxPoints;
		const out: MetricsHistoryPoint[] = [];
		for (let i = 0; i < maxPoints; i++) {
			out.push(this.metricsHistory[Math.floor(i * step)]!);
		}
		return out;
	}

	getLogs(afterId?: number, limit = 500): LogLine[] {
		const source =
			afterId !== undefined ? this.logBuffer.filter((l) => l.id > afterId) : this.logBuffer;
		return source.slice(-limit);
	}

	/** The configured DUMB client, or null when DUMBscope is unconfigured. */
	getClient(): DumbClient | null {
		return this.client;
	}

	topology(): TopologyGraph {
		return buildTopology(this.getDiscovered(), this.services);
	}

	overview(): StackOverview {
		const statuses = this.getServices();
		const active = this.engine.getActive();
		const online = statuses.filter((s) => s.runState === 'running').length;
		const degraded = statuses.filter(
			(s) => s.health === 'degraded' || s.health === 'starting'
		).length;
		const unhealthy = statuses.filter((s) => s.health === 'unhealthy').length;
		const stopped = statuses.filter((s) => s.runState === 'stopped').length;
		const critical = active.filter((i) => i.severity === 'critical').length;
		let health: StackOverview['health'] = 'healthy';
		if (!this.configured) health = 'unknown';
		else if (this.connection.state === 'offline' || critical > 0) health = 'incident';
		else if (unhealthy > 0 || degraded > 0 || active.length > 0) health = 'degraded';
		return {
			health,
			servicesOnline: online,
			servicesDegraded: degraded,
			servicesUnhealthy: unhealthy,
			servicesStopped: stopped,
			servicesTotal: statuses.length,
			activeIncidents: active.length,
			criticalIncidents: critical
		};
	}

	getActiveIncidents() {
		return this.engine.getActive();
	}

	activityFeed(limit = 60): ActivityEntry[] {
		return recentActivity(limit);
	}

	/** Wire activity events into the SSE stream (called once at startup). */
	private activityUnsubscribe: (() => void) | null = null;

	/** Wire activity events into the SSE stream (idempotent). */
	wireActivity(): void {
		if (this.activityUnsubscribe) return;
		this.activityUnsubscribe = onActivity((entry) => this.broadcast('activity', entry));
	}

	// -------------------------------------------------------------------------
	// SSE fan-out
	// -------------------------------------------------------------------------

	addSubscriber(send: (event: HubEvent) => void, close: () => void): () => void {
		const id = this.nextSubscriberId++;
		this.subscribers.set(id, { id, send, close });
		return () => this.subscribers.delete(id);
	}

	subscriberCount(): number {
		return this.subscribers.size;
	}

	private broadcast(event: string, data: unknown): void {
		if (this.subscribers.size === 0) return;
		for (const subscriber of this.subscribers.values()) {
			try {
				subscriber.send({ event, data });
			} catch {
				subscriber.close();
				this.subscribers.delete(subscriber.id);
			}
		}
	}

	private emitServices(now = Date.now()): void {
		// Throttle full service snapshots to at most one per second.
		if (now - this.lastStatusEmit < 1000) return;
		this.lastStatusEmit = now;
		const discovered = this.getDiscovered();
		const services = this.getServices();
		this.broadcast('services', {
			services,
			discovered,
			overview: this.overview()
		});
		// The graph changes whenever discovery or health changes; keep it in sync.
		this.broadcast('topology', buildTopology(discovered, new Map(services.map((s) => [s.key, s]))));
	}

	// -------------------------------------------------------------------------
	// Internal helpers
	// -------------------------------------------------------------------------

	private setConnection(patch: Partial<ConnectionSnapshot>): void {
		const next = { ...this.connection, ...patch };
		// Only broadcast meaningful changes; lastUpdateAt ticks would spam SSE.
		const meaningful =
			next.state !== this.connection.state ||
			next.authMode !== this.connection.authMode ||
			next.lastError !== this.connection.lastError ||
			next.reconnectAttempts !== this.connection.reconnectAttempts ||
			JSON.stringify(next.streams) !== JSON.stringify(this.connection.streams);
		this.connection = next;
		if (meaningful) this.broadcast('connection', this.connection);
	}

	private pushHistoryPoint(snapshot: MetricsSnapshot): void {
		this.metricsHistory.push({
			t: snapshot.timestamp,
			cpu: snapshot.cpuPercent,
			mem: snapshot.memory?.percent ?? null,
			disk: snapshot.filesystems[0]?.percent ?? null
		});
		if (this.metricsHistory.length > METRICS_RING_SIZE) {
			this.metricsHistory = this.metricsHistory.slice(-METRICS_RING_SIZE);
		}
	}
}

function emptyStreams(
	state: ConnectionState
): Record<'rest' | 'status' | 'metrics' | 'logs', ConnectionState> {
	return { rest: state, status: state, metrics: state, logs: state };
}

// -----------------------------------------------------------------------------
// Singleton access
// -----------------------------------------------------------------------------

let hubInstance: Hub | null = null;

/** Lazily create the process-wide hub (first request triggers startup). */
export function getHub(): Hub {
	if (!hubInstance) {
		const info = appInfo();
		console.log(
			`[dumbscope] DUMBscope ${info.version}${info.buildSha ? ` (build ${info.buildSha.slice(0, 10)})` : ''} — Node ${info.nodeVersion}, config dir ${configDir()}`
		);
		hubInstance = new Hub();
		hubInstance.hydrateIncidents();
		hubInstance.wireActivity();
		hubInstance.start();
	}
	return hubInstance;
}

/** Test helper: drop the singleton. */
export function resetHub(): void {
	hubInstance?.stop();
	hubInstance = null;
}
