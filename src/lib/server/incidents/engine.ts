/**
 * The incident engine: turns raw telemetry into deduplicated, correlated,
 * persistent incidents.
 *
 * Design rules:
 * - Signals need sustained confirmation (thresholds/grace periods) before an
 *   incident opens — no flapping.
 * - Identical failures share a fingerprint and bump `occurrences` instead of
 *   creating new rows.
 * - Incidents affecting services whose *dependency* also has an active
 *   incident are marked as consequences of that root cause.
 */
import type {
	ConnectionSnapshot,
	HealthStatus,
	Incident,
	IncidentResolutionKind,
	IncidentSeverity,
	LogLine,
	MetricsSnapshot,
	MountReport,
	ServiceStatus
} from '$lib/types';
import type { TopologyGraph } from '$lib/types';
import type { MemoryAssessment } from '../reliability/memory';
import { Fingerprints, fingerprint } from './fingerprint';
import { incidentRepository, newIncidentId } from './repository';
import { INCIDENT_TUNING as TUNING } from './tuning';
import { MOUNT_TUNING } from '../reliability/mounts';
import { serviceKeyFromName } from '../dumb/normalize';

/**
 * The detector that owns an incident's lifecycle, derived from its fingerprint
 * prefix. The stale-incident safety net uses this to decide whether an open
 * incident is still evaluable; the engine records it on every row.
 */
export function detectorForFingerprint(fp: string): string {
	if (fp.startsWith('svc-unhealthy:') || fp.startsWith('svc-degraded:')) return 'status.health';
	if (fp.startsWith('svc-stopped:')) return 'status.stopped';
	if (fp.startsWith('svc-restart-failures:')) return 'status.restart';
	if (fp.startsWith('svc-log-errors:')) return 'logs.errors';
	if (fp.startsWith('db-health:')) return 'metrics.database';
	if (fp.startsWith('disk-usage:')) return 'metrics.disk';
	if (fp.startsWith('dumb-offline:') || fp.startsWith('dumb-credentials:')) return 'connection';
	if (fp.startsWith('telemetry-stale:')) return 'connection.telemetry';
	if (fp.startsWith('integration-down:')) return 'integration';
	if (fp.startsWith('mount:')) return 'mounts';
	if (fp.startsWith('symlinks:')) return 'mounts.symlinks';
	if (fp.startsWith('memory:')) return 'memory';
	if (fp.startsWith('media-')) return 'media-flow';
	if (fp.startsWith('recon:')) return 'reconciliation';
	if (fp.startsWith('self:')) return 'runtime';
	if (fp.startsWith('restart-storm:')) return 'anomaly.restart';
	if (fp.startsWith('disk-trend:')) return 'anomaly.disk-trend';
	return 'legacy';
}

interface OpenState {
	/** Open (or pending-open) incident keyed by fingerprint. */
	byFingerprint: Map<string, Incident>;
	/** Affected entity (service key / path / integration id / media key) per fingerprint. */
	identityByFingerprint: Map<string, string>;
	/** Trackers for signals that have not yet crossed their threshold. */
	unhealthyStreak: Map<string, { count: number; since: number; lastReason: string | null }>;
	degradedStreak: Map<string, { count: number; since: number }>;
	healthyStreak: Map<string, number>;
	stoppedSince: Map<string, number>;
	errorBurst: Map<string, number[]>;
	offlineSince: number | null;
	liveSince: number | null;
	metricsStaleSince: number | null;
	diskAboveSince: Map<string, number>;
	restartFailures: Map<string, number>;
	/** Healthy rounds per mount, gating finding resolution (hysteresis). */
	mountHealthyRounds: Map<string, number>;
	/** Rounds since the systemic symlink signal last held, per mount. */
	symlinkCleanRounds: Map<string, number>;
	/**
	 * Identities (fs path / process name) with an open metrics-scoped incident
	 * that were ABSENT from the latest metrics snapshot: absent since when.
	 * Absence alone never resolves — it resolves only after metrics stayed
	 * otherwise fresh for the full window (identity gone from DUMB, not a
	 * telemetry hiccup).
	 */
	metricsAbsentSince: Map<string, number>;
}

export interface EngineEvents {
	/** Called for every created/updated/resolved incident (for SSE fanout). */
	onIncidentChange?: (incident: Incident, action: 'opened' | 'updated' | 'resolved') => void;
}

export class IncidentEngine {
	private state: OpenState = freshState();

	/**
	 * Mount path → consumer service keys, refreshed by the hub whenever mount
	 * targets change. Dependency evidence for correlation only — never used to
	 * open incidents.
	 */
	private mountConsumerIndex: Map<string, string[]> | null = null;

	/** Provide the mount path → consumers index (hub call, may be null). */
	setMountConsumerIndex(index: Map<string, string[]> | null): void {
		this.mountConsumerIndex = index;
	}

	constructor(
		private readonly events: EngineEvents = {},
		private readonly nowFn: () => number = Date.now
	) {}

	/** Re-arm the engine (tests / config reload). Reopens DB incidents on boot. */
	reset(): void {
		this.state = freshState();
	}

	/**
	 * Load persisted open incidents (active + acknowledged) into state after a
	 * restart. Without this, an incident that was active when the process died
	 * can never resolve again: resolution only touches incidents in memory, so
	 * the row stays 'active' forever (production audit 2026-09-10). Hydrated
	 * incidents resolve naturally once their condition clears.
	 *
	 * Hydration also rebuilds the detector bookkeeping an in-memory engine
	 * would have had: affected identities (for the safety net) and an error
	 * window seed per hydrated log-error incident, so "error rate returned to
	 * normal" stays reachable after a restart instead of the incident becoming
	 * unresolvable.
	 */
	hydrate(): void {
		for (const incident of incidentRepository.open()) {
			const existing = this.state.byFingerprint.get(incident.fingerprint);
			if (existing) continue;
			this.state.byFingerprint.set(incident.fingerprint, incident);
			const identity = incident.affectedServices[0];
			if (identity) this.state.identityByFingerprint.set(incident.fingerprint, identity);
			// Post-restart verification seed for log-error incidents: one clean
			// window after boot resolves them (the detector watched and no
			// errors arrived). Without the seed the burst map is empty and the
			// sweep can never consider the incident again.
			if (incident.fingerprint.startsWith('svc-log-errors:') && identity) {
				this.state.errorBurst.set(identity, [this.nowFn()]);
			}
		}
	}

