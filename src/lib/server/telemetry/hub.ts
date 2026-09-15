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
	MountTarget,
	ReliabilitySnapshot,
	ServiceStatus,
	StackOverview,
	TopologyGraph
} from '$lib/types';
import { DumbClient, DumbAuthError } from '../dumb/client';
import { parseCapabilities } from '../dumb/capabilities';
import { normalizeDiscovered, normalizeMetrics, normalizeServiceStatus } from '../dumb/normalize';
import { DumbStream } from '../dumb/streams';
import { ConnectivityTracker, classifyProbeError } from '../dumb/connection';
import type { DumbMetricsSnapshot, DumbProcessesResponse, DumbServiceStatus } from '../dumb/types';
import { getSettings, getDumbCredentials, getMountTargetsJson } from '../config/settings';
import { appInfo } from '$lib/shared/app-info';
import { configDir } from '../database/db';
import { splitLines, parseLogLine } from '../logs/parse';
import { IncidentEngine } from '../incidents/engine';
import { handleIncidentChange, setPublicBaseUrl } from '../notifications/engine';
import { buildTopology } from '../topology/graph';
import { onActivity, recordActivity, recentActivity, type ActivityEntry } from './activity';
import { onIntegrationStateChange } from '../integrations/manager';
import { sweepRateLimits } from '../security/rate-limit';
import { MountMonitor } from '../reliability/mounts';
import { MemoryAnomalyTracker, type MemoryTuningOverrides } from '../reliability/memory';
import { fsProbeCallCount } from '../reliability/fsprobe';
import { getRemediationManager, type RemediationManager } from '../reliability/remediation';
import { MediaFlowCorrelator, loadArrObservations } from '../media/flow';

const GIB = 1024 ** 3;

/**
 * Reliability fast-clock (tests/e2e only): shortens persistence/recovery
 * windows so a CI browser run can watch a finding open and resolve. Never set
 * in production deployments; defaults stay at the documented values.
 */
function reliabilityTuningOverrides(): {
	memory: MemoryTuningOverrides;
	mountIntervalMs: number | null;
} | null {
	if (process.env.DUMBSCOPE_RELIABILITY_FAST !== '1') return null;
	return {
		memory: {
			sampleIntervalMs: 2_000,
			evaluateIntervalMs: 2_000,
			persistenceMs: 5_000,
			baselineMinSamples: 6,
			baselineLagMs: 6_000,
			resolveSustainMs: 5_000,
			retentionMs: 24 * 60 * 60_000,
			pruneIntervalMs: 10 * 60_000
		},
		mountIntervalMs: 3_000
	};
}

/**
 * Monitored mount targets (FASE B). Empty by default: probing paths that the
 * container cannot see would only produce false `missing` verdicts, so a
 * deployment opts in explicitly via the DUMBSCOPE_MOUNTS env (JSON list of
 * MountTarget) or the `reliability.mounts` setting, which wins over the env.
 */
function loadMountTargets(): MountTarget[] {
	const raw = getMountTargetsJson() ?? process.env.DUMBSCOPE_MOUNTS ?? null;
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const targets: MountTarget[] = [];
		for (const entry of parsed) {
			const t = entry as Partial<MountTarget>;
			if (typeof t.path !== 'string' || !t.path.startsWith('/')) continue;
			targets.push({
				id: typeof t.id === 'string' && t.id ? t.id : t.path,
				label: typeof t.label === 'string' && t.label ? t.label : t.path,
				path: t.path,
				kind: t.kind === 'fuse' || t.kind === 'symlink-root' ? t.kind : 'local',
				consumers: Array.isArray(t.consumers)
					? t.consumers.filter((c): c is string => typeof c === 'string')
					: []
			});
		}
		return targets;
	} catch {
		console.log('[dumbscope] invalid DUMBSCOPE_MOUNTS JSON — mount monitoring disabled');
		return [];
	}
}

