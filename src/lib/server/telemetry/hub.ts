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
	Incident,
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
import { ReconciliationRunner } from '../reconciliation/cycle';
import {
	getReconciliationAliasesJson,
	getReconciliationPlexCredentials,
	getReconciliationPlexDbPath,
	getReconciliationSelftestPaths,
	reconciliationAutoRefreshEnabled,
	reconciliationEnabled
} from '../config/settings';
import { MemoryAnomalyTracker, type MemoryTuningOverrides } from '../reliability/memory';
import { fsProbeCallCount } from '../reliability/fsprobe';
import { getRemediationManager, type RemediationManager } from '../reliability/remediation';
import { MediaFlowCorrelator, loadArrObservations } from '../media/flow';
import { IncidentSafetyNet } from '../incidents/safety-net';
import { incidentRepository } from '../incidents/repository';
import { getRuntimeMonitor } from '../runtime/monitor';
import { detectDiskTrend, detectRestartStorms } from '../reliability/anomalies';
import { CgroupMemoryMonitor, resolveContainerIdViaPrometheus } from '../reliability/cgroup';
import { InfiniDyskAggregator, parseInfiniDyskLine } from '../reliability/infinidysk';
import { ThermalMonitor } from '../reliability/thermal';
import {
	recordObservabilityEvent,
	recordTimelineThrottled,
	pruneTimeline
} from '../reliability/timeline';
import {
	buildServiceMemoryObservability,
	loadServiceMemoryPoints,
	type MemoryPoint
} from '../reliability/service-memory';
import {
	downsampleCgroupToFiveMinutes,
	downsampleCgroupToThirtyMinutes,
	pruneCgroupSamples
} from '../metrics/cgroup-retention';
import { getCachedData } from '../integrations/manager';
import { listIntegrations } from '../integrations/store';
import type {
	ArrObservability,
	InfiniDyskObservability,
	ObservabilitySnapshot,
	RoutingObservability,
	ServiceMemoryObservability,
	VersionInfo
} from '$lib/types';

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

/**
 * Path alias pairs for reconciliation (`{from, to}`), mapping Arr root
 * folders onto Plex library roots (e.g. `/media/` ↔ `/symlinks/TV Shows/`).
 * Empty/invalid JSON degrades to the DUMB defaults inside the runner.
 */
