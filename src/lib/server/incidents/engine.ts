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
	IncidentSeverity,
	LogLine,
	MetricsSnapshot,
	ServiceStatus
} from '$lib/types';
import type { TopologyGraph } from '$lib/types';
import { Fingerprints, fingerprint } from './fingerprint';
import { incidentRepository, newIncidentId } from './repository';
import { INCIDENT_TUNING as TUNING } from './tuning';

interface OpenState {
	/** Open (or pending-open) incident keyed by fingerprint. */
	byFingerprint: Map<string, Incident>;
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
}

export interface EngineEvents {
	/** Called for every created/updated/resolved incident (for SSE fanout). */
	onIncidentChange?: (incident: Incident, action: 'opened' | 'updated' | 'resolved') => void;
}

export class IncidentEngine {
	private state: OpenState = freshState();

	constructor(
		private readonly events: EngineEvents = {},
		private readonly nowFn: () => number = Date.now
	) {}

	/** Re-arm the engine (tests / config reload). Reopens DB incidents on boot. */
	reset(): void {
		this.state = freshState();
	}

	getActive(): Incident[] {
		return [...this.state.byFingerprint.values()].filter((i) => i.status === 'active');
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

	/** Called periodically by the hub to detect a stalled metrics stream. */
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
		const offline = snapshot.state === 'offline' || snapshot.state === 'credentials-invalid';

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
		if (!offline) return; // connecting/reconnecting: debounce, no incident.

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
			this.openIncident({
				fingerprint: Fingerprints.dumbOffline(),
				severity: 'critical',
				title: 'DUMB gateway unreachable',
				summary: `No connection to the DUMB gateway since ${new Date(this.state.offlineSince).toLocaleTimeString()}`,
				service: null,
				evidenceMessage: snapshot.lastError ?? 'connection offline',
				source: 'connection',
				refreshSummary: true
			});
		}
	}

	// -------------------------------------------------------------------------
	// Correlation
	// -------------------------------------------------------------------------

	/**
	 * Re-evaluate active incidents against the dependency graph: incidents whose
	 * service depends on another service with an active incident become
	 * consequences of that root cause.
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

		for (const incident of active) {
			const serviceKey = incidentServiceKey(incident);
			if (!serviceKey) continue;
			const rootCause = findRootCause(
				serviceKey,
				byService,
				incoming,
				incident.firstSeen,
				now,
				new Set()
			);
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
			this.events.onIncidentChange?.(persisted, 'updated');
			return persisted;
		}

		if (existing && existing.status === 'active') {
			if (input.refreshSummary && input.summary) existing.summary = input.summary;
			existing.lastSeen = now;
			incidentRepository.update(existing);
			this.state.byFingerprint.set(input.fingerprint, existing);
			return existing;
		}

		// Reopen semantics: the same failure class came back. Bump occurrences on
		// the previous record instead of creating a look-alike row.
		const previous = incidentRepository.findLatestByFingerprint(input.fingerprint);
		if (previous && previous.status === 'resolved') {
			previous.occurrences += 1;
			previous.status = 'active';
			previous.resolvedAt = null;
			previous.lastSeen = now;
			previous.severity = input.severity;
			if (input.refreshSummary && input.summary) previous.summary = input.summary;
			previous.timeline.push({ at: now, severity: input.severity, message: 'Recurred' });
			this.trim(previous);
			incidentRepository.update(previous);
			this.state.byFingerprint.set(input.fingerprint, previous);
			this.events.onIncidentChange?.(previous, 'updated');
			return previous;
		}

		const incident: Incident = {
			id: newIncidentId(),
			fingerprint: input.fingerprint,
			severity: input.severity,
			status: 'active',
			title: input.title,
			summary: input.summary,
			rootCauseService: null,
			rootCauseFingerprint: null,
			affectedServices: input.service ? [input.service] : [],
			firstSeen: now,
			lastSeen: now,
			resolvedAt: null,
			occurrences: 1,
			evidence: [{ at: now, source: input.source, message: input.evidenceMessage }],
			timeline: []
		};
		this.state.byFingerprint.set(input.fingerprint, incident);
		incidentRepository.create(incident);
		this.events.onIncidentChange?.(incident, 'opened');
		return incident;
	}

	private touchIncident(fp: string, now: number): void {
		const incident = this.state.byFingerprint.get(fp);
		if (incident && incident.status === 'active') {
			incident.lastSeen = now;
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

	private resolveIfActive(fp: string, now: number, message: string): void {
		const incident = this.state.byFingerprint.get(fp);
		if (!incident || incident.status !== 'active') return;
		incident.status = 'resolved';
		incident.resolvedAt = now;
		incident.lastSeen = now;
		incident.rootCauseService = null;
		incident.rootCauseFingerprint = null;
		incident.timeline.push({ at: now, severity: 'info', message });
		this.trim(incident);
		incidentRepository.update(incident);
		this.state.byFingerprint.delete(fp);
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
		unhealthyStreak: new Map(),
		degradedStreak: new Map(),
		healthyStreak: new Map(),
		stoppedSince: new Map(),
		errorBurst: new Map(),
		offlineSince: null,
		liveSince: null,
		metricsStaleSince: null,
		diskAboveSince: new Map(),
		restartFailures: new Map()
	};
}

/** Services whose fingerprint is not service-bound (gateway, disk, telemetry). */
function incidentServiceKey(incident: Incident): string | null {
	const first = incident.affectedServices[0];
	return incident.rootCauseFingerprint ? null : (first ?? null);
}

function rootCauseServiceName(incident: Incident): string {
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
