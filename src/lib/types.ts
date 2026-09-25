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
	/** Thread count as reported by DUMB (null on older gateways). */
	threads?: number | null;
	/** Virtual memory size in bytes (null when the payload omits it). */
	vmsBytes?: number | null;
	/** Process start time (epoch seconds) — enables honest uptime. */
	startedAtSeconds?: number | null;
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
/**
 * Incident lifecycle states:
 * - `active`: open problem, detector still sees it, needs attention.
 * - `acknowledged`: an operator saw it — still a technically open problem
 *   (the detector keeps evaluating it), but visually muted.
 * - `resolved`: the detector positively confirmed recovery, or the safety net
 *   proved the finding obsolete (target/monitor/detector gone).
 * - `archived`: cleared from the working views by an operator; kept for
 *   history. A recurrence under the same fingerprint opens a NEW incident
 *   instead of un-archiving history.
 */
export type IncidentStatus = 'active' | 'acknowledged' | 'resolved' | 'archived';

/**
 * What a resolution actually means. `recovered` requires positive detector
 * evidence; `obsolete` covers "the thing this finding was about is gone"
 * (target removed, monitor disabled, detector unavailable) and must never be
 * presented as a technical recovery.
 */
export type IncidentResolutionKind = 'recovered' | 'obsolete' | 'operator';

export interface IncidentEvidence {
	at: number;
	source: 'status' | 'logs' | 'metrics' | 'connection' | 'integration' | 'reliability' | 'runtime';
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
	/** Owning detector ('status', 'mounts', 'media-flow', 'reconciliation', …). */
	detector: string;
	/** Last time the owning detector pass ran for this incident (even when the verdict was "no change"). */
	lastEvaluatedAt: number | null;
	/** Last time positive evidence of the problem was recorded. */
	lastEvidenceAt: number | null;
	acknowledgedAt: number | null;
	/** What a resolution means (null while open). */
	resolutionKind: IncidentResolutionKind | null;
	/** Short human reason recorded at resolution (also in the timeline). */
	resolutionReason: string | null;
	evidence: IncidentEvidence[];
	timeline: IncidentTimelineEntry[];
}