	/**
	 * Open incidents (active + acknowledged): acknowledged problems are still
	 * technically open and keep participating in evaluation, correlation and
	 * resolution — they are only muted for the operator.
	 */
	getActive(): Incident[] {
		return [...this.state.byFingerprint.values()].filter(
			(i) => i.status === 'active' || i.status === 'acknowledged'
		);
	}

	/** Open incident fingerprints whose prefix matches one of `prefixes`. */
	openFingerprints(prefixes: string[]): string[] {
		return [...this.state.byFingerprint.values()]
			.filter((i) => prefixes.some((p) => i.fingerprint.startsWith(p)))
			.map((i) => i.fingerprint);
	}

	/** Affected identity recorded for an open incident (path, process, id, media key). */
	identityOf(fp: string): string | null {
		return this.state.identityByFingerprint.get(fp) ?? null;
	}

	/**
	 * Stamp `lastEvaluatedAt` on open incidents of the given detectors: proof
	 * the owning detector ran and had the chance to change its verdict.
	 * Writes are throttled per incident; stamps never emit SSE events.
	 */
	stampEvaluated(prefixes: string[], now: number): void {
		for (const incident of this.state.byFingerprint.values()) {
			if (!prefixes.some((p) => incident.fingerprint.startsWith(p))) continue;
			if (incident.lastEvaluatedAt !== null && now - incident.lastEvaluatedAt < 60_000) continue;
			incident.lastEvaluatedAt = now;
			incidentRepository.update(incident);
		}
	}

	/**
	 * Resolve open incidents matching `predicate` with an explicit `obsolete`
	 * resolution. Used by the stale-incident safety net: the finding's origin
	 * (target/monitor/integration) is provably gone — this is NOT a recovery.
	 * Returns the number of resolved incidents.
	 */
	resolveWhere(
		predicate: (incident: Incident) => boolean,
		reasonFor: (incident: Incident) => string,
		now: number
	): number {
		let count = 0;
		for (const incident of [...this.state.byFingerprint.values()]) {
			if (incident.status !== 'active' && incident.status !== 'acknowledged') continue;
			if (!predicate(incident)) continue;
			this.resolveIfActive(incident.fingerprint, now, reasonFor(incident), 'obsolete');
			count++;
		}
		return count;
	}

	// -------------------------------------------------------------------------
	// Status stream
	// -------------------------------------------------------------------------

	onStatus(
		previous: ReadonlyMap<string, ServiceStatus>,
		next: ReadonlyMap<string, ServiceStatus>
	): void {
		const now = this.nowFn();
		for (const status of next.values()) {
			if (!status.enabled) continue;
			const prev = previous.get(status.key);
			this.trackTransitions(status, prev?.health ?? null, now);
			this.evaluateHealth(status, now);
			this.evaluateRestart(status, now);
		}
	}

	private trackTransitions(status: ServiceStatus, from: HealthStatus | null, now: number): void {
		// Health transitions are activity-feed material; the hub records them.
		void status;
		void from;
		void now;
	}

	private evaluateHealth(status: ServiceStatus, now: number): void {
		const key = status.key;
		const unhealthy = this.state.unhealthyStreak.get(key);
		const degraded = this.state.degradedStreak.get(key);
		const healthyStreak = this.state.healthyStreak.get(key) ?? 0;

		if (status.health === 'unhealthy') {
			this.state.healthyStreak.delete(key);
			const streak = unhealthy ?? { count: 0, since: now, lastReason: status.healthReason };
			streak.count += 1;
			streak.lastReason = status.healthReason ?? streak.lastReason;
			this.state.unhealthyStreak.set(key, streak);
			if (streak.count === TUNING.unhealthyThreshold) {
				this.openIncident({
					fingerprint: Fingerprints.serviceUnhealthy(key),
					severity: 'critical',
					title: `${status.name} is unhealthy`,
					summary: status.healthReason ?? 'DUMB reports the service as unhealthy',
					service: key,
					evidenceMessage: `health_status=unhealthy${status.healthReason ? ` (${status.healthReason})` : ''}`,
					source: 'status'
				});
			} else if (streak.count > TUNING.unhealthyThreshold) {
				this.touchIncident(Fingerprints.serviceUnhealthy(key), now);
			}
		} else {
			this.state.unhealthyStreak.delete(key);
		}

		if (status.health === 'degraded') {
			this.state.healthyStreak.delete(key);
			const streak = degraded ?? { count: 0, since: now };
			streak.count += 1;
			this.state.degradedStreak.set(key, streak);
			if (streak.count === TUNING.degradedThreshold) {
				this.openIncident({
					fingerprint: Fingerprints.serviceDegraded(key),
					severity: 'warning',
					title: `${status.name} is degraded`,
					summary: status.healthReason ?? 'DUMB reports the service as degraded',
					service: key,
					evidenceMessage: `health_status=degraded${status.healthReason ? ` (${status.healthReason})` : ''}`,
					source: 'status'
				});
			} else if (streak.count > TUNING.degradedThreshold) {
				this.touchIncident(Fingerprints.serviceDegraded(key), now);
			}
		} else {
			this.state.degradedStreak.delete(key);
		}

		if (status.health === 'healthy') {
			this.state.healthyStreak.set(key, healthyStreak + 1);
		} else {
			this.state.healthyStreak.delete(key);
		}

		// Resolve health incidents once the service has been healthy for a bit.
		if ((this.state.healthyStreak.get(key) ?? 0) >= TUNING.healthyResolveThreshold) {
			this.resolveIfActive(
				Fingerprints.serviceUnhealthy(key),
				now,
				`${status.name} is healthy again`
			);
			this.resolveIfActive(Fingerprints.serviceDegraded(key), now, `${status.name} recovered`);
		}

		// Stopped services (enabled only) after a grace period.
		if (status.runState === 'stopped') {
			const since = this.state.stoppedSince.get(key) ?? now;
			this.state.stoppedSince.set(key, since);
			if (now - since >= TUNING.stoppedGraceMs) {
				this.openIncident({
					fingerprint: Fingerprints.serviceStopped(key),
					severity: 'warning',
					title: `${status.name} is stopped`,
					summary: 'The service is enabled in DUMB but not running',
					service: key,
					evidenceMessage: 'status=stopped',
					source: 'status'
				});
			}
		} else if (status.runState === 'running') {
			this.state.stoppedSince.delete(key);
			// Reconcile incidents opened under the pre-discovery slug key: the
			// same service can be evaluated under `dumb-frontend` (slug) and
			// `dumb frontend` (discovered config_key) during its lifetime.
			this.resolveIfActive(
				Fingerprints.serviceStopped(serviceKeyFromName(status.processName)),
				now,
				'Resolved after corrected service-state reconciliation'
			);
			this.resolveIfActive(
				Fingerprints.serviceStopped(key),
				now,
				`${status.name} is running again`
			);
		}
	}