const METRICS_RING_SIZE = 1800; // ~1h at the default 2s interval
const LOG_RING_SIZE = 5000;
/** How often the service registry is refreshed from DUMB's REST API. */
const DISCOVERY_REFRESH_MS = 10 * 60_000;
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
	/**
	 * Single source of truth for connection health (FASE A): the tracker
	 * derives the connection state from layer facts; the hub never writes it
	 * ad hoc. Before the tracker, a failed REST bootstrap could clobber live
	 * stream flags and stick the hub on "offline" for hours while DUMB was
	 * healthy (production incident 2026-09-13). Assigned in the constructor
	 * so the injectable test clock reaches it.
	 */
	private tracker: ConnectivityTracker;
	private lastConnectionSignature: string | null = null;

	// -- reliability core (FASE B/C): read-only monitors -----------------------
	private mountMonitor: MountMonitor;
	private memoryTracker: MemoryAnomalyTracker;
	private lastReliabilitySignature: string | null = null;

	// -- media correlation + remediation (DEEL 2): observe-first ---------------
	private mediaFlow: MediaFlowCorrelator;
	private remediation: RemediationManager;
	private lastMediaSignature: string | null = null;

	// ----- infrastructure ----------------------------------------------------
	private client: DumbClient | null = null;
	private streams: DumbStream[] = [];
	private engine: IncidentEngine;
	private subscribers = new Map<number, Subscriber>();
	private nextSubscriberId = 1;
	private housekeeper: ReturnType<typeof setInterval> | null = null;
	/** True once the REST bootstrap applied the service registry. Status
	 *  frames are only evaluated after this: pre-discovery frames would
	 *  create services under slug keys that discovery never matches again. */
	private discoveryReady = false;
	private lastTokenRefreshAt = 0;
	private lastDiscoveryRefreshAt = 0;
	private lastStreamsBounceAt = 0;
	private lastStatusEmit = 0;
	private configured = false;
	private stopped = false;

	// -- cached REST payloads for initial render ------------------------------
	private cachedProcessesResponse: DumbProcessesResponse | null = null;

	/**
	 * @param options.testClock injectable clock for the connectivity state
	 *   machine (startup/recovery grace windows, incident lifecycles in tests).
	 */
	constructor(private readonly options: { testClock?: () => number } = {}) {
		this.tracker = new ConnectivityTracker({ now: options.testClock });
		this.engine = new IncidentEngine(
			{
				onIncidentChange: (incident, action) => {
					this.broadcast('incident', incident);
					// Alerts & Notifications consume the same lifecycle —
					// fire-and-forget; delivery failures never affect monitoring.
					handleIncidentChange(incident, action);
				}
			},
			options.testClock
		);
		const clock = options.testClock ?? (() => Date.now());
		const fast = reliabilityTuningOverrides();
		this.mountMonitor = new MountMonitor({
			now: clock,
			targets: loadMountTargets(),
			enabled: () => getSettings().mountMonitoring,
			...(fast?.mountIntervalMs !== null && fast
				? { roundIntervalMs: fast.mountIntervalMs }
				: process.env.DUMBSCOPE_MOUNT_INTERVAL_MS
					? { roundIntervalMs: Number(process.env.DUMBSCOPE_MOUNT_INTERVAL_MS) }
					: {})
		});
		this.memoryTracker = new MemoryAnomalyTracker({
			now: clock,
			enabled: () => getSettings().memoryMonitoring,
			warningBytes: () => getSettings().memoryWarningGb * GIB,
			criticalBytes: () => getSettings().memoryCriticalGb * GIB,
			onAssessment: (assessment) => this.engine.onMemory(assessment),
			tuning: fast?.memory
		});
		this.mediaFlow = new MediaFlowCorrelator({
			now: clock,
			loader: loadArrObservations,
			tuning: fast ? { cycleMs: 4_000 } : undefined,
			onFinding: (finding) =>
				this.engine.reportFinding({
					fingerprint: finding.fingerprint,
					severity: finding.severity,
					title: finding.title,
					summary: finding.summary,
					evidence: finding.evidence
				}),
			onResolve: (fingerprint, message) => this.engine.resolveFinding(fingerprint, message)
		});
		this.remediation = getRemediationManager();
	}

	/**
	 * (Re)configure and start. Safe to call again after settings changes;
	 * tears down existing streams first.
	 */
	start(): void {
		this.stopped = false;
		const settings = getSettings();
		this.configured = Boolean(settings.dumbUrl);
		this.stopStreams();
		this.tracker.setConfigured(this.configured);
		this.tracker.hubRestart();

		if (!settings.dumbUrl) {
			this.publishConnection();
			return;
		}

		this.client = new DumbClient({
			baseUrl: settings.dumbUrl,
			getCredentials: () => getDumbCredentials()
		});
		this.bindRemediation();

		void this.bootstrapRest();

		this.startStreams(settings);
		this.housekeeper ??= setInterval(() => this.housekeep(), 10_000);
		this.publishConnection();
	}

	private startStreams(settings: { statusInterval: number; metricsInterval: number }): void {
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
	// REST bootstrap (layered probes: auth → REST discovery, HTTP-classified)
	// -------------------------------------------------------------------------

	private async bootstrapRest(): Promise<void> {
		const client = this.client;
		if (!client) return;
		try {
			const authStatus = await client.authStatus().catch(() => null);
			if (authStatus) {
				const mode = authStatus.enabled ? (authStatus.mode ?? 'local') : 'none';
				this.tracker.setAuthMode((mode as ConnectionSnapshot['authMode']) ?? 'unknown');
				this.tracker.probe('auth', { ok: true });
				if (authStatus.enabled && !getDumbCredentials()) {
					this.tracker.noteCredentialsInvalid(
						'DUMB requires authentication but no credentials are stored'
					);
					this.publishConnection();
					return;
				}
			}

			await client.ensureAuthenticated();
			// An authenticated round trip proves the HTTP layer is up too — the
			// HTTP probe would otherwise stay 'unknown' on healthy stacks (it is
			// otherwise only recorded when a failure needs classifying).
			this.tracker.probe('http', { ok: true });
			const [processes, capabilities] = await Promise.all([
				client.processes(),
				client.capabilities().catch(() => ({}))
			]);
			this.cachedProcessesResponse = processes;
			this.capabilities = parseCapabilities(capabilities);
			this.applyDiscovered(processes);
			this.discoveryReady = true;
			this.tracker.probe('rest', { ok: true });
			this.tracker.setLastError(null);
			this.maybeBounceStreams();
		} catch (err) {
			if (err instanceof DumbAuthError) {
				this.tracker.probe('auth', { ok: false, code: 'auth-rejected', detail: err.message });
				this.tracker.noteCredentialsInvalid(err.message);
			} else {
				// Classify where the chain broke: if plain HTTP still answers, the
				// failure sits in the auth/REST layer; otherwise the gateway is
				// not reachable at all (refused / DNS / timeout — brief §6).
				const failure = classifyProbeError(err);
				const health = await client.health().then(
					() => ({ up: true, failure: null }),
					(healthErr: unknown) => ({ up: false, failure: classifyProbeError(healthErr) })
				);
				if (health.up) {
					this.tracker.probe('http', { ok: true });
					this.tracker.probe('rest', { ok: false, ...failure });
				} else {
					this.tracker.probe('http', { ok: false, ...health.failure });
					this.tracker.probe('auth', { ok: false, ...health.failure });
					this.tracker.probe('rest', { ok: false, ...health.failure });
				}
				this.tracker.setLastError(failure.detail);
			}
			// Keep retrying REST in the background via the housekeeper.
		}
		this.publishConnection();
	}

	/**
	 * Recovery acceleration (brief §8): when REST proves the gateway is back
	 * while the streams are stuck waiting out their reconnect backoff, restart
	 * them immediately so they reconnect with fresh credentials instead of
	 * grinding through up to a minute of exponential backoff. Streams that are
	 * mid-first-connect are left alone.
	 */
	private maybeBounceStreams(): void {
		const waitingInBackoff = this.streams.some((s) => s.connectionState === 'reconnecting');
		if (!waitingInBackoff) return;
		const now = Date.now();
		if (now - this.lastStreamsBounceAt < 15_000) return;
		this.lastStreamsBounceAt = now;
		const settings = getSettings();
		this.stopStreams();
		this.startStreams(settings);
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
		// Reconcile: stopped incidents for processes outside the managed
		// registry are ephemeral helpers, not failures.
		this.engine.reconcileRegistryStops(new Set(byProcess.keys()));
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

		// Startup gate (brief §22): until the REST bootstrap has applied the
		// service registry, status frames are untrusted — services created
		// from them use slug keys that discovery never matches again, and a
		// partial first frame would mark established services stopped. The
		// housekeeper's REST recovery guarantees bootstrap runs as soon as
		// the gateway is reachable.
		if (!this.discoveryReady) return;

		if (incoming.length > 0) {
			const seen = new Set<string>();
			for (const raw of incoming) {
				const status = normalizeServiceStatus(raw, this.discoveredByProcess);
				if (!status) continue;
				// Only DUMB's managed registry is monitored: the status frames
				// also carry ephemeral internal helper processes (e.g. one-shot
				// setup steps) that report "stopped" after completing — treating
				// those as services produced permanent false incidents.
				if (
					this.discoveredByProcess.size > 0 &&
					!this.discoveredByProcess.has(status.processName)
				) {
					continue;
				}
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

		this.tracker.dataReceived(now);
		this.engine.onStatus(previous, new Map(this.services));
		this.emitServices(now);
		this.publishConnection();
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
		// FASE C: per-process RSS samples for anomaly detection. Failure-
		// isolated inside the tracker — never disturbs the metrics pipeline.
		this.memoryTracker.onSnapshot(snapshot);
		this.tracker.dataReceived(snapshot.receivedAt);
		this.publishConnection();
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
		this.tracker.streamState(stream, state);
		this.tracker.setReconnectAttempts(
			Math.max(
				this.streams[0]?.reconnectAttempts ?? 0,
				this.streams[1]?.reconnectAttempts ?? 0,
				this.streams[2]?.reconnectAttempts ?? 0
			)
		);
		if (error && this.streams.every((s) => s.connectionState !== 'live')) {
			this.tracker.setLastError(error);
		}
		if (state === 'offline') {
			void this.bootstrapRest();
		}
		this.publishConnection();
	}

	// -------------------------------------------------------------------------
	// Housekeeping
	// -------------------------------------------------------------------------

	/** Periodic maintenance: telemetry freshness, incident evaluation, token
	 *  refresh, discovery refresh and stale-stream recovery. Public so tests
	 *  can drive ticks deterministically. */
	housekeep(): void {
		if (this.stopped) return;
		const now = Date.now();
		// Keep the notification engine's outbound deep links in sync with settings.
		setPublicBaseUrl(getSettings().notificationPublicBaseUrl);
		const connection = this.tracker.snapshot();
		const statusLive = connection.streams.status === 'live';
		this.engine.onTick(this.metricsLatest?.receivedAt ?? null, statusLive);
		this.engine.correlate(this.topology());
		this.engine.onConnection(connection);
		this.runReliabilityChecks();

		// REST recovery: probe while the bootstrap never succeeded this session,
		// while the connection is not delivering (mid-run outage), and once more
		// after a recovery that rode in on the streams' own backoff (their
		// success proves the gateway is back but leaves the REST probe verdicts
		// stale until one successful round trip reconciles them).
		const connectionDelivering =
			connection.state === 'live' ||
			connection.state === 'degraded' ||
			connection.state === 'starting';
		if (
			this.configured &&
			(connection.probes.rest.okAt === null ||
				connection.probes.rest.status === 'failed' ||
				!connectionDelivering)
		) {
			void this.bootstrapRest();
		}
		// Keep the rate limiter's per-key map bounded.
		sweepRateLimits(15 * 60_000);
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
		// Periodic discovery refresh: newly added DUMB services enter the
		// registry here (status frames only carry processes discovery knows).
		if (this.configured && now - this.lastDiscoveryRefreshAt > DISCOVERY_REFRESH_MS) {
			this.lastDiscoveryRefreshAt = now;
			void this.bootstrapRest();
		}
		// A stale stream whose socket quietly died (gateway restart, dropped
		// NAT table) never fires onclose, so the backoff loop never kicks in.
		// Bounce the streams periodically while telemetry stays frozen; each
		// bounce reconnects with freshly authenticated credentials.
		if (
			connection.state === 'stale' &&
			this.configured &&
			now - this.lastStreamsBounceAt > STREAMS_BOUNCE_THROTTLE_MS
		) {
			this.lastStreamsBounceAt = now;
			console.log('[dumbscope] telemetry stale — restarting DUMB streams');
			this.reload();
		}
		this.publishConnection();
	}

	/**
	 * FASE B/C reliability passes, driven by the same 10s housekeeping tick.
	 * Both monitors are strictly read-only and failure-isolated (brief §45):
	 * a hung mount probe or a bad memory series can never affect the DUMB
	 * connection, the service registry or this poller. The mount tick is
	 * awaited only by its own promise chain — the housekeeper returns
	 * immediately; results land in the engine when the probes finish.
	 */
	private runReliabilityChecks(): void {
		const runningProcesses = new Set(
			[...this.services.values()].filter((s) => s.runState === 'running').map((s) => s.processName)
		);
		void this.mountMonitor
			.tick({ runningProcesses })
			.then(() => {
				if (!this.mountMonitor.dirty) return;
				this.mountMonitor.dirty = false;
				this.engine.onMountHealth(this.mountMonitor.getReports());
				this.publishReliability();
			})
			.catch(() => {
				// Mount observability must never break the hub.
			});
		const hostMemPercent = this.metricsLatest?.memory?.percent ?? null;
		this.memoryTracker.evaluate(hostMemPercent);

		// DEEL 2: media-state correlation (throttled internally to its own
		// cycle) + remediation verification passes. Both failure-isolated and
		// strictly observation-first: the correlator never mutates anything.
		const mountReports = this.mountMonitor.getReports();
		const mountUnhealthy = mountReports.some(
			(r) => r.state === 'unresponsive' || r.state === 'read-error'
		);
		const mountLabel =
			mountReports.find((r) => r.state === 'unresponsive' || r.state === 'read-error')?.target
				.label ?? null;
		void this.mediaFlow
			.tick({ mountUnhealthy, mountLabel })
			.then(() => this.publishMediaFlow())
			.catch(() => {});
		this.remediation.verifyPending();

		this.publishReliability();
	}

	/**
	 * Bind the remediation executor to live telemetry: DUMB's official
	 * single-service restart route plus the current process/memory picture
	 * for preflight and verification.
	 */
	private bindRemediation(): void {
		const client = this.client;
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- building the executor closure over this hub
		const hub = this;
		this.remediation.bindExecutor({
			execute: async (target) => {
				if (!client) return false;
				return client.restartService(target);
			},
			targetStatus: (target) => {
				const status = hub
					.getServices()
					.find((s) => s.processName === target || s.key === target || s.name === target);
				return {
					managed: Boolean(status) || hub.getDiscovered().some((d) => d.processName === target),
					running: status?.runState === 'running',
					restartPending: status?.restart?.pending === true,
					pid: status?.pid ?? null
				};
			},
			targetMemoryRss: (target) =>
				hub.getMetrics()?.processes.find((p) => p.name === target)?.memoryBytes ?? null,
			activeWorkReliablyVisible: () => true, // arr queue pollers run when connected
			activeWorkDetected: (target) => {
				// Restarting a *storage* service risks in-flight mount work; the
				// hint stays conservative and never blocks manual action.
				void target;
				return false;
			}
		});
	}

	/** Current media-flow picture for the API/SSE/UI (read-only). */
	getMediaFlow() {
		return {
			...this.mediaFlow.snapshot(),
			recommendations: this.mediaRecommendations(),
			actions: this.remediation.recent()
		};
	}

	/**
	 * Recommendation-only remediation proposals (brief §41): a sustained
	 * memory anomaly on a managed, running process proposes a single-service
	 * restart. No automatic execution exists in this phase.
	 */
	private mediaRecommendations() {
		const out: {
			id: string;
			kind: 'restart-managed-service';
			target: string;
			reason: string | null;
			evidence: string[];
			state: 'requested';
			requestedAt: null;
			executedAt: null;
			verifiedAt: null;
			verification: null;
			cooldownRemainingMs: number;
			attempts24h: number;
			attemptLimit: number;
			suspended: boolean;
			findingFingerprint: null;
		}[] = [];
		for (const view of this.memoryTracker
			.getViews()
			.filter((v) => v.level === 'critical' || v.level === 'warning')
			.slice(0, 3)) {
			const target = view.process;
			const status = this.getServices().find((s) => s.processName === target);
			if (!status || status.runState !== 'running') continue;
			if (this.remediation.cooldownRemainingMs(target) > 0) continue;
			const attempts = this.remediation.attempts24h(target);
			if (attempts >= 2) continue;
			out.push({
				id: `recommendation:${target}`,
				kind: 'restart-managed-service',
				target,
				reason:
					view.level === 'critical'
						? 'Memory usage is unusually high and critical'
						: 'Memory usage is unusually high and has grown continuously',
				evidence: [
					`Current ${((view.currentBytes ?? 0) / 1024 ** 3).toFixed(1)} GB`,
					view.baselineBytes !== null
						? `Typical ${(view.baselineBytes / 1024 ** 3).toFixed(1)} GB`
						: null,
					view.delta6hBytes !== null
						? `${view.delta6hBytes >= 0 ? '+' : '−'}${(Math.abs(view.delta6hBytes) / 1024 ** 3).toFixed(1)} GB over 6h`
						: null
				].filter((e): e is string => e !== null),
				state: 'requested',
				requestedAt: null,
				executedAt: null,
				verifiedAt: null,
				verification: null,
				cooldownRemainingMs: 0,
				attempts24h: attempts,
				attemptLimit: 2,
				suspended: attempts >= 2,
				findingFingerprint: null
			});
		}
		return out;
	}

	/** Fan media-flow state out when something visible changed. */
	private publishMediaFlow(): void {
		const media = this.getMediaFlow();
		const signature = JSON.stringify([media.items, media.metrics, media.actions]);
		if (signature === this.lastMediaSignature) return;
		this.lastMediaSignature = signature;
		this.broadcast('mediaFlow', media);
	}

	/** Current reliability picture for the API/SSE/UI (read-only). */
	getReliability(): ReliabilitySnapshot {
		const mountStats = this.mountMonitor.stats();
		return {
			mounts: this.mountMonitor.getReports(),
			memory: this.memoryTracker.getViews(),
			stats: {
				mountRounds: mountStats.mountRounds,
				fsCalls: fsProbeCallCount(),
				lastRoundMs: mountStats.lastRoundMs,
				memoryTracked: this.memoryTracker.trackedCount
			}
		};
	}

	/** Fan reliability state out only when something visible changed. */
	private publishReliability(): void {
		const snapshot = this.getReliability();
		const signature = JSON.stringify([
			snapshot.mounts,
			snapshot.memory,
			snapshot.stats.memoryTracked
		]);
		if (signature === this.lastReliabilitySignature) return;
		this.lastReliabilitySignature = signature;
		this.broadcast('reliability', snapshot);
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

	/** Integration state changes feed the incident engine (warning-level). */
	onIntegrationStatuses(statuses: { id: string; failures: number }[]): void {
		this.engine.onIntegrations(statuses);
	}

	getConnection(): ConnectionSnapshot {
		return this.tracker.snapshot();
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
		const connectionState = this.tracker.snapshot().state;
		let health: StackOverview['health'] = 'healthy';
		if (!this.configured) health = 'unknown';
		else if (
			connectionState === 'offline' ||
			connectionState === 'credentials-invalid' ||
			critical > 0
		)
			health = 'incident';
		else if (
			connectionState === 'starting' ||
			connectionState === 'connecting' ||
			connectionState === 'reconnecting'
		) {
			// Amber connectivity states are never a red headline (brief §12):
			// while nothing is known yet, stay neutral instead of claiming health.
			health = statuses.length === 0 ? 'unknown' : 'degraded';
		} else if (
			unhealthy > 0 ||
			degraded > 0 ||
			active.length > 0 ||
			connectionState === 'degraded' ||
			connectionState === 'stale'
		)
			health = 'degraded';
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

	/**
	 * Refresh the derived connection snapshot and fan it out when anything
	 * meaningful changed. Derived twice per tick at most; the signature
	 * comparison keeps SSE free of lastUpdateAt spam.
	 */
	private publishConnection(): void {
		const snapshot = this.tracker.snapshot();
		const signature = JSON.stringify([
			snapshot.state,
			snapshot.streams,
			snapshot.probes,
			snapshot.lastError,
			snapshot.reconnectAttempts,
			snapshot.authMode,
			snapshot.lastUpdateAt
		]);
		if (signature === this.lastConnectionSignature) return;
		this.lastConnectionSignature = signature;
		this.broadcast('connection', snapshot);
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
		onIntegrationStateChange((statuses) => hubInstance?.onIntegrationStatuses(statuses));
	}
	return hubInstance;
}

/** Test helper: drop the singleton. */
export function resetHub(): void {
	hubInstance?.stop();
	hubInstance = null;
}
