/**
 * Shared domain types used by both the server and the browser.
 *
 * These describe DUMBscope's *normalized* view of the world. Raw DUMB API
 * shapes stay inside `src/lib/server/dumb` and are converted at the boundary.
 */

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/** DUMB health probe result. `unknown` means we have not observed it yet. */
export type HealthStatus = 'healthy' | 'degraded' | 'starting' | 'unhealthy' | 'unknown';

/** Process run state (kept separate from health on purpose — see docs). */
export type RunState = 'running' | 'stopped' | 'starting' | 'stopped-unknown' | 'unknown';

export interface RestartState {
	attempts: number;
	successes: number;
	failures: number;
	recentAttempts: number;
	pending: boolean;
	nextRestartTime: number | null;
	disabled: boolean;
	lastRestartTime: number | null;
	lastFailureReason: string | null;
	lastExitTime: number | null;
	lastExitReason: string | null;
	unhealthyCount: number;
	unhealthyThreshold: number | null;
}

export interface HealthDetails {
	probe?: string;
	endpoint?: string;
	supported?: boolean;
	httpStatus?: number;
	reportedStatus?: string;
	latencyMs?: number | null;
	ports?: number[];
	components?: { name: string; state: string }[];
}

/** A service as discovered from the DUMB process registry. */
export interface DiscoveredService {
	/** Stable key (DUMB `config_key` or derived from the process name). */
	key: string;
	/** Display name as DUMB reports it. */
	name: string;
	processName: string;
	enabled: boolean;
	version: string | null;
	repoUrl: string | null;
	updateStatus: {
		status: string;
		currentVersion: string | null;
		availableVersion: string | null;
	} | null;
}