	private evaluateRestart(status: ServiceStatus, now: number): void {
		if (!status.restart) return;
		const prevFailures = this.state.restartFailures.get(status.key) ?? 0;
		if (status.restart.failures > prevFailures) {
			this.state.restartFailures.set(status.key, status.restart.failures);
			const reason = status.restart.lastFailureReason ?? 'restart loop detected';
			this.openIncident({
				fingerprint: Fingerprints.restartFailures(status.key),
				severity: 'critical',
				title: `${status.name} keeps restarting`,
				summary: reason,
				service: status.key,
				evidenceMessage: `restart failures: ${prevFailures} → ${status.restart.failures}${reason !== 'restart loop detected' ? ` (${reason})` : ''}`,
				source: 'status'
			});
		} else {
			this.state.restartFailures.set(status.key, status.restart.failures);
		}
		if (status.restart.failures === 0 && prevFailures > 0) {
			this.resolveIfActive(
				Fingerprints.restartFailures(status.key),
				now,
				`${status.name} restart loop ended`
			);
		}
	}

	// -------------------------------------------------------------------------
	// Logs
	// -------------------------------------------------------------------------

	onLogLine(line: LogLine): void {
		if (line.level !== 'error' || !line.process) return;
		const key = line.process;
		const window = this.state.errorBurst.get(key) ?? [];
		const now = line.receivedAt;
		window.push(now);
		while (window.length > 0 && now - window[0]! > TUNING.errorBurstWindowMs) window.shift();
		this.state.errorBurst.set(key, window);
		if (window.length === TUNING.errorBurstCount) {
			this.openIncident({
				fingerprint: Fingerprints.logErrors(key),
				severity: 'warning',
				title: `${key} is logging repeated errors`,
				summary: `${window.length} error lines within ${Math.round(TUNING.errorBurstWindowMs / 1000)}s`,
				service: key,
				evidenceMessage: line.message.slice(0, 300),
				source: 'logs'
			});
		} else if (window.length > TUNING.errorBurstCount) {
			this.touchIncident(Fingerprints.logErrors(key), now);
			this.addEvidence(Fingerprints.logErrors(key), {
				at: now,
				source: 'logs',
				message: line.message.slice(0, 300)
			});
		}
	}

	/** A window with no recent errors lets the log-error incident resolve. */
	sweepErrorBursts(now = Date.now()): void {
		for (const [key, window] of this.state.errorBurst) {
			const recent = window.filter((t) => now - t <= TUNING.errorBurstWindowMs);
			if (recent.length === 0) {
				this.state.errorBurst.delete(key);
				this.resolveIfActive(
					Fingerprints.logErrors(key),
					now,
					`${key} error rate returned to normal`
				);
			} else {
				this.state.errorBurst.set(key, recent);
			}
		}
	}

	// -------------------------------------------------------------------------
	// Metrics
	// -------------------------------------------------------------------------

	onMetrics(snapshot: MetricsSnapshot): void {
		const now = this.nowFn();
		this.state.metricsStaleSince = null;
		this.resolveIfActive(Fingerprints.telemetryStale(), now, 'Metrics are updating again');

		/** Absence sweeps: identities with an open metrics-scoped incident that
		 *  are missing from the current snapshot. A metrics frame just arrived,
		 *  so the picture is fresh — an identity still absent after the window
		 *  is gone from DUMB's view (unmounted fs, removed process), and its
		 *  finding becomes obsolete. This is not a recovery and never claims one. */
		const reportedFs = new Set(snapshot.filesystems.map((f) => f.path));
		const reportedProcesses = new Set(snapshot.processes.map((p) => p.name));
		const absentSweep = (
			prefix: string,
			reported: Set<string>,
			reason: (identity: string) => string
		): void => {
			for (const incident of [...this.state.byFingerprint.values()]) {
				if (!incident.fingerprint.startsWith(prefix)) continue;
				if (incident.status !== 'active' && incident.status !== 'acknowledged') continue;
				const identity = this.state.identityByFingerprint.get(incident.fingerprint);
				if (identity === undefined) continue; // legacy row: detector may still re-adopt it
				if (reported.has(identity)) {
					this.state.metricsAbsentSince.delete(incident.fingerprint);
					continue;
				}
				const since = this.state.metricsAbsentSince.get(incident.fingerprint) ?? now;
				this.state.metricsAbsentSince.set(incident.fingerprint, since);
				if (now - since >= TUNING.identityAbsentResolveMs) {
					this.resolveIfActive(incident.fingerprint, now, reason(identity), 'obsolete');
					this.state.metricsAbsentSince.delete(incident.fingerprint);
				}
			}
		};
		absentSweep(
			'disk-usage:',
			reportedFs,
			(identity) => `Filesystem ${identity} is no longer reported by DUMB metrics`
		);
		absentSweep(
			'db-health:',
			reportedProcesses,
			(identity) => `Process ${identity} is no longer reported by DUMB metrics`
		);
		absentSweep(
			'memory:',
			reportedProcesses,
			(identity) => `Process ${identity} is no longer reported by DUMB metrics`
		);

		for (const fs of snapshot.filesystems) {
			const above = this.state.diskAboveSince.get(fs.path) ?? null;
			const over = fs.percent >= TUNING.diskWarnPercent;
			if (over && above === null) {
				this.state.diskAboveSince.set(fs.path, now);
			}
			if (!over) {
				this.state.diskAboveSince.delete(fs.path);
				if (fs.percent < TUNING.diskResolvePercent) {
					this.resolveIfActive(
						Fingerprints.diskUsage(fs.path),
						now,
						`Disk usage on ${fs.path} back to ${fs.percent.toFixed(1)}%`
					);
				}
				continue;
			}
			const sustained = now - (above ?? now);
			if (sustained < 30_000) continue;
			const critical = fs.percent >= TUNING.diskCriticalPercent;
			this.openIncident({
				fingerprint: Fingerprints.diskUsage(fs.path),
				severity: critical ? 'critical' : 'warning',
				title: `Disk usage high on ${fs.path}`,
				summary: `${fs.percent.toFixed(1)}% used (${formatBytes(fs.usedBytes)} of ${formatBytes(fs.totalBytes)})`,
				service: null,
				identity: fs.path,
				evidenceMessage: `${fs.path}: ${fs.percent.toFixed(1)}% used${fs.inodePercent !== null ? `, inodes ${fs.inodePercent.toFixed(1)}%` : ''}`,
				source: 'metrics',
				refreshSummary: !critical
			});
		}

		for (const db of snapshot.databaseHealth) {
			if (db.healthy === false) {
				this.openIncident({
					fingerprint: Fingerprints.databaseHealth(db.processName),
					severity: 'critical',
					title: `${db.processName} database is unhealthy`,
					summary: db.reason ?? 'DUMB reports the database health probe failing',
					service: db.processName,
					evidenceMessage: db.reason ?? 'database_health: unhealthy',
					source: 'metrics'
				});
			} else if (db.healthy === true) {
				this.resolveIfActive(
					Fingerprints.databaseHealth(db.processName),
					now,
					`${db.processName} database is healthy again`
				);
			}
		}
	}