function parseAliasesJson(raw: string | null): { from: string; to: string }[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const out: { from: string; to: string }[] = [];
		for (const entry of parsed) {
			const t = entry as Partial<{ from: string; to: string }>;
			if (typeof t.from === 'string' && typeof t.to === 'string')
				out.push({ from: t.from, to: t.to });
		}
		return out;
	} catch {
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
/** Safety-net cadence: bounded lifecycle integrity pass. */
const SAFETY_NET_INTERVAL_MS = 10 * 60_000;
/** Resource-anomaly pass cadence (restart storms, disk trend). */
const ANOMALY_PASS_INTERVAL_MS = 60_000;
/** Incident history pruning cadence (bounded storage). */
const HISTORY_PRUNE_INTERVAL_MS = 24 * 60 * 60_000;

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

	// -- deep observability (cgroup, InfiniDysk, thermal, timeline) ------------
	private cgroupMonitor: CgroupMemoryMonitor;
	private infinidysk = new InfiniDyskAggregator();
	private thermalMonitor: ThermalMonitor;
	private lastCgroupSampleAt = 0;
	private lastThermalSampleAt = 0;
	private lastInfinidyskPruneAt = 0;
	private lastTimelinePruneAt = 0;
	private lastCgroupRollupAt = 0;
	private obsServices: ServiceMemoryObservability[] = [];
	private obsServicesAt = 0;
	/** Version registry (key → version + when first seen) for deploy events. */
	private versionRegistry = new Map<string, { version: string; since: number }>();
	/** Cached InfiniDysk metadata from the DUMB process registry. */
	private infinidyskMeta: {
		version: string | null;
		commit: string | null;
		baseVersion: string | null;
		gcHeapHardLimitBytes: number | null;
		autoUpdate: boolean | null;
		pinnedVersion: string | null;
	} | null = null;
	private lastObservabilitySignature: string | null = null;

	// -- lifecycle integrity + self-monitoring ---------------------------------
	private safetyNet: IncidentSafetyNet;
	private runtimeMonitor: ReturnType<typeof getRuntimeMonitor>;
	private lastSafetyNetAt = 0;
	private lastAnomalyPassAt = 0;
	private lastHistoryPruneAt = 0;
	private lastMountedPaths = new Set<string>();

	// -- media correlation + remediation (DEEL 2): observe-first ---------------
	private mediaFlow: MediaFlowCorrelator;
	private remediation: RemediationManager;
	private lastMediaSignature: string | null = null;

	// -- infrastructure ----------------------------------------------------
	private client: DumbClient | null = null;
	private streams: DumbStream[] = [];
	private engine: IncidentEngine;
	private reconciliation: ReconciliationRunner;
	private subscribers = new Map<number, Subscriber>();
	private nextSubscriberId = 1;
	private housekeeper: ReturnType<typeof setInterval> | null = null;
	/** One-shot first housekeeping tick shortly after start (readiness). */
	private startupTick: ReturnType<typeof setTimeout> | null = null;
	/** Heartbeat for the readiness probe and the stale-scheduler watchdog. */
	private lastHousekeepAt: number | null = null;
	/** Epoch ms of the last (re)start; null before the first start(). */
	private startedAt: number | null = null;
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
			onAssessment: (assessment) => {
				this.engine.onMemory(assessment);
				// Timeline fact (display only): memory anomaly lifecycle.
				if (assessment.level !== 'ok') {
					recordTimelineThrottled({
						at: Date.now(),
						kind: 'memory-anomaly',
						service: assessment.process,
						severity: assessment.level === 'critical' ? 'critical' : 'warning',
						title: `Memory anomaly on ${assessment.process}: ${assessment.level}`,
						detail: assessment.reasons.join(' · ')
					});
				}
			},
			tuning: fast?.memory
		});
		this.cgroupMonitor = new CgroupMemoryMonitor({
			now: clock,
			path: () => this.resolveDumbCgroupPath(),
			prometheusUrl: () => process.env.DUMBSCOPE_PROMETHEUS_URL ?? null,
			containerName: () => process.env.DUMBSCOPE_DUMB_CONTAINER_NAME ?? 'DUMB'
		});
		this.thermalMonitor = new ThermalMonitor({
			now: clock,
			onSpike: (snapshot) => {
				recordObservabilityEvent({
					at: snapshot.at,
					kind: 'thermal',
					severity: snapshot.level >= 95 ? 'critical' : 'warning',
					title: `Temperature crossed ${snapshot.level}°C (${snapshot.zoneType ?? 'zone'})`,
					detail: `temp ${snapshot.tempC.toFixed(0)}°C · load ${snapshot.hostLoad?.toFixed(2) ?? '?'} · DUMB CPU ${snapshot.dumbCpuPercent?.toFixed(0) ?? '?'}% · repair active: ${snapshot.infiniDyskRepairActive ? 'yes' : 'no'}`,
					data: snapshot
				});
				this.publishObservability();
			},
			onRecovery: (snapshot) => {
				recordObservabilityEvent({
					at: snapshot.recoveredAt ?? Date.now(),
					kind: 'thermal',
					severity: 'info',
					title: `Temperature recovered below ${snapshot.level}°C`,
					detail: `spike lasted ${snapshot.recoveredAt ? Math.round((snapshot.recoveredAt - snapshot.at) / 60_000) : '?'} min`,
					data: snapshot
				});
				this.publishObservability();
			}
		});
		this.mediaFlow = new MediaFlowCorrelator({
			now: clock,
			loader: loadArrObservations,
			tuning: fast ? { cycleMs: 4_000 } : undefined,
			getActiveFingerprints: () =>
				this.engine
					.getActive()
					.map((i) => i.fingerprint)
					.filter((fp) => fp.startsWith('media-')),
			onFinding: (finding) =>
				this.engine.reportFinding({
					fingerprint: finding.fingerprint,
					severity: finding.severity,
					title: finding.title,
					summary: finding.summary,
					evidence: finding.evidence,
					identity: finding.mediaKey ?? undefined
				}),
			onResolve: (fingerprint, message) => this.engine.resolveFinding(fingerprint, message)
		});
		this.remediation = getRemediationManager();
		this.reconciliation = new ReconciliationRunner({
			getSettings: () => {
				const mounts = loadMountTargets().map((t) => ({ prefix: t.path, label: t.label }));
				const aliases = parseAliasesJson(getReconciliationAliasesJson());
				return {
					enabled: reconciliationEnabled(),
					mounts,
					aliases,
					plexDbPath: getReconciliationPlexDbPath(),
					plexUrl: getReconciliationPlexCredentials()?.url ?? null,
					plexToken: getReconciliationPlexCredentials()?.token ?? null,
					plexAutoRefresh: reconciliationAutoRefreshEnabled(),
					selftestBrokenPath: getReconciliationSelftestPaths().brokenPath,
					selftestGhostPath: getReconciliationSelftestPaths().ghostPath
				};
			},
			reportFinding: (finding) =>
				this.engine.reportFinding({
					fingerprint: finding.fingerprint,
					severity: finding.severity,
					title: finding.title,
					summary: finding.summary,
					evidence: finding.evidence.join('\n')
				}),
			resolveFinding: (fingerprint) =>
				this.engine.resolveFinding(fingerprint, 'Reconciled: filesystem, Arr and Plex agree again'),
			getActiveFingerprints: () =>
				this.engine
					.getActive()
					.map((i) => i.fingerprint)
					.filter((fp) => fp.startsWith('recon:'))
		});
		// Lifecycle integrity safety net (§3) + self-monitoring (§4/§5).
		this.safetyNet = new IncidentSafetyNet(this.engine);
		this.runtimeMonitor = getRuntimeMonitor({
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
		this.runtimeMonitor.setProviders({
			sseClients: () => this.subscriberCount(),
			reconDurationMs: () => this.reconciliation.observability().lastAttempt?.durationMs ?? null,
			probeDurationMs: () => this.mountMonitor.stats().lastRoundMs,
			jobsActive: () => this.scheduledJobCount(),
			reconWorkersActive: () => 0, // the prober worker is idle-cycled; tracked via fsprobe counters
			housekeepingHeartbeatMs: () => this.housekeepingHeartbeatMs,
			schedulerStarted: () => this.isStarted,
			reconciliationRun: () => {
				const o = this.reconciliation.observability();
				return { running: o.running, startedAt: o.currentRunStartedAt };
			}
		});
	}

	/**
	 * (Re)configure and start. Safe to call again after settings changes;
	 * tears down existing streams first.
	 */
	start(): void {
		this.stopped = false;
		this.startedAt = Date.now();
		const settings = getSettings();
		this.configured = Boolean(settings.dumbUrl);
		this.stopStreams();
		this.tracker.setConfigured(this.configured);
		this.tracker.hubRestart();

		if (!settings.dumbUrl) {
			this.publishConnection();
			this.ensureSchedulers();
			return;
		}

		this.client = new DumbClient({
			baseUrl: settings.dumbUrl,
			getCredentials: () => getDumbCredentials()
		});
		this.bindRemediation();

		void this.bootstrapRest();

		this.startStreams(settings);
		this.ensureSchedulers();
		this.reconciliation.start();
		this.publishConnection();
	}

	/**
	 * Housekeeping + self-monitoring schedulers run regardless of whether a
	 * DUMB gateway is configured: an unconfigured instance must still be
	 * *ready* (it serves the setup wizard) and still watches itself. The first
	 * housekeeping tick fires shortly after start so readiness converges in
	 * ~1s instead of one full interval.
	 */
	private ensureSchedulers(): void {
		if (!this.startupTick) {
			this.startupTick = setTimeout(() => {
				this.startupTick = null;
				this.housekeep();
			}, 1_000);
			this.startupTick.unref?.();
		}
		this.housekeeper ??= setInterval(() => this.housekeep(), 10_000);
		this.runtimeMonitor.start();
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
		this.reconciliation.stop();
		this.runtimeMonitor.stop();
		this.lastHousekeepAt = null;
		if (this.startupTick) {
			clearTimeout(this.startupTick);
			this.startupTick = null;
		}
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
		this.trackVersions(discovered);
		this.trackInfinidyskMeta(response);
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

	/**
	 * Version/update awareness (brief §10): the registry already carries every
	 * service's version + update verdict. Diffing it across discovery refreshes
	 * yields deploy timeline events and "first seen at" stamps — without any
	 * extra polling of DUMB.
	 */
	private trackVersions(discovered: DiscoveredService[]): void {
		const now = Date.now();
		for (const service of discovered) {
			if (!service.enabled || !service.version) continue;
			const known = this.versionRegistry.get(service.key);
			if (!known) {
				this.versionRegistry.set(service.key, { version: service.version, since: now });
				continue;
			}
			if (known.version !== service.version) {
				recordObservabilityEvent({
					at: now,
					kind: 'deploy',
					service: service.key,
					severity: 'info',
					title: `${service.name} updated: ${known.version} → ${service.version}`,
					detail: service.updateStatus
						? `update status: ${service.updateStatus.status}${service.updateStatus.availableVersion ? ` (available: ${service.updateStatus.availableVersion})` : ''}`
						: null
				});
				this.versionRegistry.set(service.key, { version: service.version, since: now });
			}
		}
	}

	/**
	 * InfiniDysk-specific registry facts: runtime version, base NZBDAV version,
	 * .NET GC heap hard limit and update policy — all straight from DUMB's own
	 * registry entry (no config files mounted, no secrets read).
	 */
	private trackInfinidyskMeta(response: DumbProcessesResponse): void {
		const entry = (response.processes ?? []).find((p) =>
			/infinidysk/i.test(p.name ?? p.process_name ?? '')
		);
		if (!entry) {
			this.infinidyskMeta = null;
			return;
		}
		const env = (entry.config as { env?: Record<string, string> } | undefined)?.env ?? {};
		const gcRaw = env['DOTNET_GCHeapHardLimit'];
		let gcBytes: number | null = null;
		if (typeof gcRaw === 'string' && /^0x[0-9a-f]+$/i.test(gcRaw)) {
			const n = Number(gcRaw);
			if (Number.isFinite(n)) gcBytes = n;
		} else if (typeof gcRaw === 'string' && Number.isFinite(Number(gcRaw))) {
			gcBytes = Number(gcRaw);
		}
		this.infinidyskMeta = {
			version: entry.version ?? null,
			commit:
				typeof entry.config === 'object' && entry.config !== null
					? ((entry.config as { commit_sha?: string }).commit_sha ?? null)
					: null,
			baseVersion: env['NZBDAV_VERSION'] ?? null,
			gcHeapHardLimitBytes: gcBytes,
			autoUpdate:
				typeof entry.config === 'object' && entry.config !== null
					? ((entry.config as { auto_update?: boolean }).auto_update ?? null)
					: null,
			pinnedVersion:
				typeof entry.config === 'object' && entry.config !== null
					? ((entry.config as { pinned_version?: string | null }).pinned_version ?? null)
					: null
		};
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
						recordTimelineThrottled({
							at: now,
							kind: 'restart',
							service: status.key,
							severity: prev.runState === 'stopped' ? 'info' : 'warning',
							title: `${status.name} restarted`,
							detail:
								prev.health !== status.health ? `health: ${prev.health} → ${status.health}` : null
						});
					}
					if (prev.runState === 'running' && status.runState === 'stopped') {
						recordActivity('service-stopped', `${status.name} stopped`, status.key);
						recordTimelineThrottled({
							at: now,
							kind: 'restart',
							service: status.key,
							severity: 'warning',
							title: `${status.name} stopped`
						});
					}
					if (
						status.health === 'unhealthy' ||
						(status.health === 'degraded' && prev.health === 'healthy')
					) {
						recordTimelineThrottled({
							at: now,
							kind: 'health',
							service: status.key,
							severity: status.health === 'unhealthy' ? 'critical' : 'warning',
							title: `${status.name} is ${status.health}`,
							detail: status.healthReason
						});
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
		// Instance keys (§8) keep same-name service instances from mixing.
		const identities = new Map<string, string>();
		for (const proc of snapshot.processes) {
			const discovered = this.discoveredByProcess.get(proc.name);
			if (discovered) identities.set(proc.name, discovered.key);
		}
		this.memoryTracker.onSnapshot(snapshot, identities);
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
			this.feedInfiniDyskLogLine(logLine);
		}
		if (this.logBuffer.length > LOG_RING_SIZE) {
			this.logBuffer = this.logBuffer.slice(-LOG_RING_SIZE);
		}
	}

	/**
	 * InfiniDysk observability rides the existing log stream (brief §4): the
	 * aggregator only watches InfiniDysk lines and keeps bounded aggregates.
	 * Repair-loop starts become timeline facts; nothing here alerts.
	 */
	private feedInfiniDyskLogLine(line: LogLine): void {
		const isInfiniDysk =
			/infinidysk/i.test(line.process) || /infinidysk subprocess/i.test(line.message);
		if (!isInfiniDysk) return;
		const parsed = parseInfiniDyskLine(line.message, line.ts ?? Date.now());
		if (!parsed) return;
		this.infinidysk.onEvent(parsed);
		if (parsed.kind === 'repair-start' && parsed.file) {
			const recorded = recordTimelineThrottled({
				at: parsed.at,
				kind: 'repair-loop',
				service: 'infinidysk',
				severity: parsed.segments !== null && parsed.segments > 0 ? 'warning' : 'info',
				title: `InfiniDysk repair started: ${parsed.file}`,
				detail: `${parsed.segments ?? '?'} missing/corrupt segments`
			});
			if (recorded) this.publishObservability();
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
		// Heartbeat: readiness probe and the stale-scheduler watchdog both read
		// this — it is stamped on every completed tick, configured or not.
		this.lastHousekeepAt = now;
		// Keep the notification engine's outbound deep links in sync with settings.
		setPublicBaseUrl(getSettings().notificationPublicBaseUrl);
		const connection = this.tracker.snapshot();
		const statusLive = connection.streams.status === 'live';
		this.engine.onTick(this.metricsLatest?.receivedAt ?? null, statusLive);
		this.engine.correlate(this.topology());
		this.engine.onConnection(connection);
		this.runReliabilityChecks();
		this.runLifecyclePasses(now);

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
	 * Lifecycle integrity passes (§1/§3): keep mount targets in sync with the
	 * configuration, run the stale-incident safety net on its bounded cadence,
	 * the resource-anomaly passes, and prune incident history to its cap.
	 * Every pass is failure-isolated — lifecycle bookkeeping must never break
	 * the telemetry loop.
	 */
	private runLifecyclePasses(now: number): void {
		try {
			// Mount target sync: new targets start probing, removed targets stop
			// and their findings retire as obsolete ("target removed").
			const targets = loadMountTargets();
			const removedPaths = this.mountMonitor.syncTargets(targets);
			for (const path of removedPaths) {
				this.engine.resolveWhere(
					(i) =>
						(i.fingerprint.startsWith('mount:') || i.fingerprint.startsWith('symlinks:')) &&
						this.engine.identityOf(i.fingerprint) === path,
					() => `Resolved: monitored mount "${path}" was removed from the configuration`,
					now
				);
			}
			// Dependency evidence for correlation: mount path → consumer keys.
			this.engine.setMountConsumerIndex(new Map(targets.map((t) => [t.path, t.consumers])));
			this.lastMountedPaths = new Set(targets.map((t) => t.path));
		} catch {
			// config sync is best-effort
		}

		if (now - this.lastSafetyNetAt >= SAFETY_NET_INTERVAL_MS) {
			this.lastSafetyNetAt = now;
			try {
				void import('../integrations/store').then(({ listIntegrations }) => {
					const settings = getSettings();
					this.safetyNet.run({
						now,
						mountTargets: loadMountTargets(),
						mountMonitoringEnabled: settings.mountMonitoring,
						memoryMonitoringEnabled: settings.memoryMonitoring,
						reconciliationEnabled: reconciliationEnabled(),
						runtimeMonitoringEnabled: true,
						registeredIntegrationIds: listIntegrations().map((c) => c.id),
						arrIntegrationsPresent: listIntegrations().some(
							(c) => c.enabled !== false && (c.type === 'sonarr' || c.type === 'radarr')
						),
						dumbConfigured: this.configured,
						metricsFresh:
							this.metricsLatest !== null && now - this.metricsLatest.receivedAt < 5 * 60_000,
						// Pre-v0.8 rows get one hour to be re-adopted by a detector
						// before the legacy retirement rule applies.
						legacyGraceElapsed: now - this.bootAt > 60 * 60_000
					});
				});
			} catch {
				// isolated
			}
		}

		if (now - this.lastAnomalyPassAt >= ANOMALY_PASS_INTERVAL_MS) {
			this.lastAnomalyPassAt = now;
			try {
				const nameFor = (key: string): string =>
					this.getServices().find((s) => s.key === key)?.name ??
					this.getDiscovered().find((d) => d.key === key)?.name ??
					key;
				const storms = detectRestartStorms(nameFor);
				const stormFps = new Set(storms.map((s) => s.fingerprint));
				for (const storm of storms) {
					this.engine.reportFinding({
						fingerprint: storm.fingerprint,
						severity: storm.severity,
						title: storm.title,
						summary: storm.summary,
						evidence: storm.evidence,
						identity: storm.identity
					});
				}
				for (const fp of this.engine.openFingerprints(['restart-storm:'])) {
					if (!stormFps.has(fp)) {
						this.engine.resolveFinding(fp, 'Restart rate returned to normal');
					}
				}
				const diskFinding = detectDiskTrend(this.metricsHistory);
				if (diskFinding) {
					this.engine.reportFinding({
						fingerprint: diskFinding.fingerprint,
						severity: diskFinding.severity,
						title: diskFinding.title,
						summary: diskFinding.summary,
						evidence: diskFinding.evidence,
						identity: diskFinding.identity
					});
				} else {
					this.engine.resolveFinding(
						'disk-trend:host',
						'Disk growth trend is no longer projected to reach the warning level'
					);
				}
			} catch {
				// isolated
			}
		}

		if (now - this.lastHistoryPruneAt >= HISTORY_PRUNE_INTERVAL_MS) {
			this.lastHistoryPruneAt = now;
			try {
				incidentRepository.pruneHistory(500);
			} catch {
				// isolated
			}
		}
	}

	/** Alive scheduled timers across the known registries (runtime panel). */
	private scheduledJobCount(): number {
		let count = 0;
		if (this.housekeeper) count++;
		if (this.reconciliation.observability().nextRunAt !== null) count += 2; // cycle + startup timers
		return count;
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
		this.runObservabilityPasses();

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
	 * Deep observability passes (brief §2/§3/§4/§7/§8), all failure-isolated
	 * and driven by the same 10s housekeeping tick with per-pass gates:
	 * cgroup sample (60s), thermal sample (60s), per-service memory views
	 * (60s), InfiniDysk aggregate prune (30 min), cgroup rollups (hourly,
	 * mirroring the runtime monitor's maintenance pass) and timeline prune
	 * (daily, sharing the history-prune cadence).
	 */
	private runObservabilityPasses(): void {
		const now = Date.now();
		if (now - this.lastCgroupSampleAt >= 60_000) {
			this.lastCgroupSampleAt = now;
			void this.cgroupMonitor
				.sample()
				.then((snapshot) => {
					if (snapshot.interpretation.softReclaimActive) {
						const recorded = recordTimelineThrottled({
							at: now,
							kind: 'cgroup-high',
							service: 'dumb',
							severity: 'info',
							title: 'DUMB cgroup soft-limit reclaim active (memory.high)',
							detail: `current ${((snapshot.breakdown.currentBytes ?? 0) / 1024 ** 3).toFixed(2)} GiB of high ${(snapshot.highBytes ?? 0) / 1024 ** 3} GiB`
						});
						if (recorded) this.publishObservability();
					}
					this.publishObservability();
				})
				.catch(() => {});
		}
		if (now - this.lastThermalSampleAt >= 60_000) {
			this.lastThermalSampleAt = now;
			try {
				const processes = [...(this.metricsLatest?.processes ?? [])]
					.filter((p) => p.cpuPercent !== null)
					.sort((a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0));
				this.thermalMonitor.sample({
					hostLoad: this.metricsLatest?.loadAvg?.[0] ?? null,
					dumbCpuPercent: this.metricsLatest?.cpuPercent ?? null,
					topProcesses: processes.slice(0, 3).map((p) => ({
						name: p.name,
						cpuPercent: p.cpuPercent
					})),
					infiniDyskRepairActive: this.infinidysk.isRepairActive()
				});
			} catch {
				// thermal observability must never break the hub
			}
		}
		if (now - this.obsServicesAt >= 60_000) {
			this.obsServicesAt = now;
			try {
				this.obsServices = this.buildServiceMemoryViews(now);
				this.publishObservability();
			} catch {
				// isolated
			}
		}
		if (now - this.lastInfinidyskPruneAt >= 30 * 60_000) {
			this.lastInfinidyskPruneAt = now;
			try {
				this.infinidysk.prune(now);
			} catch {
				// isolated
			}
		}
		if (now - this.lastCgroupRollupAt >= 60 * 60_000) {
			this.lastCgroupRollupAt = now;
			try {
				downsampleCgroupToFiveMinutes(now);
				downsampleCgroupToThirtyMinutes(now);
				pruneCgroupSamples(now);
			} catch {
				// isolated
			}
		}
		if (now - this.lastTimelinePruneAt >= 24 * 60 * 60_000) {
			this.lastTimelinePruneAt = now;
			try {
				pruneTimeline(now);
			} catch {
				// isolated
			}
		}
	}
	/**
	 * Per-service memory observability (brief §2): classify every discovered
	 * managed service from its stored RSS series. Heavy lift (SQL + Theil–Sen)
	 * runs on the 60s gate; failures degrade to an honest empty list.
	 */
	private buildServiceMemoryViews(now: number): ServiceMemoryObservability[] {
		const views: ServiceMemoryObservability[] = [];
		const live = new Map((this.metricsLatest?.processes ?? []).map((p) => [p.name, p]));
		for (const service of this.discovered) {
			if (!service.enabled) continue;
			try {
				const proc = live.get(service.processName);
				const points: MemoryPoint[] = loadServiceMemoryPoints(
					service.processName,
					service.key,
					now - 7 * 24 * 60 * 60_000,
					now
				);
				const view = buildServiceMemoryObservability({
					key: service.key,
					name: service.name,
					processName: service.processName,
					threads: proc?.threads ?? null,
					uptimeSeconds:
						proc?.startedAtSeconds !== null && proc?.startedAtSeconds !== undefined
							? Math.max(0, Math.round(now / 1000 - proc.startedAtSeconds))
							: null,
					version: service.version,
					points,
					now
				});
				views.push(view);
			} catch {
				// one bad series must never abort the rest
			}
		}
		views.sort((a, b) => (b.currentBytes ?? 0) - (a.currentBytes ?? 0));
		return views;
	}

	/** Current deep-observability picture for the API/SSE/UI (read-only). */
	getObservability(): ObservabilitySnapshot {
		return {
			cgroup: this.cgroupMonitor.getSnapshot(),
			services: this.obsServices,
			baselineShifts: this.obsServices.filter((s) => s.baselineShift !== null),
			infiniDysk: this.buildInfinidyskObservability(),
			thermal: this.thermalMonitor.getSnapshot(),
			ars: this.buildArrObservability(),
			routing: this.buildRoutingObservability(),
			versions: this.buildVersionInfo()
		};
	}

	/**
	 * Resolve the DUMB container's cgroup directory (read-only source):
	 * explicit path (DUMBSCOPE_DUMB_CGROUP_PATH) wins; else a mounted parent
	 * (DUMBSCOPE_DUMB_CGROUP_PARENT) plus a container id — either from
	 * DUMBSCOPE_DUMB_CONTAINER_ID or resolved via Prometheus cadvisor's id
	 * label (cached 10 min) so the path survives DUMB container recreations.
	 */
	private dumbCgroupIdResolvedAt = 0;
	private dumbCgroupId: string | null = null;
	private resolveDumbCgroupPath(): string | null {
		const explicit = process.env.DUMBSCOPE_DUMB_CGROUP_PATH ?? null;
		if (explicit) return explicit;
		const parent = process.env.DUMBSCOPE_DUMB_CGROUP_PARENT ?? null;
		if (!parent) return null;
		const envId = process.env.DUMBSCOPE_DUMB_CONTAINER_ID ?? null;
		if (envId) return parent + '/' + envId;
		const now = Date.now();
		if (this.dumbCgroupId !== null && now - this.dumbCgroupIdResolvedAt < 10 * 60_000) {
			return parent + '/' + this.dumbCgroupId;
		}
		const prom = process.env.DUMBSCOPE_PROMETHEUS_URL ?? null;
		if (!prom) return null;
		const name = process.env.DUMBSCOPE_DUMB_CONTAINER_NAME ?? 'DUMB';
		this.dumbCgroupIdResolvedAt = now;
		void resolveContainerIdViaPrometheus(prom, name)
			.then((id) => {
				this.dumbCgroupId = id;
			})
			.catch(() => {});
		return this.dumbCgroupId !== null ? parent + '/' + this.dumbCgroupId : null;
	}

	/** In-memory thermal series for the Observability history charts. */
	observabilityThermalSeries(): { at: number; maxC: number | null; packageC: number | null }[] {
		return this.thermalMonitor.getSeries();
	}

	private buildInfinidyskObservability(): InfiniDyskObservability {
		const counters = this.infinidysk.counters();
		const files = this.infinidysk.getFiles();
		const live = (this.metricsLatest?.processes ?? []).find((p) => /infinidysk/i.test(p.name));
		const mount = this.mountMonitor
			.getReports()
			.find((r) => /infinidysk|debrid/i.test(r.target.path));
		const meta = this.infinidyskMeta;
		const registryEntry = this.discovered.find((d) => /infinidysk/i.test(d.processName));
		return {
			available: meta !== null,
			unavailableReason: meta === null ? 'InfiniDysk is not in the DUMB process registry' : null,
			version: meta?.version ?? registryEntry?.version ?? null,
			baseVersion: meta?.baseVersion ?? null,
			commit: meta?.commit ?? null,
			gcHeapHardLimitBytes: meta?.gcHeapHardLimitBytes ?? null,
			autoUpdate: meta?.autoUpdate ?? null,
			pinnedVersion: meta?.pinnedVersion ?? null,
			rss: live?.memoryBytes ?? null,
			threads: live?.threads ?? null,
			cpuPercent: live?.cpuPercent ?? null,
			uptimeSeconds:
				live?.startedAtSeconds !== null && live?.startedAtSeconds !== undefined
					? Math.max(0, Math.round(Date.now() / 1000 - live.startedAtSeconds))
					: null,
			growthBytesPerHour:
				this.obsServices.find((s) => /infinidysk/i.test(s.processName))?.slopeBytesPerHour ?? null,
			repairActive: this.infinidysk.isRepairActive(),
			lastRepairAt: counters.lastRepairAt,
			repairs1h: counters.repairs1h,
			repairs24h: counters.repairs24h,
			article430_1h: counters.article430_1h,
			article430_24h: counters.article430_24h,
			missingSegments1h: counters.missingSegments1h,
			missingSegments24h: counters.missingSegments24h,
			providerFallbacks24h: counters.providerFallbacks24h,
			mountState: mount?.state ?? null,
			restarts24h: this.restarts24h('infinidysk'),
			lastRestartAt: this.lastRestartAt('infinidysk'),
			files
		};
	}

	private restarts24h(keyPart: string): number {
		const key = [...this.services.keys()].find((k) => k.includes(keyPart));
		if (!key) return 0;
		const status = this.services.get(key);
		return status?.restart?.attempts ?? 0;
	}

	private lastRestartAt(keyPart: string): number | null {
		const key = [...this.services.keys()].find((k) => k.includes(keyPart));
		if (!key) return null;
		const status = this.services.get(key);
		const raw = status?.restart?.lastRestartTime ?? null;
		if (raw === null) return null;
		const ms = typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(raw);
		return Number.isFinite(ms) ? ms : null;
	}

	private buildArrObservability(): ArrObservability[] {
		const out: ArrObservability[] = [];
		try {
			const integrations = listIntegrations().filter(
				(c) => c.enabled !== false && (c.type === 'sonarr' || c.type === 'radarr')
			);
			for (const integration of integrations) {
				const stack = getCachedData<ArrObservability>(integration.id, 'stack-observability');
				if (stack) {
					out.push(stack);
					continue;
				}
				out.push({
					type: integration.type as 'sonarr' | 'radarr',
					integrationId: integration.id,
					connected: false,
					unavailableReason: 'no successful poll yet',
					version: null,
					uptimeSeconds: null,
					dbBytes: null,
					queue: null,
					queueWarnings: null,
					queueFailures: null,
					blocklistSize: null,
					historyEvents: null,
					imports24h: 0,
					failures24h: 0,
					grabs24h: 0,
					rssSync: { lastAt: null, count24h: 0 },
					searches: { count24h: 0, recent: [] },
					fetchedAt: null
				});
			}
		} catch {
			// integrations not initialized — empty list
		}
		return out;
	}

	private buildRoutingObservability(): RoutingObservability {
		const merged: RoutingObservability = {
			windowHours: 24,
			clients: [],
			preferredProtocol: { sonarr: null, radarr: null },
			fetchedAt: null,
			stale: true
		};
		try {
			for (const integration of listIntegrations()) {
				if (integration.enabled === false) continue;
				if (integration.type !== 'sonarr' && integration.type !== 'radarr') continue;
				const view = getCachedData<{
					windowHours: number;
					clients: RoutingObservability['clients'];
					preferredProtocol: string | null;
					fetchedAt: number;
				}>(integration.id, 'routing');
				if (!view) continue;
				merged.clients.push(...view.clients);
				merged.preferredProtocol[integration.type] = view.preferredProtocol;
				merged.windowHours = view.windowHours;
				merged.fetchedAt = Math.max(merged.fetchedAt ?? 0, view.fetchedAt);
				merged.stale = false;
			}
		} catch {
			// integrations not initialized
		}
		return merged;
	}

	private buildVersionInfo(): VersionInfo[] {
		const out: VersionInfo[] = [];
		for (const service of this.discovered) {
			if (!service.enabled) continue;
			const known = this.versionRegistry.get(service.key);
			out.push({
				key: service.key,
				name: service.name,
				version: service.version,
				commit: /infinidysk/i.test(service.processName)
					? (this.infinidyskMeta?.commit ?? null)
					: null,
				since: known?.since ?? null,
				updateAvailable:
					service.updateStatus !== null
						? service.updateStatus.status === 'update_available' ||
							(service.updateStatus.availableVersion !== null &&
								service.updateStatus.availableVersion !== service.updateStatus.currentVersion)
						: null,
				availableVersion: service.updateStatus?.availableVersion ?? null,
				updateStatus: service.updateStatus?.status ?? null,
				autoUpdate: /infinidysk/i.test(service.processName)
					? (this.infinidyskMeta?.autoUpdate ?? null)
					: null,
				pinned: /infinidysk/i.test(service.processName)
					? (this.infinidyskMeta?.pinnedVersion ?? null) !== null ||
						this.infinidyskMeta?.autoUpdate === false
					: false
			});
		}
		return out;
	}

	/** Fan observability state out when something visible changed (throttled). */
	publishObservability(): void {
		try {
			const snapshot = this.getObservability();
			const signature = JSON.stringify([
				snapshot.cgroup,
				snapshot.thermal.spikeLevel,
				snapshot.infiniDysk.repairActive,
				snapshot.infiniDysk.repairs1h,
				snapshot.routing.clients.map((c) => [c.client, c.grabs, c.imports, c.failures]),
				snapshot.services.map((s) => [s.key, s.classification])
			]);
			if (signature === this.lastObservabilitySignature) return;
			this.lastObservabilitySignature = signature;
			this.broadcast('observability', snapshot);
		} catch {
			// isolated
		}
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

	/** True once start() has armed the schedulers at least once. */
	get isStarted(): boolean {
		return this.startedAt !== null;
	}

	/** Ms since the last completed housekeeping tick (null before the first). */
	get housekeepingHeartbeatMs(): number | null {
		return this.lastHousekeepAt === null ? null : Date.now() - this.lastHousekeepAt;
	}

	/** Epoch ms of the process boot as observed by the hub's monitor. */
	get bootAt(): number {
		return this.runtimeMonitor.startedAt;
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

	/** Aggregated incident counts (header badges). */
	getIncidentCounts() {
		return incidentRepository.counts();
	}

	/** DUMBscope runtime self-monitoring sample + lag stats (System panel). */
	getRuntimeSnapshot() {
		return {
			sample: this.runtimeMonitor.latest(),
			lag: this.runtimeMonitor.lagStats(),
			uptimeMs: this.runtimeMonitor.uptimeMs()
		};
	}

	/** Reconciliation observability (last runs, status, next scheduled). */
	getReconciliationObservability() {
		return this.reconciliation.observability();
	}

	/** Stale-incident safety net bookkeeping (System panel). */
	getSafetyNetInfo() {
		return {
			lastInspectedAt: this.safetyNet.lastInspectedAt,
			lastResolvedCount: this.safetyNet.lastResolvedCount
		};
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

	/**
	 * Fan out one operator-driven incident change (acknowledge/archive) so
	 * every open tab sees it live, same as detector-driven changes.
	 */
	notifyIncidentChange(incident: Incident): void {
		this.broadcast('incident', incident);
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
