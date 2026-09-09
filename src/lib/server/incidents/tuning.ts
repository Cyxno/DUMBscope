/**
 * Tuning constants for the incident engine.
 *
 * The engine deliberately needs *sustained* bad signals before opening an
 * incident: a service that is unavailable for two seconds during normal
 * startup must never page anyone.
 */
export const INCIDENT_TUNING = {
	/** Consecutive unhealthy observations before an unhealthy incident opens. */
	unhealthyThreshold: 3,
	/** Consecutive degraded observations before a degraded incident opens. */
	degradedThreshold: 3,
	/** Consecutive healthy observations before an active incident resolves. */
	healthyResolveThreshold: 3,
	/** Grace period for a stopped service before it becomes an incident (ms). */
	stoppedGraceMs: 30_000,
	/** Grace before the gateway being unreachable becomes an incident (ms). */
	offlineGraceMs: 15_000,
	/** Gateway must be live this long before an offline incident resolves (ms). */
	offlineResolveMs: 30_000,
	/** Error log burst: N errors... */
	errorBurstCount: 6,
	/** ...within this window (ms) opens a log-error incident. */
	errorBurstWindowMs: 60_000,
	/** Disk usage percent that opens a warning / critical incident. */
	diskWarnPercent: 90,
	diskCriticalPercent: 95,
	/** Disk usage percent below which a disk incident resolves (hysteresis). */
	diskResolvePercent: 85,
	/** Metrics stream considered stale after this long without updates (ms). */
	metricsStaleMs: 90_000,
	/** Correlation window: dependency incidents within this range link up (ms). */
	correlationWindowMs: 120_000,
	/** Maximum evidence lines retained per incident. */
	maxEvidence: 10,
	/** Maximum timeline entries retained per incident. */
	maxTimeline: 100,
	/** Total incidents retained in history. */
	historyLimit: 500
} as const;