	/**
	 * Deep-integration health (brief §17/§32): a failing integration opens a
	 * *warning* incident and never touches the stack-health headline — the
	 * underlying service health still comes from DUMB.
	 */
	onIntegrations(statuses: { id: string; failures: number }[]): void {
		const now = this.nowFn();
		this.stampEvaluated(['integration-down:'], now);
		for (const s of statuses) {
			if (s.failures >= TUNING.integrationFailureThreshold) {
				this.openIncident({
					fingerprint: Fingerprints.integrationDown(s.id),
					severity: 'warning',
					title: `${s.id} deep monitoring failing`,
					summary: 'Repeated integration failures. Generic DUMB monitoring is unaffected.',
					service: null,
					identity: s.id,
					evidenceMessage: `${s.failures} consecutive failed polls`,
					source: 'integration',
					refreshSummary: true
				});
			} else {
				this.resolveIfActive(
					Fingerprints.integrationDown(s.id),
					now,
					'Integration is polling successfully again'
				);
			}
		}
	}

	/** Called periodically by the hub to detect a stalled metrics stream. */
	/**
	 * Discovery reconciliation: incidents for processes outside DUMB's managed
	 * registry describe services that no longer exist (ephemeral helpers,
	 * removed services, renamed instances). Resolution here is explicitly
	 * "obsolete — the monitored target is gone", never a recovery. Covers all
	 * service-bound detectors; before this sweep only covered stopped
	 * incidents, unhealthy/degraded/restart findings stayed open forever after
	 * their service disappeared from DUMB.
	 */
	reconcileRegistryStops(managedProcessNames: ReadonlySet<string>): void {
		const now = this.nowFn();
		if (managedProcessNames.size === 0) return; // registry unknown: cannot judge
		const managedKeys = new Set<string>();
		for (const name of managedProcessNames) {
			managedKeys.add(name);
			managedKeys.add(serviceKeyFromName(name));
		}
		const isManaged = (incident: Incident): boolean => {
			const identity = this.state.identityByFingerprint.get(incident.fingerprint);
			if (identity !== undefined) return managedKeys.has(identity);
			// Legacy rows without a stored identity: fall back to the embedded
			// service key, then the title ("&lt;name&gt; is stopped" et al).
			const first = incident.affectedServices[0];
			if (first && managedKeys.has(first)) return true;
			const titleName = /^(.*) (is|keeps|database is)/.exec(incident.title)?.[1];
			return titleName !== undefined && managedKeys.has(titleName);
		};
		this.resolveWhere(
			(incident) =>
				(incident.fingerprint.startsWith('svc-') ||
					incident.fingerprint.startsWith('db-health:')) &&
				!isManaged(incident),
			() => 'Resolved: process is not part of the managed registry',
			now
		);
	}

	onTick(lastMetricsAt: number | null, statusLive: boolean): void {
		const now = this.nowFn();
		if (statusLive && lastMetricsAt !== null && now - lastMetricsAt > TUNING.metricsStaleMs) {
			if (this.state.metricsStaleSince === null) this.state.metricsStaleSince = now;
			this.openIncident({
				fingerprint: Fingerprints.telemetryStale(),
				severity: 'info',
				title: 'Metrics telemetry is stale',
				summary: 'No metrics updates received from DUMB for over a minute',
				service: null,
				evidenceMessage: `last metrics update ${Math.round((now - lastMetricsAt) / 1000)}s ago`,
				source: 'connection',
				refreshSummary: true
			});
		}
		this.sweepErrorBursts(now);
	}

	// -------------------------------------------------------------------------
	// Connection
	// -------------------------------------------------------------------------

