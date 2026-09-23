/**
 * Incident lifecycle semantics (v0.8): every detector must have deterministic
 * recovery/close semantics, resolutions must record WHAT they mean
 * (recovered vs obsolete vs operator), and no lifecycle path may turn
 * "cannot verify" into "recovered".
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { IncidentEngine, detectorForFingerprint } from '../src/lib/server/incidents/engine';
import { incidentRepository, newIncidentId } from '../src/lib/server/incidents/repository';
import { Fingerprints } from '../src/lib/server/incidents/fingerprint';
import { IncidentSafetyNet } from '../src/lib/server/incidents/safety-net';
import { getDb } from '../src/lib/server/database/db';
import type {
	ConnectionSnapshot,
	Incident,
	MetricsSnapshot,
	MountReport,
	ServiceStatus
} from '$lib/types';

let now = 1_750_000_000_000;
const clock = () => now;
const advance = (ms: number) => (now += ms);

function serviceStatus(overrides: Partial<ServiceStatus> & { key: string }): ServiceStatus {
	return {
		name: overrides.name ?? overrides.key,
		processName: overrides.name ?? overrides.key,
		enabled: true,
		runState: 'running',
		health: 'healthy',
		healthReason: null,
		healthDetails: null,
		restart: null,
		cpuPercent: null,
		memoryBytes: null,
		pid: 1,
		observedAt: now,
		...overrides
	};
}

function metrics(overrides: Partial<MetricsSnapshot> = {}): MetricsSnapshot {
	return {
		timestamp: now,
		receivedAt: now,
		cpuPercent: 10,
		cpuCount: 4,
		loadAvg: [1, 1, 1],
		memory: { totalBytes: 16e9, usedBytes: 8e9, percent: 50 },
		filesystems: [
			{
				path: '/data',
				totalBytes: 1e9,
				usedBytes: 1e8,
				freeBytes: 9e8,
				percent: 10,
				inodePercent: 1
			}
		],
		processes: [{ name: 'sonarr', cpuPercent: 1, memoryBytes: 2e9, pid: 42 }],
		databaseHealth: [],
		network: [],
		networkTotals: { sentBytes: 0, recvBytes: 0 },
		...overrides
	};
}

function mountReport(overrides: {
	path: string;
	state: MountReport['state'];
	symlink?: MountReport['symlink'];
	label?: string;
	consumers?: string[];
}): MountReport {
	return {
		target: {
			id: overrides.path,
			path: overrides.path,
			label: overrides.label ?? overrides.path,
			kind: 'local',
			consumers: overrides.consumers ?? []
		},
		state: overrides.state,
		statLatencyMs: 5,
		listLatencyMs: 5,
		failedRounds: 0,
		healthyRounds: 2,
		symlink: overrides.symlink ?? null,
		lastProbeAt: now,
		lastSuccessAt: now,
		lastError: null
	};
}

function persistedIncident(overrides: Partial<Incident> & { fingerprint: string }): Incident {
	return {
		id: newIncidentId(),
		severity: 'warning',
		status: 'active',
		title: 'Stale finding',
		summary: null,
		rootCauseService: null,
		rootCauseFingerprint: null,
		affectedServices: [],
		firstSeen: now - 3_600_000,
		lastSeen: now - 1_800_000,
		resolvedAt: null,
		occurrences: 1,
		detector: 'legacy',
		lastEvaluatedAt: null,
		lastEvidenceAt: null,
		acknowledgedAt: null,
		resolutionKind: null,
		resolutionReason: null,
		evidence: [],
		timeline: [],
		...overrides,
		fingerprint: overrides.fingerprint
	};
}

function clearTables(): void {
	getDb().exec('DELETE FROM incident_events; DELETE FROM incidents;');
}

beforeEach(() => {
	now = 1_750_000_000_000;
	clearTables();
});

describe('resolution kinds and lifecycle metadata', () => {
	it('a recovered incident records resolutionKind=recovered and a reason', () => {
		const engine = new IncidentEngine({}, clock);
		const unhealthy = serviceStatus({ key: 'sonarr', health: 'unhealthy' });
		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		const healthy = serviceStatus({ key: 'sonarr', health: 'healthy' });
		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[healthy.key, healthy]]));
		const row = incidentRepository.findLatestByFingerprint(Fingerprints.serviceUnhealthy('sonarr'));
		expect(row?.status).toBe('resolved');
		expect(row?.resolutionKind).toBe('recovered');
		expect(row?.resolutionReason).toBeTruthy();
		expect(row?.detector).toBe('status.health');
		expect(row?.lastEvaluatedAt).toBe(now);
	});

	it('acknowledged incidents stay technically open and resolve normally', () => {
		const engine = new IncidentEngine({}, clock);
		const unhealthy = serviceStatus({ key: 'sonarr', health: 'unhealthy' });
		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		const fp = Fingerprints.serviceUnhealthy('sonarr');

		// Operator acknowledges through the repository (as the API route does).
		const incident = incidentRepository.findActiveByFingerprint(fp);
		expect(incident).not.toBeNull();
		const acknowledged = incidentRepository.acknowledge(incident!.id, now, 'Acknowledged');
		expect(acknowledged?.status).toBe('acknowledged');
		expect(acknowledged?.acknowledgedAt).toBe(now);

		// The engine keeps evaluating acknowledged incidents: detector still
		// sees the problem → stays open (muted, not resolved).
		engine.hydrate();
		advance(30_000);
		engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		expect(engine.getActive().some((i) => i.fingerprint === fp)).toBe(true);

		// Recovery resolves the acknowledged incident too.
		const healthy = serviceStatus({ key: 'sonarr', health: 'healthy' });
		for (let i = 0; i < 3; i++) {
			advance(2_000);
			engine.onStatus(new Map(), new Map([[healthy.key, healthy]]));
		}
		expect(engine.getActive()).toHaveLength(0);
		const row = incidentRepository.findLatestByFingerprint(fp);
		expect(row?.status).toBe('resolved');
		expect(row?.resolutionKind).toBe('recovered');
	});

	it('resolved incidents archive (soft state) and never pretend recovery', () => {
		const engine = new IncidentEngine({}, clock);
		const unhealthy = serviceStatus({ key: 'sonarr', health: 'unhealthy' });
		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		const healthy = serviceStatus({ key: 'sonarr', health: 'healthy' });
		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[healthy.key, healthy]]));
		const fp = Fingerprints.serviceUnhealthy('sonarr');
		const resolved = incidentRepository.findLatestByFingerprint(fp)!;

		const archived = incidentRepository.archive(resolved.id, now, 'Archived by operator');
		expect(archived?.status).toBe('archived');

		// Archiving an ACTIVE incident is rejected — no truth corruption.
		for (let i = 0; i < 3; i++)
			engine.onStatus(
				new Map(),
				new Map([
					[
						serviceStatus({ key: 'prowlarr', health: 'unhealthy' }).key,
						serviceStatus({ key: 'prowlarr', health: 'unhealthy' })
					]
				])
			);
		const activeFp = Fingerprints.serviceUnhealthy('prowlarr');
		const active = incidentRepository.findActiveByFingerprint(activeFp)!;
		expect(incidentRepository.archive(active.id, now, 'nope')).toBeNull();
	});

	it('archived incidents stay archived — recurrence opens a fresh row', () => {
		const engine = new IncidentEngine({}, clock);
		const unhealthy = serviceStatus({ key: 'sonarr', health: 'unhealthy' });
		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		const healthy = serviceStatus({ key: 'sonarr', health: 'healthy' });
		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[healthy.key, healthy]]));
		const fp = Fingerprints.serviceUnhealthy('sonarr');
		const resolved = incidentRepository.findLatestByFingerprint(fp)!;
		incidentRepository.archive(resolved.id, now, 'Archived by operator');

		// The failure class comes back AFTER the archive: must be a NEW row.
		advance(60 * 60_000);
		for (let i = 0; i < 3; i++) {
			advance(2_000);
			engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		}
		const rows = getDb()
			.prepare('SELECT * FROM incidents WHERE fingerprint = ? ORDER BY first_seen ASC')
			.all(fp) as unknown as { id: string; status: string }[];
		expect(rows).toHaveLength(2);
		expect(rows[0]!.status).toBe('archived');
		expect(rows[1]!.status).toBe('active');
		expect(rows[1]!.id).not.toBe(rows[0]!.id);
	});
});

describe('detector-specific close semantics', () => {
	it('hydrated log-error incidents can still resolve after restart (one clean window)', () => {
		// Persisted open log-error incident with identity.
		const fp = Fingerprints.logErrors('sonarr');
		incidentRepository.create(
			persistedIncident({
				fingerprint: fp,
				title: 'sonarr is logging repeated errors',
				affectedServices: ['sonarr'],
				detector: 'logs.errors'
			})
		);
		const engine = new IncidentEngine({}, clock);
		engine.hydrate();
		expect(engine.getActive()).toHaveLength(1);
		// No errors arrive; the detector sweeps a clean window → resolves.
		advance(120_000);
		engine.onTick(null, true);
		expect(engine.getActive()).toHaveLength(0);
		const row = incidentRepository.findLatestByFingerprint(fp);
		expect(row?.status).toBe('resolved');
		expect(row?.timeline.some((t) => t.message.includes('error rate'))).toBe(true);
	});

	it('metrics-scoped findings resolve as obsolete only after sustained absence on fresh metrics', () => {
		const engine = new IncidentEngine({}, clock);
		const fsGone = metrics({
			filesystems: [
				{
					path: '/gone',
					totalBytes: 1e9,
					usedBytes: 9.5e8,
					freeBytes: 5e7,
					percent: 95,
					inodePercent: 1
				}
			]
		});
		engine.onMetrics(fsGone); // arms the sustained-over-threshold timer
		advance(40_000); // sustained over threshold → opens
		engine.onMetrics(fsGone);
		expect(engine.getActive().some((i) => i.fingerprint.startsWith('disk-usage:'))).toBe(true);

		// The fs disappears from fresh metrics: absence shorter than the window
		// must NOT resolve anything.
		engine.onMetrics(metrics());
		advance(60_000);
		engine.onMetrics(metrics());
		expect(engine.getActive().some((i) => i.fingerprint.startsWith('disk-usage:'))).toBe(true);

		// Absence beyond the window: the finding retires as OBSOLETE — the fs
		// is gone from DUMB's view, which is not a recovery.
		advance(10 * 60_000);
		engine.onMetrics(metrics());
		const fpRow = getDb()
			.prepare(
				"SELECT * FROM incidents WHERE fingerprint LIKE 'disk-usage:%' AND status = 'resolved'"
			)
			.get() as unknown as { resolution_kind: string; resolution_reason: string } | undefined;
		expect(fpRow?.resolution_kind).toBe('obsolete');
		expect(fpRow?.resolution_reason).toContain('no longer reported');
	});

	it('memory findings resolve through tracker hysteresis, never on mere absence', () => {
		const engine = new IncidentEngine({}, clock);
		const fp = Fingerprints.memoryAnomaly('sonarr');
		incidentRepository.create(
			persistedIncident({
				fingerprint: fp,
				title: 'sonarr memory use is unusually high',
				affectedServices: ['sonarr'],
				detector: 'memory'
			})
		);
		engine.hydrate();
		// Metrics stay fresh, sonarr still reported, tracker says nothing new:
		// the incident must remain open.
		engine.onMetrics(metrics());
		expect(engine.getActive().some((i) => i.fingerprint === fp)).toBe(true);
		// Tracker positively confirms recovery:
		advance(1_000);
		engine.onMemory({
			process: 'sonarr',
			level: 'ok',
			currentBytes: 1e9,
			baselineBytes: 1e9,
			delta1hBytes: 0,
			delta6hBytes: 0,
			peak24hBytes: 2e9,
			hostMemPercent: null,
			reasons: [],
			samples: 30,
			lastSampleAt: now
		});
		expect(engine.getActive()).toHaveLength(0);
		const row = incidentRepository.findLatestByFingerprint(fp);
		expect(row?.resolutionKind).toBe('recovered');
	});

	it('mount findings resolve after the configured healthy probe rounds (hysteresis)', () => {
		const engine = new IncidentEngine({}, clock);
		const down = mountReport({ path: '/mnt/remote', state: 'unresponsive' });
		down.failedRounds = 3;
		engine.onMountHealth([down]);
		expect(engine.getActive().some((i) => i.fingerprint.startsWith('mount:'))).toBe(true);

		// One healthy round is not enough.
		engine.onMountHealth([mountReport({ path: '/mnt/remote', state: 'healthy' })]);
		expect(engine.getActive().some((i) => i.fingerprint.startsWith('mount:'))).toBe(true);
		// The second consecutive healthy round resolves (recovered).
		engine.onMountHealth([mountReport({ path: '/mnt/remote', state: 'healthy' })]);
		expect(engine.getActive()).toHaveLength(0);
		const row = getDb()
			.prepare("SELECT resolution_kind FROM incidents WHERE fingerprint LIKE 'mount:%'")
			.get() as { resolution_kind: string };
		expect(row.resolution_kind).toBe('recovered');
	});

	it('symlink findings resolve when a healthy mount samples few links', () => {
		const engine = new IncidentEngine({}, clock);
		const brokenSample = {
			sampled: 10,
			valid: 0,
			broken: 10,
			unreadable: 0,
			entriesScanned: 100,
			truncated: false
		};
		engine.onMountHealth([
			{
				...mountReport({ path: '/symlinks', state: 'healthy', symlink: brokenSample }),
				healthyRounds: 2
			}
		]);
		const symlinkFp = Fingerprints.symlinksBroken('/symlinks');
		expect(engine.getActive().some((i) => i.fingerprint === symlinkFp)).toBe(true);

		// Mount healthy again but the library restructured: only 3 links found.
		const smallSample = {
			sampled: 3,
			valid: 3,
			broken: 0,
			unreadable: 0,
			entriesScanned: 30,
			truncated: false
		};
		engine.onMountHealth([
			mountReport({ path: '/symlinks', state: 'healthy', symlink: smallSample })
		]);
		advance(60_000);
		engine.onMountHealth([
			mountReport({ path: '/symlinks', state: 'healthy', symlink: smallSample })
		]);
		expect(engine.getActive().some((i) => i.fingerprint === symlinkFp)).toBe(false);
	});

	it('symlink findings resolve when sampling stops finding links at all', () => {
		const engine = new IncidentEngine({}, clock);
		const brokenSample = {
			sampled: 12,
			valid: 1,
			broken: 11,
			unreadable: 0,
			entriesScanned: 120,
			truncated: false
		};
		engine.onMountHealth([
			{
				...mountReport({ path: '/symlinks2', state: 'healthy', symlink: brokenSample }),
				healthyRounds: 2
			}
		]);
		const fp = Fingerprints.symlinksBroken('/symlinks2');
		expect(engine.getActive().some((i) => i.fingerprint === fp)).toBe(true);
		const emptySample = {
			sampled: 0,
			valid: 0,
			broken: 0,
			unreadable: 0,
			entriesScanned: 50,
			truncated: false
		};
		advance(60_000);
		engine.onMountHealth([
			mountReport({ path: '/symlinks2', state: 'healthy', symlink: emptySample })
		]);
		advance(60_000);
		engine.onMountHealth([
			mountReport({ path: '/symlinks2', state: 'healthy', symlink: emptySample })
		]);
		expect(engine.getActive().some((i) => i.fingerprint === fp)).toBe(false);
	});

	it('integrations resolve after sustained successful polling', () => {
		const engine = new IncidentEngine({}, clock);
		engine.onIntegrations([{ id: 'plex', failures: 6 }]);
		const fp = Fingerprints.integrationDown('plex');
		expect(engine.getActive().some((i) => i.fingerprint === fp)).toBe(true);
		engine.onIntegrations([{ id: 'plex', failures: 0 }]);
		expect(engine.getActive()).toHaveLength(0);
	});

	it('service removed from the managed registry resolves all its findings as obsolete', () => {
		const engine = new IncidentEngine({}, clock);
		const unhealthy = serviceStatus({ key: 'legacy-app', health: 'unhealthy' });
		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		expect(engine.getActive()).toHaveLength(1);

		// Discovery refresh without the service (registry non-empty).
		engine.reconcileRegistryStops(new Set(['sonarr']));
		expect(engine.getActive()).toHaveLength(0);
		const row = incidentRepository.findLatestByFingerprint(
			Fingerprints.serviceUnhealthy('legacy-app')
		);
		expect(row?.resolutionKind).toBe('obsolete');
	});

	it('does not resolve service findings while the registry is unknown', () => {
		const engine = new IncidentEngine({}, clock);
		const unhealthy = serviceStatus({ key: 'sonarr', health: 'unhealthy' });
		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		engine.reconcileRegistryStops(new Set());
		expect(engine.getActive()).toHaveLength(1);
	});
});

describe('stale-incident safety net', () => {
	function net(engine: IncidentEngine): IncidentSafetyNet {
		return new IncidentSafetyNet(engine);
	}

	it('retires mount findings whose target was removed from the configuration', () => {
		const engine = new IncidentEngine({}, clock);
		const down = mountReport({ path: '/mnt/removed', state: 'unresponsive' });
		down.failedRounds = 3;
		engine.onMountHealth([down]);
		expect(engine.getActive()).toHaveLength(1);

		const resolved = net(engine).run({
			now,
			mountTargets: [
				{ id: '/mnt/other', path: '/mnt/other', label: 'Other', kind: 'local', consumers: [] }
			],
			mountMonitoringEnabled: true,
			memoryMonitoringEnabled: true,
			reconciliationEnabled: true,
			runtimeMonitoringEnabled: true,
			registeredIntegrationIds: [],
			arrIntegrationsPresent: true,
			dumbConfigured: true,
			metricsFresh: true,
			legacyGraceElapsed: false
		});
		expect(resolved).toBe(1);
		expect(engine.getActive()).toHaveLength(0);
		const row = getDb()
			.prepare("SELECT resolution_kind, resolution_reason FROM incidents WHERE status = 'resolved'")
			.get() as { resolution_kind: string; resolution_reason: string };
		expect(row.resolution_kind).toBe('obsolete');
		expect(row.resolution_reason).toContain('removed from the configuration');
	});

	it('retires findings when their monitor is disabled', () => {
		const engine = new IncidentEngine({}, clock);
		const down = mountReport({ path: '/mnt/x', state: 'read-error' });
		down.failedRounds = 3;
		engine.onMountHealth([down]);
		expect(engine.getActive()).toHaveLength(1);

		net(engine).run({
			now,
			mountTargets: [],
			mountMonitoringEnabled: false,
			memoryMonitoringEnabled: true,
			reconciliationEnabled: true,
			runtimeMonitoringEnabled: true,
			registeredIntegrationIds: [],
			arrIntegrationsPresent: true,
			dumbConfigured: true,
			metricsFresh: true,
			legacyGraceElapsed: false
		});
		expect(engine.getActive()).toHaveLength(0);
		const row = getDb()
			.prepare("SELECT resolution_kind FROM incidents WHERE status = 'resolved'")
			.get() as { resolution_kind: string };
		expect(row.resolution_kind).toBe('obsolete');
	});

	it('retires integration findings for deleted integrations', () => {
		const engine = new IncidentEngine({}, clock);
		engine.onIntegrations([{ id: 'deleted-arr', failures: 5 }]);
		expect(engine.getActive()).toHaveLength(1);

		net(engine).run({
			now,
			mountTargets: [],
			mountMonitoringEnabled: true,
			memoryMonitoringEnabled: true,
			reconciliationEnabled: true,
			runtimeMonitoringEnabled: true,
			registeredIntegrationIds: ['sonarr-main'],
			arrIntegrationsPresent: true,
			dumbConfigured: true,
			metricsFresh: true,
			legacyGraceElapsed: false
		});
		expect(engine.getActive()).toHaveLength(0);
		const row = getDb()
			.prepare("SELECT resolution_kind, resolution_reason FROM incidents WHERE status = 'resolved'")
			.get() as { resolution_kind: string; resolution_reason: string };
		expect(row.resolution_kind).toBe('obsolete');
		expect(row.resolution_reason).toContain('deleted');
	});

	it('never resolves anything when the detector merely cannot verify', () => {
		const engine = new IncidentEngine({}, clock);
		incidentRepository.create(
			persistedIncident({
				fingerprint: Fingerprints.memoryAnomaly('sonarr'),
				affectedServices: ['sonarr'],
				detector: 'memory',
				title: 'sonarr memory use is unusually high'
			})
		);
		engine.hydrate();

		// Monitoring enabled, target present — nothing to retire even though
		// the metrics are stale and the detector has not evaluated recently.
		const resolved = net(engine).run({
			now,
			mountTargets: [],
			mountMonitoringEnabled: true,
			memoryMonitoringEnabled: true,
			reconciliationEnabled: true,
			runtimeMonitoringEnabled: true,
			registeredIntegrationIds: ['sonarr'],
			arrIntegrationsPresent: true,
			dumbConfigured: true,
			metricsFresh: false,
			legacyGraceElapsed: false
		});
		expect(resolved).toBe(0);
		expect(engine.getActive()).toHaveLength(1);
	});

	it('retires stack findings when the DUMB connection is removed', () => {
		const engine = new IncidentEngine({}, clock);
		const unhealthy = serviceStatus({ key: 'sonarr', health: 'unhealthy' });
		for (let i = 0; i < 3; i++) engine.onStatus(new Map(), new Map([[unhealthy.key, unhealthy]]));
		net(engine).run({
			now,
			mountTargets: [],
			mountMonitoringEnabled: true,
			memoryMonitoringEnabled: true,
			reconciliationEnabled: true,
			runtimeMonitoringEnabled: true,
			registeredIntegrationIds: ['sonarr'],
			arrIntegrationsPresent: true,
			dumbConfigured: false,
			metricsFresh: false,
			legacyGraceElapsed: false
		});
		expect(engine.getActive()).toHaveLength(0);
	});
});

describe('connection lifecycle', () => {
	it('offline incidents resolve only after a sustained live connection', () => {
		const engine = new IncidentEngine({}, clock);
		const offline = (overrides: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot => ({
			state: 'offline',
			streams: { rest: 'offline', status: 'offline', metrics: 'offline', logs: 'offline' },
			lastUpdateAt: null,
			lastSuccessAt: now - 120_000,
			connectedSince: null,
			stateSince: now,
			lastError: 'connection refused',
			reconnectAttempts: 3,
			dumbVersion: null,
			authMode: 'local',
			probes: {
				http: { status: 'failed', code: 'refused', detail: 'refused', at: now, okAt: null },
				auth: { status: 'failed', code: 'refused', detail: 'refused', at: now, okAt: null },
				rest: { status: 'failed', code: 'refused', detail: 'refused', at: now, okAt: null }
			},
			...overrides
		});
		engine.onConnection(offline()); // marks offline-since
		advance(20_000); // grace elapses
		engine.onConnection(offline());
		expect(engine.getActive().some((i) => i.fingerprint === Fingerprints.dumbOffline())).toBe(true);
		const live = offline({ state: 'live' });
		engine.onConnection(live);
		expect(engine.getActive().some((i) => i.fingerprint === Fingerprints.dumbOffline())).toBe(true);
		advance(30_000);
		engine.onConnection(live);
		expect(engine.getActive().some((i) => i.fingerprint === Fingerprints.dumbOffline())).toBe(
			false
		);
	});
});

describe('detector registry', () => {
	it('maps fingerprint prefixes to owning detectors', () => {
		expect(detectorForFingerprint(Fingerprints.serviceUnhealthy('x'))).toBe('status.health');
		expect(detectorForFingerprint(Fingerprints.mountUnhealthy('/m'))).toBe('mounts');
		expect(detectorForFingerprint(Fingerprints.memoryAnomaly('p'))).toBe('memory');
		expect(detectorForFingerprint('media-repeat:abc')).toBe('media-flow');
		expect(detectorForFingerprint('recon:plex-ghost:abc')).toBe('reconciliation');
		expect(detectorForFingerprint('self:workers')).toBe('runtime');
		expect(detectorForFingerprint('unknown:xyz')).toBe('legacy');
	});
});

describe('pre-v0.8 legacy incident migration', () => {
	function legacyRow(overrides: Partial<Incident> & { fingerprint: string }): Incident {
		// Pre-v0.8 rows: detector='' (column default), no lifecycle metadata.
		return persistedIncident({ detector: '', ...overrides });
	}

	it('legacy finding whose condition still holds is re-adopted and stays open (never UNKNOWN→recovered)', () => {
		const fp = Fingerprints.memoryAnomaly('sonarr');
		incidentRepository.create(
			legacyRow({
				fingerprint: fp,
				title: 'sonarr memory use is unusually high',
				affectedServices: [],
				detector: '',
				lastEvaluatedAt: null
			})
		);
		const engine = new IncidentEngine({}, clock);
		engine.hydrate();
		expect(engine.getActive()).toHaveLength(1);

		// The detector re-reports the same fingerprint: the row is adopted
		// (detector stamped, identity recorded) and REMAINS open.
		advance(1_000);
		engine.onMemory({
			process: 'sonarr',
			level: 'warning',
			currentBytes: 4.2e9,
			baselineBytes: 1e9,
			delta1hBytes: 512 * 1024 ** 2,
			delta6hBytes: 2e9,
			peak24hBytes: 4.2e9,
			hostMemPercent: null,
			reasons: ['still growing'],
			samples: 30,
			lastSampleAt: now
		});
		expect(engine.getActive().some((i) => i.fingerprint === fp)).toBe(true);
		const row = incidentRepository.findLatestByFingerprint(fp)!;
		expect(row.status).toBe('active');
		expect(row.detector).toBe('memory');
		expect(row.lastEvaluatedAt).toBe(now);
		// The safety net must NOT retire the re-adopted (stamped) row.
		const net = new IncidentSafetyNet(engine);
		net.run({
			now,
			mountTargets: [],
			mountMonitoringEnabled: true,
			memoryMonitoringEnabled: true,
			reconciliationEnabled: true,
			runtimeMonitoringEnabled: true,
			registeredIntegrationIds: ['sonarr'],
			arrIntegrationsPresent: true,
			dumbConfigured: true,
			metricsFresh: false,
			legacyGraceElapsed: true
		});
		expect(engine.getActive().some((i) => i.fingerprint === fp)).toBe(true);
	});

	it('legacy finding whose service recovered resolves as recovered after upgrade', () => {
		const fp = Fingerprints.serviceUnhealthy('sonarr');
		incidentRepository.create(
			legacyRow({
				fingerprint: fp,
				title: 'sonarr is unhealthy',
				affectedServices: ['sonarr'],
				detector: ''
			})
		);
		const engine = new IncidentEngine({}, clock);
		engine.hydrate();
		expect(engine.getActive()).toHaveLength(1);
		const healthy = serviceStatus({ key: 'sonarr', health: 'healthy' });
		for (let i = 0; i < 3; i++) {
			advance(2_000);
			engine.onStatus(new Map(), new Map([[healthy.key, healthy]]));
		}
		expect(engine.getActive()).toHaveLength(0);
		const row = incidentRepository.findLatestByFingerprint(fp)!;
		expect(row.status).toBe('resolved');
		expect(row.resolutionKind).toBe('recovered');
	});

	it('orphaned legacy findings (no detector re-adopted) retire as obsolete after the grace window', () => {
		// A mount finding for a target that no longer exists: detector='',
		// no identity, and the mount probe can never re-adopt it (the
		// fingerprint no longer matches any configured path).
		const fp = Fingerprints.mountUnhealthy('/mnt/removed-long-ago');
		incidentRepository.create(
			legacyRow({
				fingerprint: fp,
				title: 'Old mount: unresponsive',
				affectedServices: [],
				detector: '',
				lastEvaluatedAt: null
			})
		);
		const engine = new IncidentEngine({}, clock);
		engine.hydrate();
		expect(engine.getActive()).toHaveLength(1);

		const net = new IncidentSafetyNet(engine);
		// Before the grace: nothing is retired (detectors still get their chance).
		net.run({
			now,
			mountTargets: [],
			mountMonitoringEnabled: true,
			memoryMonitoringEnabled: true,
			reconciliationEnabled: true,
			runtimeMonitoringEnabled: true,
			registeredIntegrationIds: [],
			arrIntegrationsPresent: true,
			dumbConfigured: true,
			metricsFresh: true,
			legacyGraceElapsed: false
		});
		expect(engine.getActive()).toHaveLength(1);

		// After the grace: retired as explicitly OBSOLETE — not recovered.
		advance(61 * 60_000);
		net.run({
			now,
			mountTargets: [],
			mountMonitoringEnabled: true,
			memoryMonitoringEnabled: true,
			reconciliationEnabled: true,
			runtimeMonitoringEnabled: true,
			registeredIntegrationIds: [],
			arrIntegrationsPresent: true,
			dumbConfigured: true,
			metricsFresh: true,
			legacyGraceElapsed: true
		});
		expect(engine.getActive()).toHaveLength(0);
		const row = incidentRepository.findLatestByFingerprint(fp)!;
		expect(row.status).toBe('resolved');
		expect(row.resolutionKind).toBe('obsolete');
		expect(row.resolutionReason).toContain('legacy (pre-v0.8)');
	});
});