/** Current normalized status for one service. */
export interface ServiceStatus {
	key: string;
	name: string;
	processName: string;
	enabled: boolean;
	runState: RunState;
	health: HealthStatus;
	healthReason: string | null;
	healthDetails: HealthDetails | null;
	restart: RestartState | null;
	/** Latest per-process metrics if the metrics stream reported them. */
	cpuPercent: number | null;
	memoryBytes: number | null;
	pid: number | null;
	observedAt: number;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface FilesystemMetric {
	path: string;
	totalBytes: number;
	usedBytes: number;
	freeBytes: number;
	percent: number;
	inodePercent: number | null;
}

export interface NetworkInterfaceMetric {
	name: string;
	sentBytes: number;
	recvBytes: number;
	sentRate: number | null;
	recvRate: number | null;
}

export interface ProcessMetric {
	name: string;
	pid: number | null;
	cpuPercent: number | null;
	memoryBytes: number | null;
}

export interface MetricsSnapshot {
	timestamp: number;
	receivedAt: number;
	cpuPercent: number | null;
	cpuCount: number | null;
	loadAvg: [number, number, number] | null;
	memory: { totalBytes: number; usedBytes: number; percent: number } | null;
	filesystems: FilesystemMetric[];
	network: NetworkInterfaceMetric[];
	networkTotals: { sentBytes: number; recvBytes: number } | null;
	processes: ProcessMetric[];
	databaseHealth: DatabaseHealthObservation[];
}

export interface DatabaseHealthObservation {
	processName: string;
	healthy: boolean | null;
	reason: string | null;
	observedAt: number;
}

/** One prepared history point used by charts. */
export interface MetricsHistoryPoint {
	t: number;
	cpu: number | null;
	mem: number | null;
	disk: number | null;
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'raw';

export interface LogLine {
	/** Monotonic id inside the live buffer. */
	id: number;
	/** Epoch ms when known, null when unparseable. */
	ts: number | null;
	level: LogLevel;
	process: string;
	message: string;
	receivedAt: number;
}

// ---------------------------------------------------------------------------
// Connection / freshness
// ---------------------------------------------------------------------------

export type StreamName = 'rest' | 'status' | 'metrics' | 'logs';

/**
 * Hub-level connection states (FASE A reliability state machine).
 *
 * The state is *derived* from layer facts (REST/auth probes + per-stream
 * sockets) by a single tracker; it is never written ad hoc. Amber states
 * (`starting`, `connecting`, `reconnecting`, `degraded`, `stale`) are honest
 * partial states — only `offline` claims that DUMB is genuinely unreachable.
 */
export type ConnectionState =
	/** Bounded grace right after DUMBscope/hub start, driven by real probe
	 *  progress — never a fixed delay. Amber, never an incident by itself. */
	| 'starting'
	| 'connecting'
	| 'live'
	/** Partial connectivity: e.g. HTTP/REST reachable but streams down, or
	 *  only some streams delivering. Reported honestly instead of as offline. */
	| 'degraded'
	/** Contact was established before and is being re-established. */
	| 'reconnecting'
	| 'stale'
	/** Probes failing beyond the startup/recovery grace windows. */
	| 'offline'
	| 'unconfigured'
	| 'credentials-invalid';

/** Result of one layered connectivity probe (HTTP / auth / REST). */
export interface ConnectionProbe {
	status: 'ok' | 'failed' | 'unknown';
	/** Stable machine-readable failure class for evidence and diagnostics. */
	code:
		| 'refused'
		| 'timeout'
		| 'dns'
		| 'network'
		| 'http-error'
		| 'auth-rejected'
		| 'no-credentials'
		| 'error'
		| null;
	/** Human-readable detail, e.g. "connection refused" or "HTTP 503". */
	detail: string | null;
	/** Epoch ms of the last probe attempt (ok or failed). */
	at: number | null;
	/** Epoch ms of the last success on this layer. */
	okAt: number | null;
}

export interface ConnectionSnapshot {
	state: ConnectionState;
	streams: Record<StreamName, ConnectionState>;
	lastUpdateAt: number | null;
	/** Epoch ms of the last successful contact with DUMB on any layer. */
	lastSuccessAt: number | null;
	/** Epoch ms the current live session started (null when not live). */
	connectedSince: number | null;
	/** Epoch ms the current state was entered. */
	stateSince: number | null;
	lastError: string | null;
	reconnectAttempts: number;
	dumbVersion: string | null;
	authMode: 'none' | 'local' | 'oidc' | 'hybrid' | 'unknown';
	/** Layered probe results; stream layers are covered by `streams`. */
	probes: Record<'http' | 'auth' | 'rest', ConnectionProbe>;
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export type IncidentSeverity = 'info' | 'warning' | 'critical';
export type IncidentStatus = 'active' | 'resolved';

export interface IncidentEvidence {
	at: number;
	source: 'status' | 'logs' | 'metrics' | 'connection' | 'integration' | 'reliability';
	message: string;
}

export interface IncidentTimelineEntry {
	at: number;
	message: string;
	severity: IncidentSeverity;
}

export interface Incident {
	id: string;
	fingerprint: string;
	severity: IncidentSeverity;
	status: IncidentStatus;
	title: string;
	summary: string | null;
	rootCauseService: string | null;
	rootCauseFingerprint: string | null;
	affectedServices: string[];
	firstSeen: number;
	lastSeen: number;
	resolvedAt: number | null;
	occurrences: number;
	evidence: IncidentEvidence[];
	timeline: IncidentTimelineEntry[];
}

// ---------------------------------------------------------------------------
// Topology
// ---------------------------------------------------------------------------

export type PipelineCategory =
	| 'core'
	| 'request'
	| 'discovery'
	| 'manager'
	| 'indexer'
	| 'acquisition'
	| 'debrid'
	| 'usenet'
	| 'bridge'
	| 'mount'
	| 'storage'
	| 'database'
	| 'import'
	| 'subtitles'
	| 'media-server'
	| 'analytics'
	| 'auxiliary';

export interface TopologyNode {
	key: string;
	name: string;
	category: PipelineCategory;
	health: HealthStatus;
	runState: RunState;
	known: boolean;
}

export interface TopologyEdge {
	from: string;
	to: string;
	/** Severity for the edge color: healthy/degraded/failed. */
	health: 'healthy' | 'degraded' | 'failed' | 'unknown';
}

export interface TopologyGraph {
	nodes: TopologyNode[];
	edges: TopologyEdge[];
}

// ---------------------------------------------------------------------------
// Stack overview
// ---------------------------------------------------------------------------

export type StackHealth = 'healthy' | 'degraded' | 'incident' | 'unknown';

export interface StackOverview {
	health: StackHealth;
	servicesOnline: number;
	servicesDegraded: number;
	servicesUnhealthy: number;
	servicesStopped: number;
	servicesTotal: number;
	activeIncidents: number;
	criticalIncidents: number;
}

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

export type ActivityKind =
	| 'health-transition'
	| 'restart'
	| 'connection'
	| 'incident'
	| 'service-started'
	| 'service-stopped';

export interface ActivityEntry {
	id: number;
	at: number;
	serviceKey: string | null;
	kind: ActivityKind;
	message: string;
	/** `observed` facts come straight from DUMB; `inferred` ones are correlated. */
	confidence: 'observed' | 'inferred';
}

// ---------------------------------------------------------------------------
// App metadata
// ---------------------------------------------------------------------------

export interface AppInfo {
	version: string;
	buildSha: string | null;
	buildTime: string | null;
	nodeVersion: string;
}

// ---------------------------------------------------------------------------
// Reliability — mount health (FASE B, read-only observability)
// ---------------------------------------------------------------------------

/**
 * Normalized health of one monitored mount path. Everything here is derived
 * from read-only probes (stat / bounded listing / symlink sampling) with hard
 * timeouts — mounting, remounting or restarting anything is out of scope.
 */
export type MountHealth =
	/** Probes succeeded; latency within bounds. */
	| 'healthy'
	/** Probes succeeded but latency is conspicuously high. */
	| 'slow'
	/** Some recent probe rounds failed (mixed or isolated failures). */
	| 'degraded'
	/** Probes repeatedly time out while the path exists — FUSE likely hung. */
	| 'unresponsive'
	/** The configured path does not exist (wrong bind, mount not present). */
	| 'missing'
	/** The path exists but reads fail (EIO / permissions). */
	| 'read-error'
	/** No probe result yet. */
	| 'unknown';

/** What consumes a mount — used for honest "may be affected" correlation. */
export interface MountTarget {
	/** Stable id, e.g. `tv-symlinks`. */
	id: string;
	/** Display label, e.g. `TV symlink root`. */
	label: string;
	/** Absolute path *as visible from the DUMBscope container*. */
	path: string;
	/** `fuse` (debrid/rclone view), `symlink-root`, or `local`. */
	kind: 'fuse' | 'symlink-root' | 'local';
	/** Consumer names shown in findings, e.g. `Plex Media Server`. */
	consumers: string[];
}

/** Bounded symlink-sampling result for one probe round. */
export interface SymlinkSample {
	/** Number of links actually probed (hard-capped). */
	sampled: number;
	/** Target resolved and stat-able. */
	valid: number;
	/** Target missing (stale link). */
	broken: number;
	/** lstat/stat failed in a non-ENOENT way (permissions, I/O, timeout). */
	unreadable: number;
	/** How many filesystem entries the bounded listing saw (≤ cap). */
	entriesScanned: number;
	/** True when the listing hit its entry cap (sampling from a subset). */
	truncated: boolean;
}

/** Latest derived report for one monitored mount. */
export interface MountReport {
	target: MountTarget;
	state: MountHealth;
	/** Last stat latency in ms (null when the stat never succeeded). */
	statLatencyMs: number | null;
	/** Last bounded-listing latency in ms. */
	listLatencyMs: number | null;
	/** Consecutive failed probe rounds (timeout / IO error). */
	failedRounds: number;
	/** Consecutive healthy probe rounds (hysteresis input). */
	healthyRounds: number;
	symlink: SymlinkSample | null;
	lastProbeAt: number | null;
	/** Epoch ms of the last fully successful round. */
	lastSuccessAt: number | null;
	/** Plain-language detail of the most recent failure, if any. */
	lastError: string | null;
}

// ---------------------------------------------------------------------------
// Reliability — memory anomalies (FASE C)
// ---------------------------------------------------------------------------

export type MemoryAnomalyLevel = 'ok' | 'warning' | 'critical';

/** One process's memory picture as shown in the UI (drawer + cards). */
export interface ProcessMemoryView {
	process: string;
	/** Most recent sample. */
	currentBytes: number | null;
	/** Rolling median baseline (typical use) over the baseline window. */
	baselineBytes: number | null;
	delta1hBytes: number | null;
	delta6hBytes: number | null;
	/** Peak RSS within the retention window (up to 24h). */
	peak24hBytes: number | null;
	level: MemoryAnomalyLevel;
	/** Sample count backing the view (0 when history is still building). */
	samples: number;
	lastSampleAt: number | null;
}

/** Full reliability payload for the API/SSE and the System page. */
export interface ReliabilitySnapshot {
	mounts: MountReport[];
	/** Views for the most memory-heavy tracked processes, anomalies first. */
	memory: ProcessMemoryView[];
	stats: {
		/** Total mount probe rounds since process start. */
		mountRounds: number;
		/** Filesystem operations issued to probe workers since start. */
		fsCalls: number;
		/** Duration of the last full mount round (all targets) in ms. */
		lastRoundMs: number | null;
		/** Processes currently sampled for memory. */
		memoryTracked: number;
	};
}