	onConnection(snapshot: ConnectionSnapshot): void {
		const now = this.nowFn();
		// Amber states (starting/connecting/reconnecting/degraded/stale) are
		// honest partial states reported in the UI — they must never page
		// anyone (brief §12/§139). Only the tracker's derived `offline` (grace
		// windows expired, probes failing) and a hard auth rejection open
		// connectivity incidents.
		const unreachable = snapshot.state === 'offline' || snapshot.state === 'credentials-invalid';

		if (snapshot.state === 'live') {
			this.state.liveSince ??= now;
			this.state.offlineSince = null;
			if (now - this.state.liveSince >= TUNING.offlineResolveMs) {
				this.resolveIfActive(Fingerprints.dumbOffline(), now, 'DUMB connection restored');
				this.resolveIfActive(Fingerprints.telemetryStale(), now, 'Telemetry is flowing again');
			}
			this.resolveIfActive(Fingerprints.dumbCredentials(), now, 'DUMB credentials accepted');
			return;
		}

		this.state.liveSince = null;
		if (!unreachable) return; // amber: debounce, no incident.

		if (snapshot.state === 'credentials-invalid') {
			this.openIncident({
				fingerprint: Fingerprints.dumbCredentials(),
				severity: 'warning',
				title: 'DUMB credentials rejected',
				summary: 'Update the DUMB credentials in Settings to restore monitoring',
				service: null,
				evidenceMessage: snapshot.lastError ?? 'authentication failed',
				source: 'connection',
				refreshSummary: true
			});
			return;
		}

		this.state.offlineSince ??= now;
		if (now - this.state.offlineSince >= TUNING.offlineGraceMs) {
			const lastContact = snapshot.lastSuccessAt
				? `Last successful contact ${Math.round((now - snapshot.lastSuccessAt) / 1000)}s ago.`
				: 'No successful contact this session.';
			this.openIncident({
				fingerprint: Fingerprints.dumbOffline(),
				severity: 'critical',
				title: 'DUMB gateway unreachable',
				summary: `No connection to the DUMB gateway since ${new Date(this.state.offlineSince).toLocaleTimeString()} — ${lastContact}`,
				service: null,
				evidenceMessage: snapshot.probes.http.detail ?? snapshot.lastError ?? 'connection offline',
				source: 'connection',
				refreshSummary: true
			});
		}
	}

	// -------------------------------------------------------------------------
	// Generic findings API (DEEL 2): media-state findings reuse the exact same
	// lifecycle — dedupe by fingerprint, resolve with hysteresis, occurrences
	// for flap history. No second engine (brief §25).
	// -------------------------------------------------------------------------

	/** Report one finding (opens/refreshes by fingerprint). */
	reportFinding(input: {
		fingerprint: string;
		severity: IncidentSeverity;
		title: string;
		summary: string;
		evidence: string;
		refreshSummary?: boolean;
		/** Affected entity (media key, integration id, …) for lifecycle sweeps. */
		identity?: string;
	}): void {
		this.openIncident({
			fingerprint: input.fingerprint,
			severity: input.severity,
			title: input.title,
			summary: input.summary,
			service: null,
			identity: input.identity,
			evidenceMessage: input.evidence,
			source: 'reliability',
			refreshSummary: input.refreshSummary ?? true
		});
	}

	/** Resolve one finding if active (message recorded in the timeline). */
	resolveFinding(fingerprint: string, message: string): void {
		this.resolveIfActive(fingerprint, this.nowFn(), message);
	}

	// -------------------------------------------------------------------------
	// Reliability findings — mounts (FASE B) and memory (FASE C)
	//
	// These follow the same rules as every other incident: dedupe by
	// fingerprint, open only on sustained evidence, resolve with hysteresis.
	// There is no second findings engine — the incident layer *is* the findings
	// model (brief §25): fingerprint = category+identity, severity, evidence,
	// firstSeen/lastSeen, status, occurrences for flap history.
	// -------------------------------------------------------------------------

	/**
	 * One mount probe round. `unresponsive`/`read-error` are critical
	 * findings, `missing` a warning; resolution requires several consecutive
	 * healthy rounds (MOUNT_TUNING.healthyRoundsForRecovery). Correlation copy
	 * ("storage mount appears unhealthy", consumers "may be affected") comes
	 * from the report itself and stays honest — consumers are never opened an
	 * incident of their own.
	 */
	onMountHealth(reports: MountReport[]): void {
		const now = this.nowFn();
		this.stampEvaluated(['mount:', 'symlinks:'], now);
		for (const report of reports) {
			const path = report.target.path;
			const fp = Fingerprints.mountUnhealthy(path);
			const down = report.state === 'unresponsive' || report.state === 'read-error';
			const missing = report.state === 'missing';
			const degraded = report.state === 'degraded';

			if (down || missing || degraded) {
				const severity: IncidentSeverity = down ? 'critical' : 'warning';
				const stateLabel = report.state;
				const consumerNote =
					report.target.consumers.length > 0
						? ` May be affected: ${report.target.consumers.join(', ')}.`
						: '';
				const storageNote = report.lastError?.includes('storage mount appears unhealthy')
					? ' The storage service reports running, so the storage mount itself appears unhealthy.'
					: '';
				this.openIncident({
					fingerprint: fp,
					severity,
					title: `${report.target.label}: ${stateLabel}`,
					summary:
						(stateLabel === 'unresponsive'
							? `Storage mount is not answering probes${storageNote}`
							: stateLabel === 'read-error'
								? `Storage mount exists but reads fail${storageNote}`
								: stateLabel === 'missing'
									? 'Configured mount path does not exist inside the DUMBscope container'
									: 'Storage mount is answering intermittently') + consumerNote,
					service: null,
					identity: path,
					evidenceMessage:
						(report.lastError ?? `state=${stateLabel}`) +
						(report.statLatencyMs !== null ? `, stat ${Math.round(report.statLatencyMs)}ms` : '') +
						` (${report.failedRounds} failed probe round${report.failedRounds === 1 ? '' : 's'})`,
					source: 'reliability',
					refreshSummary: true
				});
				this.state.mountHealthyRounds.delete(path);
				continue;
			}

			if (report.state === 'healthy' || report.state === 'slow') {
				const healthy = (this.state.mountHealthyRounds.get(path) ?? 0) + 1;
				this.state.mountHealthyRounds.set(path, healthy);
				if (healthy >= MOUNT_TUNING.healthyRoundsForRecovery) {
					this.resolveIfActive(
						fp,
						now,
						`Mount is answering again (${Math.round(report.statLatencyMs ?? 0)}ms stat latency)`
					);
				}
			}
			if (report.state === 'unknown') continue;

			// Systemic symlink signal only (brief §23): a couple of stale links
			// is noise; a strongly broken sample is the rclone/debrid target
			// being gone.
			const symlinkFp = Fingerprints.symlinksBroken(path);
			const sample = report.symlink;
			const systemic =
				sample !== null &&
				sample.sampled >= MOUNT_TUNING.systemicMinSample &&
				sample.broken / sample.sampled >= MOUNT_TUNING.systemicBrokenRatio;
			if (systemic && sample) {
				this.state.symlinkCleanRounds.delete(path);
				this.openIncident({
					fingerprint: symlinkFp,
					severity: 'warning',
					title: `${report.target.label}: most sampled symlinks are broken`,
					summary: `${sample.broken} of ${sample.sampled} sampled links point at missing targets — the storage behind this root looks unavailable.${report.target.consumers.length > 0 ? ` May be affected: ${report.target.consumers.join(', ')}.` : ''}`,
					service: null,
					identity: path,
					evidenceMessage: `sampled=${sample.sampled} valid=${sample.valid} broken=${sample.broken} unreadable=${sample.unreadable}`,
					source: 'reliability',
					refreshSummary: true
				});
			} else {
				// Recovery evidence: any real sample below the systemic broken
				// ratio counts as a clean round — including samples below the
				// systemic minimum (a restructured library legitimately samples
				// fewer links; requiring ≥ systemicMinSample here used to make
				// resolved recovery unreachable and left findings open forever).
				const withinBounds =
					sample === null ||
					sample.sampled === 0 ||
					sample.broken / sample.sampled < MOUNT_TUNING.systemicBrokenRatio;
				if (withinBounds) {
					const clean = (this.state.symlinkCleanRounds.get(path) ?? 0) + 1;
					this.state.symlinkCleanRounds.set(path, clean);
					if (clean >= MOUNT_TUNING.healthyRoundsForRecovery) {
						this.resolveIfActive(
							symlinkFp,
							now,
							sample === null || sample.broken === 0
								? 'Sampled symlinks resolve again'
								: `Symlink integrity back within bounds (${sample.broken}/${sample.sampled} broken)`
						);
					}
				}
			}
		}
	}