/** Aggregated incident counts for headers and badges. */
export interface IncidentCounts {
	active: number;
	acknowledged: number;
	resolved: number;
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
// Media state correlation (DEEL 2)
// ---------------------------------------------------------------------------

/**
 * Normalized acquisition-flow state for one media item, as observed at one
 * source. The raw per-source state is always kept (brief §13) — the derived
 * summary exists only for the UI and never erases provenance.
 */
export type MediaFlowState =
	| 'missing'
	| 'requested'
	| 'accepted'
	| 'queued'
	| 'downloading'
	| 'importing'
	| 'mounted'
	| 'available'
	| 'indexed'
	| 'failed'
	| 'unknown';

export type MediaSourceName =
	'sonarr' | 'radarr' | 'decypharr' | 'infinidysk' | 'filesystem' | 'plex';

export interface MediaSourceObservation {
	source: MediaSourceName;
	/** Namespaced stable key of the integration instance. */
	integrationId: string;
	state: MediaFlowState;
	observedAt: number;
	confidence: 'exact' | 'derived' | 'inferred';
	/** Plain-language evidence line, e.g. "grabbed 09:17 via SABnzbd". */
	evidence?: string | null;
}

/** One acquisition attempt tracked by its upstream request identity. */
export interface MediaAcquisition {
	/** Namespaced integration instance id (sonarr:<id> / radarr:<id>). */
	integrationId: string;
	/** Upstream download/request GUID — stable across polls. */
	requestId: string;
	mediaKey: string;
	title: string;
	/** Emulated client at the Arr boundary: SABnzbd = InfiniDysk path,
	 *  qBittorrent = Decypharr path. */
	client: string | null;
	firstSeen: number;
	lastObservedAt: number;
	acceptedAt: number | null;
	failedAt: number | null;
	completedAt: number | null;
	lastEvent: string | null;
}

/** UI summary of one item's cross-service flow. */
export interface MediaFlowItem {
	mediaKey: string;
	/** Best-effort display title (from the Arr missing list or history). */
	title: string;
	sourceType: 'sonarr' | 'radarr';
	integrationId: string;
	/** Arr-native id for deep links. */
	mediaId: number | null;
	observations: MediaSourceObservation[];
	/** UI-only derived summary (brief §14/§15). */
	summary: MediaFlowState | 'acquiring';
	/** Plain-language reason for the summary (evidence-based). */
	reason: string | null;
	/** Distinct acquisition requests observed for this item in the window. */
	acquisitions: number;
	lastGrabAt: number | null;
	lastImportAt: number | null;
	lastFailureAt: number | null;
	/** Classified root cause when a finding applies. */
	classification:
		| 'acquisition-in-progress'
		| 'state-propagation-delay'
		| 'mount-unavailable'
		| 'arr-import-delay'
		| 'repeated-request'
		| 'identity-mismatch'
		| 'stale-source-state'
		| 'unknown'
		| null;
}

export interface MediaFlowSnapshot {
	generatedAt: number;
	/** Recent flows worth attention (acquiring/repeats/mismatches), capped. */
	items: MediaFlowItem[];
	metrics: {
		repeatedRequests24h: number;
		activeMediaMismatches: number;
		resolvedMediaMismatches: number;
		/** Median + p95 of observed grab→import delay (ms), when enough cases. */
		propagation: { samples: number; medianMs: number | null; p95Ms: number | null };
	};
}

// ---------------------------------------------------------------------------
// Remediation (DEEL 2) — bounded, allowlisted, verification-first
// ---------------------------------------------------------------------------

export type RemediationActionState =
	| 'requested'
	| 'running'
	| 'verifying'
	| 'succeeded'
	| 'failed'
	| 'partially-recovered'
	| 'rejected';

/** A registered remediation action (allowlist — never arbitrary commands). */
export interface RemediationActionView {
	id: string;
	/** 'restart-managed-service' — the only action registered this phase. */
	kind: 'restart-managed-service';
	/** Resolved target: the managed DUMB process name. */
	target: string;
	/** Human reason shown in the recommendation. */
	reason: string | null;
	/** Evidence lines backing the recommendation. */
	evidence: string[];
	state: RemediationActionState;
	requestedAt: number | null;
	executedAt: number | null;
	verifiedAt: number | null;
	/** Verification detail: what was checked and what it found. */
	verification: string | null;
	/** Cooldown/attempt status for the target. */
	cooldownRemainingMs: number;
	attempts24h: number;
	attemptLimit: number;
	suspended: boolean;
	/** Findings fingerprint this action is linked to. */
	findingFingerprint: string | null;
}

export interface RemediationSnapshot {
	/** Recommendations (no execution yet) for eligible targets. */
	recommendations: RemediationActionView[];
	/** Recent executed/running actions (bounded). */
	recent: RemediationActionView[];
	/** True when automatic execution is configured (default: never this phase). */
	automaticEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Safe Actions / control plane (docs/ACTIONS.md)
// ---------------------------------------------------------------------------

export type IntegrationActionState =
	| 'requested' // audit row created, upstream request in flight
	| 'accepted' // upstream accepted the command (never "media found")
	| 'completed' // upstream reported the command completed
	| 'failed' // rejected upstream, or the command/transport failed
	| 'unconfirmed' // accepted, no final upstream state within the follow window
	| 'rejected'; // local rejection (allowlist, validation, cooldown, config)

/** One executed Safe Action — audit trail entry and activity item. */
export interface IntegrationActionView {
	id: string;
	/** Registry id, e.g. `sonarr.searchEpisode`. */
	action: string;
	/** Registry UI label, e.g. "Search again". */
	label: string;
	/** Exact integration instance the action ran against. */
	integrationId: string | null;
	/** Human-readable upstream target reference (ids only, no secrets). */
	target: string;
	actor: string;
	state: IntegrationActionState;
	message: string | null;
	upstreamCommandId: number | null;
	requestedAt: number;
	finishedAt: number | null;
	/** Remaining per-target cooldown for repeat actions. */
	cooldownRemainingMs: number;
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
	/**
	 * ENOENT, but this container cannot see the target's mount root (e.g. the
	 * rclone mount lives in the DUMB container's namespace), so the link could
	 * not be judged at all. Never counted as broken.
	 */
	unresolvable: number;
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

// ---------------------------------------------------------------------------
// Observability — DUMB stack deep monitoring
// ---------------------------------------------------------------------------

/** Deterministic per-service memory classification (Observability page). */
export type ServiceMemoryClass =
	| 'stable'
	| 'elevated-plateau'
	| 'workload-driven'
	| 'sawtooth'
	| 'possible-leak'
	| 'insufficient-history';

/** Deep per-service memory view (class, deltas, baselines, shift). */
export interface ServiceMemoryObservability {
	key: string;
	name: string;
	processName: string;
	/** Most recent RSS. */
	currentBytes: number | null;
	/** Rolling median over the trailing 24h (5-minute tier). */
	baseline24hBytes: number | null;
	/** p50/p95 over the trailing 24h. */
	p50Bytes: number | null;
	p95Bytes: number | null;
	/** Rolling median over days 2–7 of the 30-minute tier (lagged 7d baseline). */
	baseline7dBytes: number | null;
	delta1hBytes: number | null;
	delta6hBytes: number | null;
	delta24hBytes: number | null;
	/** Robust (Theil–Sen) growth rate over the trailing 24h in bytes/hour. */
	slopeBytesPerHour: number | null;
	slopeConfidence: number | null;
	classification: ServiceMemoryClass;
	/** Evidence lines backing the classification (plain language). */
	reasons: string[];
	/** Threads reported by DUMB (null when the payload omits them). */
	threads: number | null;
	/** Process uptime seconds derived from DUMB's start_time (null when unknown). */
	uptimeSeconds: number | null;
	version: string | null;
	/** Detected baseline shift, if any (§9 of the observability spec). */
	baselineShift: BaselineShift | null;
}

export interface BaselineShift {
	/** p50 before the shift (days-2..7 of the 30-minute tier). */
	fromBytes: number;
	/** p50 over the most recent 24h. */
	toBytes: number;
	/** toBytes / fromBytes − 1. */
	percent: number;
	/** Epoch ms of the first bucket that crossed the shift line. */
	startedAt: number | null;
	/** 'rising' keeps drifting up; 'plateau' shifted and stabilised. */
	direction: 'rising' | 'plateau' | 'declining';
}

export interface CgroupMemoryBreakdown {
	/** Applications + anon (the part that must be actively reclaimed). */
	applicationsBytes: number;
	/** Shared/tmpfs memory (charged to file, not reclaimable like cache). */
	sharedBytes: number;
	/** Reclaimable file page cache (file − shmem). */
	cacheBytes: number;
	/** Kernel allocations: slab (split into reclaimable below) + stack + sock + misc. */
	kernelBytes: number;
	slabReclaimableBytes: number;
	/** memory.current as reported by the kernel. */
	currentBytes: number | null;
}

/** Interpretation flags for the DUMB cgroup (never "high memory = problem"). */
export interface CgroupMemoryInterpretation {
	/** Soft-limit (memory.high) reclaim events since the previous sample. */
	softReclaimActive: boolean;
	/** Hard-limit (memory.max) events since the previous sample. */
	hardLimitHit: boolean;
	/** Genuine pressure: direct reclaim + refaulting under the soft limit. */
	pressure: boolean;
	/** OOM / OOM-kill counters moved since the previous sample. */
	oom: boolean;
	/** Cumulative counters for display (never rate-limit alerts on these). */
	events: {
		high: number | null;
		max: number | null;
		oom: number | null;
		oomKill: number | null;
	};
	/** Kernel pressure counters for display. */
	pgscanDirect: number | null;
	refaultFile: number | null;
}

export interface CgroupMemorySnapshot {
	/** Epoch ms of the sample; null when no source is available. */
	at: number | null;
	/** Which source produced the sample. */
	source: 'cgroupfs' | 'prometheus' | null;
	/** Unavailable ⇒ explain why (no mount, bad path, Prometheus unreachable). */
	unavailableReason: string | null;
	highBytes: number | null;
	maxBytes: number | null;
	breakdown: CgroupMemoryBreakdown;
	interpretation: CgroupMemoryInterpretation;
	/** memory.peak, when the kernel exposes it. */
	peakBytes: number | null;
}

export interface CgroupHistoryPoint {
	t: number;
	currentAvg: number | null;
	currentMax: number | null;
	anonAvg: number | null;
	fileAvg: number | null;
	kernelAvg: number | null;
}

/** Aggregated repair/article facts for one media file (InfiniDysk page). */
export interface InfiniDyskFileRecord {
	file: string;
	/** Repair starts within the trailing 1h/24h windows. */
	repairs1h: number;
	repairs24h: number;
	lastRepairAt: number | null;
	lastError: string | null;
	/** Distinct days (UTC) with at least one repair — recurrence signal. */
	activeDays: number;
	missingSegments24h: number;
}

export interface InfiniDyskObservability {
	available: boolean;
	unavailableReason: string | null;
	version: string | null;
	/** Base NZBDAV version when DUMB exposes it via the service env. */
	baseVersion: string | null;
	commit: string | null;
	/** .NET GC heap hard limit parsed from the service env (bytes). */
	gcHeapHardLimitBytes: number | null;
	autoUpdate: boolean | null;
	pinnedVersion: string | null;
	rss: number | null;
	threads: number | null;
	cpuPercent: number | null;
	uptimeSeconds: number | null;
	/** RSS growth over the trailing hour (bytes/hour, Theil–Sen). */
	growthBytesPerHour: number | null;
	/** Repair currently in flight (started within the quiet window). */
	repairActive: boolean;
	lastRepairAt: number | null;
	repairs1h: number;
	repairs24h: number;
	article430_1h: number;
	article430_24h: number;
	missingSegments1h: number;
	missingSegments24h: number;
	providerFallbacks24h: number;
	mountState: string | null;
	restarts24h: number;
	lastRestartAt: number | null;
	files: InfiniDyskFileRecord[];
}

export interface ThermalZoneSample {
	zone: string;
	type: string;
	tempC: number | null;
}

export interface ThermalSnapshot {
	available: boolean;
	unavailableReason: string | null;
	zones: ThermalZoneSample[];
	/** Hottest zone right now (the spike-detection input). */
	maxTempC: number | null;
	maxZoneType: string | null;
	/** Package temperature when an x86_pkg_temp zone exists. */
	packageTempC: number | null;
	/** Currently active spike level, if any. */
	spikeLevel: 90 | 95 | 100 | null;
	spikeSince: number | null;
	lastSpike: ThermalCorrelationSnapshot | null;
}

/** Correlation snapshot captured when a temperature threshold is crossed. */
export interface ThermalCorrelationSnapshot {
	at: number;
	level: 90 | 95 | 100;
	tempC: number;
	zoneType: string | null;
	hostLoad: number | null;
	dumbCpuPercent: number | null;
	topProcesses: { name: string; cpuPercent: number | null }[];
	infiniDyskRepairActive: boolean;
	recoveredAt: number | null;
}

export interface TimelineEvent {
	id: number;
	at: number;
	kind:
		| 'restart'
		| 'memory-anomaly'
		| 'repair-loop'
		| 'mount'
		| 'oom'
		| 'cgroup-high'
		| 'cgroup-max'
		| 'thermal'
		| 'deploy'
		| 'download-failure'
		| 'health';
	service: string | null;
	severity: 'info' | 'warning' | 'critical' | null;
	title: string;
	detail: string | null;
}

/** Download routing window aggregate for one client. */
export interface RoutingClientStats {
	client: string;
	/** 'usenet' | 'torrent' as the Arr download client reports it. */
	protocol: string | null;
	priority: number | null;
	enabled: boolean;
	grabs: number;
	imports: number;
	failures: number;
	/** imports / (imports + failures) over the window; null when no completions. */
	successRate: number | null;
	/** True when this client is the Arr-configured primary for its protocol. */
	primary: boolean;
}

export interface RoutingObservability {
	windowHours: number;
	clients: RoutingClientStats[];
	/** Preferred protocol from the Arr delay profile, per Arr. */
	preferredProtocol: { sonarr: string | null; radarr: string | null };
	fetchedAt: number | null;
	stale: boolean;
}

/** Per-Arr stack facts (Observability → Sonarr/Radarr). */
export interface ArrObservability {
	type: 'sonarr' | 'radarr';
	integrationId: string;
	connected: boolean;
	unavailableReason: string | null;
	version: string | null;
	uptimeSeconds: number | null;
	dbBytes: number | null;
	queue: number | null;
	queueWarnings: number | null;
	queueFailures: number | null;
	blocklistSize: number | null;
	historyEvents: number | null;
	imports24h: number;
	failures24h: number;
	grabs24h: number;
	/** RSS-sync and search activity (recent commands). */
	rssSync: { lastAt: number | null; count24h: number };
	searches: { count24h: number; recent: string[] };
	fetchedAt: number | null;
}

export interface ObservabilitySnapshot {
	cgroup: CgroupMemorySnapshot;
	services: ServiceMemoryObservability[];
	baselineShifts: ServiceMemoryObservability[];
	infiniDysk: InfiniDyskObservability;
	thermal: ThermalSnapshot;
	ars: ArrObservability[];
	routing: RoutingObservability;
	versions: VersionInfo[];
}

export interface VersionInfo {
	key: string;
	name: string;
	version: string | null;
	commit: string | null;
	/** Epoch ms when DUMB first reported this version (deploy marker). */
	since: number | null;
	updateAvailable: boolean | null;
	availableVersion: string | null;
	/** DUMB's own update-check verdict ('updated', 'update_available', …). */
	updateStatus: string | null;
	autoUpdate: boolean | null;
	/** Runtime is persistent/pinned — it does not move with DUMB:latest. */
	pinned: boolean;
}
