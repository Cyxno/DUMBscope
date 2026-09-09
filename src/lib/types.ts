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

export type ConnectionState =
	| 'connecting'
	| 'live'
	| 'reconnecting'
	| 'stale'
	| 'offline'
	| 'unconfigured'
	| 'credentials-invalid';

export interface ConnectionSnapshot {
	state: ConnectionState;
	streams: Record<StreamName, ConnectionState>;
	lastUpdateAt: number | null;
	lastError: string | null;
	reconnectAttempts: number;
	dumbVersion: string | null;
	authMode: 'none' | 'local' | 'oidc' | 'hybrid' | 'unknown';
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export type IncidentSeverity = 'info' | 'warning' | 'critical';
export type IncidentStatus = 'active' | 'resolved';

export interface IncidentEvidence {
	at: number;
	source: 'status' | 'logs' | 'metrics' | 'connection';
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