	/**
	 * One memory detection pass (FASE C). The tracker owns thresholds,
	 * persistence and hysteresis; the engine only translates the assessment
	 * into the finding lifecycle. A single summary carries the UI line:
	 * "<process> memory use is unusually high — 4.2 GB · +1.8 GB over 6h".
	 */
	onMemory(assessmentToApply: MemoryAssessment): void {
		const now = this.nowFn();
		const fp = Fingerprints.memoryAnomaly(assessmentToApply.process);
		if (assessmentToApply.level === 'ok') {
			this.resolveIfActive(
				fp,
				now,
				`${assessmentToApply.process} memory returned to typical levels (${formatGb(assessmentToApply.currentBytes)})`
			);
			return;
		}
		const typical =
			assessmentToApply.baselineBytes !== null
				? ` · typical ${formatGb(assessmentToApply.baselineBytes)}`
				: '';
		const delta =
			assessmentToApply.delta6hBytes !== null
				? ` · ${assessmentToApply.delta6hBytes >= 0 ? '+' : '−'}${formatGb(Math.abs(assessmentToApply.delta6hBytes))} over 6h`
				: '';
		const evidence = [
			`rss=${formatGb(assessmentToApply.currentBytes)}`,
			assessmentToApply.baselineBytes !== null
				? `baseline=${formatGb(assessmentToApply.baselineBytes)}`
				: null,
			assessmentToApply.delta1hBytes !== null
				? `Δ1h=${assessmentToApply.delta1hBytes >= 0 ? '+' : '−'}${formatGb(Math.abs(assessmentToApply.delta1hBytes))}`
				: null,
			assessmentToApply.peak24hBytes !== null
				? `peak24h=${formatGb(assessmentToApply.peak24hBytes)}`
				: null,
			...assessmentToApply.reasons
		]
			.filter(Boolean)
			.join(', ');
		this.openIncident({
			fingerprint: fp,
			severity: assessmentToApply.level === 'critical' ? 'critical' : 'warning',
			title: `${assessmentToApply.process} memory use is unusually high`,
			summary:
				`${formatGb(assessmentToApply.currentBytes)}${delta}${typical}` +
				(assessmentToApply.hostMemPercent !== null && assessmentToApply.hostMemPercent >= 90
					? ` · host memory pressure ${assessmentToApply.hostMemPercent.toFixed(0)}%`
					: ''),
			service: null,
			identity: assessmentToApply.process,
			evidenceMessage: evidence,
			source: 'reliability',
			refreshSummary: true
		});
	}

	// -------------------------------------------------------------------------
	// Correlation
	// -------------------------------------------------------------------------

	/**
	 * Re-evaluate active incidents against the dependency graph: incidents whose
	 * service depends on another service with an active incident become
	 * consequences of that root cause. Mount findings participate as root-cause
	 * candidates through their configured `consumers` (declared dependency
	 * evidence — never guessed): NZBDAV failure → mount unavailable → symlink
	 * roots broken → Arr import problems chains become one correlation chain
	 * instead of N independent problems.
	 */
	correlate(graph: TopologyGraph): void {
		const now = this.nowFn();
		const active = this.getActive();
		const byService = new Map<string, Incident>();
		for (const incident of active) {
			const svc = incidentServiceKey(incident);
			if (svc) byService.set(svc, incident);
		}
		const incoming = new Map<string, string[]>();
		for (const edge of graph.edges) {
			const list = incoming.get(edge.to) ?? [];
			list.push(edge.from);
			incoming.set(edge.to, list);
		}

		// Mount findings as upstream candidates: consumer service key → mount
		// finding (declared dependency, so causality claims stay evidence-based).
		const mountRoots = new Map<string, Incident>();
		for (const incident of active) {
			if (incident.detector !== 'mounts' && incident.detector !== 'mounts.symlinks') continue;
			if (incident.rootCauseFingerprint) continue;
			const identity = this.state.identityByFingerprint.get(incident.fingerprint);
			const report = this.mountConsumerIndex?.get(identity ?? '');
			if (!report) continue;
			for (const consumer of report) mountRoots.set(consumer, incident);
		}

		for (const incident of active) {
			const serviceKey = incidentServiceKey(incident);
			if (!serviceKey) continue;
			let rootCause = findRootCause(
				serviceKey,
				byService,
				incoming,
				incident.firstSeen,
				now,
				new Set()
			);
			// Declared mount dependency: the mount finding started before (or
			// with) this incident and is still open.
			if (!rootCause) {
				const mountRoot = mountRoots.get(serviceKey);
				if (
					mountRoot &&
					mountRoot !== incident &&
					mountRoot.fingerprint !== incident.fingerprint &&
					mountRoot.firstSeen <= incident.firstSeen + TUNING.correlationWindowMs
				) {
					rootCause = mountRoot;
				}
			}
			if (rootCause && rootCause !== incident) {
				const previousRoot = incident.rootCauseFingerprint;
				// Attribute the ultimate root cause down the chain.
				incident.rootCauseService = rootCause.rootCauseService ?? rootCauseServiceName(rootCause);
				incident.rootCauseFingerprint = rootCause.fingerprint;
				incident.severity = incident.severity === 'critical' ? 'critical' : 'warning';
				if (previousRoot !== incident.rootCauseFingerprint) {
					incident.timeline.push({
						at: now,
						severity: 'warning',
						message: `Likely caused by: ${incident.rootCauseService}`
					});
					this.trim(incident);
					incidentRepository.update(incident);
					this.events.onIncidentChange?.(incident, 'updated');
				}
			}
		}

		// Root-cause incidents accumulate every downstream service they knocked
		// out (transitively through the chain of correlated incidents).
		const dependentsByRoot = new Map<string, string[]>();
		for (const incident of active) {
			if (!incident.rootCauseFingerprint) continue;
			const key = incident.affectedServices[0];
			if (!key) continue;
			const list = dependentsByRoot.get(incident.rootCauseFingerprint) ?? [];
			list.push(key);
			dependentsByRoot.set(incident.rootCauseFingerprint, list);
		}
		for (const incident of active) {
			if (incident.rootCauseFingerprint) continue;
			const collected = new Set<string>();
			const queue = [incident.fingerprint];
			const seen = new Set(queue);
			while (queue.length > 0) {
				const fp = queue.shift()!;
				for (const key of dependentsByRoot.get(fp) ?? []) {
					collected.add(key);
					const dependent = active.find((i) => i.affectedServices[0] === key);
					if (dependent && !seen.has(dependent.fingerprint)) {
						seen.add(dependent.fingerprint);
						queue.push(dependent.fingerprint);
					}
				}
			}
			if (collected.size > 0) {
				incident.affectedServices = [...new Set([...incident.affectedServices, ...collected])];
				incidentRepository.update(incident);
				this.events.onIncidentChange?.(incident, 'updated');
			}
		}
	}

	// -------------------------------------------------------------------------
	// Internals
	// -------------------------------------------------------------------------

	private openIncident(input: {
		fingerprint: string;
		severity: IncidentSeverity;
		title: string;
		summary: string | null;
		service: string | null;
		/** Affected entity for non-service findings (path, process, integration id, media key). */
		identity?: string;
		evidenceMessage: string;
		source: Incident['evidence'][number]['source'];
		refreshSummary?: boolean;
	}): Incident {
		const now = this.nowFn();
		const existing = this.state.byFingerprint.get(input.fingerprint);
		const persisted = incidentRepository.findActiveByFingerprint(input.fingerprint);

		if (persisted && !existing) {
			// Engine restarted while the incident is still open: adopt it.
			this.state.byFingerprint.set(input.fingerprint, persisted);
			const identity = input.identity ?? input.service ?? persisted.affectedServices[0];
			if (identity && !this.state.identityByFingerprint.has(input.fingerprint)) {
				this.state.identityByFingerprint.set(input.fingerprint, identity);
			}
			this.events.onIncidentChange?.(persisted, 'updated');
			return persisted;
		}

		if (existing && (existing.status === 'active' || existing.status === 'acknowledged')) {
			if (input.refreshSummary && input.summary) existing.summary = input.summary;
			// Severity escalation/de-escalation while active (e.g. a memory
			// finding that keeps growing): record the transition in the timeline.
			if (input.severity !== existing.severity) {
				const previous = existing.severity;
				existing.severity = input.severity;
				existing.timeline.push({
					at: now,
					severity: input.severity,
					message:
						input.severity === 'critical'
							? `Escalated from ${previous} to critical`
							: `De-escalated from ${previous} to warning`
				});
				this.trim(existing);
				// Severity changes are meaningful to consumers (notifications
				// escalate on them): emit so SSE fan-out and hooks see it.
				this.events.onIncidentChange?.(existing, 'updated');
			}
			existing.lastSeen = now;
			existing.lastEvaluatedAt = now;
			existing.lastEvidenceAt = now;
			incidentRepository.update(existing);
			this.state.byFingerprint.set(input.fingerprint, existing);
			return existing;
		}

		// Reopen semantics: the same failure class came back. A *resolved*
		// record re-opens with an occurrence bump instead of creating a
		// look-alike row. An *archived* record stays archived — history the
		// operator cleared must not resurrect; a fresh incident is created.
		const previous = incidentRepository.findLatestByFingerprint(input.fingerprint);
		if (previous && previous.status === 'resolved') {
			previous.occurrences += 1;
			previous.status = 'active';
			previous.resolvedAt = null;
			previous.resolutionKind = null;
			previous.resolutionReason = null;
			previous.lastSeen = now;
			previous.lastEvaluatedAt = now;
			previous.lastEvidenceAt = now;
			previous.severity = input.severity;
			if (input.refreshSummary && input.summary) previous.summary = input.summary;
			previous.timeline.push({ at: now, severity: input.severity, message: 'Recurred' });
			this.trim(previous);
			incidentRepository.update(previous);
			this.state.byFingerprint.set(input.fingerprint, previous);
			if (input.identity ?? input.service) {
				this.state.identityByFingerprint.set(input.fingerprint, (input.identity ?? input.service)!);
			}
			this.events.onIncidentChange?.(previous, 'updated');
			return previous;
		}

		const identity = input.identity ?? input.service;
		const incident: Incident = {
			id: newIncidentId(),
			fingerprint: input.fingerprint,
			severity: input.severity,
			status: 'active',
			title: input.title,
			summary: input.summary,
			rootCauseService: null,
			rootCauseFingerprint: null,
			affectedServices: input.service ? [input.service] : identity ? [identity] : [],
			firstSeen: now,
			lastSeen: now,
			resolvedAt: null,
			occurrences: 1,
			detector: detectorForFingerprint(input.fingerprint),
			lastEvaluatedAt: now,
			lastEvidenceAt: now,
			acknowledgedAt: null,
			resolutionKind: null,
			resolutionReason: null,
			evidence: [{ at: now, source: input.source, message: input.evidenceMessage }],
			timeline: []
		};
		this.state.byFingerprint.set(input.fingerprint, incident);
		if (identity) this.state.identityByFingerprint.set(input.fingerprint, identity);
		incidentRepository.create(incident);
		this.events.onIncidentChange?.(incident, 'opened');
		return incident;
	}

	private touchIncident(fp: string, now: number): void {
		const incident = this.state.byFingerprint.get(fp);
		if (incident && (incident.status === 'active' || incident.status === 'acknowledged')) {
			incident.lastSeen = now;
			incident.lastEvaluatedAt = now;
			incident.lastEvidenceAt = now;
			incidentRepository.update(incident);
		}
	}

	private addEvidence(fp: string, evidence: Incident['evidence'][number]): void {
		const incident = this.state.byFingerprint.get(fp);
		if (!incident || incident.status !== 'active') return;
		incident.evidence.push(evidence);
		if (incident.evidence.length > TUNING.maxEvidence) {
			incident.evidence = incident.evidence.slice(-TUNING.maxEvidence);
		}
		incidentRepository.appendEvidence(incident.id, evidence);
	}

	/**
	 * Resolve one open incident. `kind` records what the resolution MEANS:
	 * 'recovered' requires the detector to have positively confirmed it;
	 * 'obsolete' means the finding's origin is gone (target removed, monitor
	 * disabled) and is never presented as a technical recovery. UNKNOWN
	 * detector state never reaches this path — callers that cannot verify
	 * simply do not resolve.
	 */
	private resolveIfActive(
		fp: string,
		now: number,
		message: string,
		kind: IncidentResolutionKind = 'recovered'
	): void {
		const incident = this.state.byFingerprint.get(fp);
		if (!incident) return;
		if (incident.status !== 'active' && incident.status !== 'acknowledged') return;
		incident.status = 'resolved';
		incident.resolvedAt = now;
		incident.lastSeen = now;
		incident.rootCauseService = null;
		incident.rootCauseFingerprint = null;
		incident.resolutionKind = kind;
		incident.resolutionReason = message;
		incident.timeline.push({ at: now, severity: 'info', message });
		this.trim(incident);
		incidentRepository.update(incident);
		incidentRepository.appendTimeline(incident.id, { at: now, message, severity: 'info' });
		this.state.byFingerprint.delete(fp);
		this.state.identityByFingerprint.delete(fp);
		this.state.metricsAbsentSince.delete(fp);
		this.events.onIncidentChange?.(incident, 'resolved');
	}

	private trim(incident: Incident): void {
		if (incident.timeline.length > TUNING.maxTimeline) {
			incident.timeline = incident.timeline.slice(-TUNING.maxTimeline);
		}
		if (incident.evidence.length > TUNING.maxEvidence) {
			incident.evidence = incident.evidence.slice(-TUNING.maxEvidence);
		}
	}
}

function freshState(): OpenState {
	return {
		byFingerprint: new Map(),
		identityByFingerprint: new Map(),
		unhealthyStreak: new Map(),
		degradedStreak: new Map(),
		healthyStreak: new Map(),
		stoppedSince: new Map(),
		errorBurst: new Map(),
		offlineSince: null,
		liveSince: null,
		metricsStaleSince: null,
		diskAboveSince: new Map(),
		restartFailures: new Map(),
		mountHealthyRounds: new Map(),
		symlinkCleanRounds: new Map(),
		metricsAbsentSince: new Map()
	};
}

/**
 * Service-bound incidents only: dependency-graph correlation is defined on
 * service keys. Findings scoped to other entities (mount paths, media items,
 * integrations, processes) join correlation through their own declared
 * dependency evidence (mount consumers), never through this map.
 */
function incidentServiceKey(incident: Incident): string | null {
	if (
		!incident.detector.startsWith('status.') &&
		incident.detector !== 'logs.errors' &&
		incident.detector !== 'legacy' &&
		incident.detector !== ''
	) {
		return null;
	}
	const first = incident.affectedServices[0];
	return incident.rootCauseFingerprint ? null : (first ?? null);
}

function rootCauseServiceName(incident: Incident): string {
	// Mount findings title as "<label>: <state>" — the label is the target name.
	const mountMatch = /^([^:]+): /.exec(incident.title);
	if (mountMatch) return mountMatch[1]!;
	const match = /^(.*) (is|keeps|database is)/.exec(incident.title);
	return match?.[1] ?? incident.title;
}

function findRootCause(
	serviceKey: string,
	byService: Map<string, Incident>,
	incoming: Map<string, string[]>,
	selfFirstSeen: number,
	now: number,
	visited: Set<string>,
	depth = 0
): Incident | null {
	if (depth > 3 || visited.has(serviceKey)) return null;
	visited.add(serviceKey);
	const dependencies = incoming.get(serviceKey) ?? [];
	for (const dep of dependencies) {
		const depIncident = byService.get(dep);
		if (
			depIncident &&
			depIncident.fingerprint !== fingerprint(serviceKey) &&
			Math.abs(depIncident.firstSeen - selfFirstSeen) <=
				TUNING.correlationWindowMs + Math.max(0, now - depIncident.lastSeen)
		) {
			return depIncident;
		}
		const upstream = findRootCause(
			dep,
			byService,
			incoming,
			selfFirstSeen,
			now,
			visited,
			depth + 1
		);
		if (upstream) return upstream;
	}
	return null;
}

function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Compact GB-scale formatting for memory findings (4.2 GB, 640 MB). */
function formatGb(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const gb = bytes / 1024 ** 3;
	if (gb >= 1) return `${gb.toFixed(1)} GB`;
	return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}
