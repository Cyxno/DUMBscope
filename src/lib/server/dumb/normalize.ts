/**
 * Normalize raw DUMB payloads into DUMBscope domain types.
 *
 * DUMB is treated as a friendly but unreliable narrator: fields may be absent,
 * timestamps may be ISO strings or epoch numbers, and unknown values must map
 * to `unknown` rather than crash the stream pipeline.
 */
import type {
	DiscoveredService,
	FilesystemMetric,
	HealthDetails,
	HealthStatus,
	MetricsSnapshot,
	NetworkInterfaceMetric,
	ProcessMetric,
	RestartState,
	RunState,
	ServiceStatus
} from '$lib/types';
import type {
	DumbFilesystem,
	DumbMetricsSnapshot,
	DumbNetworkInterface,
	DumbProcessEntry,
	DumbProcessMetric,
	DumbServiceStatus
} from './types';

export function toEpochMs(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'number' && Number.isFinite(value)) {
		// Seconds vs milliseconds heuristics: DUMB uses seconds timestamps.
		return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
	}
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
		const numeric = Number(value);
		if (Number.isFinite(numeric)) return toEpochMs(numeric);
	}
	return null;
}

function asNumber(value: unknown): number | null {
	const n = typeof value === 'string' ? Number(value) : value;
	return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export function normalizeHealthStatus(raw: unknown, fallbackHealthy?: boolean): HealthStatus {
	if (typeof raw === 'string') {
		const v = raw.toLowerCase();
		if (v === 'healthy') return 'healthy';
		if (v === 'degraded') return 'degraded';
		if (v === 'starting') return 'starting';
		if (v === 'unhealthy') return 'unhealthy';
	}
	if (typeof fallbackHealthy === 'boolean') return fallbackHealthy ? 'healthy' : 'unhealthy';
	return 'unknown';
}

export function normalizeRunState(raw: unknown): RunState {
	if (typeof raw !== 'string') return 'unknown';
	const v = raw.toLowerCase();
	if (v === 'running') return 'running';
	if (v === 'stopped') return 'stopped';
	if (v === 'starting' || v === 'restarting') return 'starting';
	return 'unknown';
}

export function serviceKeyFromName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function normalizeDiscovered(entry: DumbProcessEntry): DiscoveredService | null {
	const processName = entry.process_name ?? entry.name;
	if (!processName) return null;
	const update = entry.update_status;
	return {
		key: entry.config_key ?? entry.key ?? serviceKeyFromName(processName),
		name: entry.name ?? processName,
		processName,
		enabled: entry.enabled !== false,
		version: entry.version ?? null,
		repoUrl: typeof entry.repo_url === 'string' ? entry.repo_url : null,
		updateStatus: update
			? {
					status: update.status ?? 'unknown',
					currentVersion: update.current_version ?? null,
					availableVersion: update.available_version ?? null
				}
			: null
	};
}

export function normalizeRestart(raw: DumbServiceStatus['restart']): RestartState | null {
	if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) return null;
	const r = raw as NonNullable<DumbServiceStatus['restart']>;
	return {
		attempts: asNumber(r.restart_attempts) ?? 0,
		successes: asNumber(r.restart_successes) ?? 0,
		failures: asNumber(r.restart_failures) ?? 0,
		recentAttempts: asNumber(r.recent_restart_attempts) ?? 0,
		pending: r.pending === true,
		nextRestartTime: toEpochMs(r.next_restart_time),
		disabled: r.disabled === true,
		lastRestartTime: toEpochMs(r.last_restart_time),
		lastFailureReason: typeof r.last_failure_reason === 'string' ? r.last_failure_reason : null,
		lastExitTime: toEpochMs(r.last_exit_time),
		lastExitReason: typeof r.last_exit_reason === 'string' ? r.last_exit_reason : null,
		unhealthyCount: asNumber(r.unhealthy_count) ?? 0,
		unhealthyThreshold: asNumber(r.unhealthy_threshold)
	};
}

export function normalizeHealthDetails(raw: unknown): HealthDetails | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const details: HealthDetails = {};
	if (typeof r.probe === 'string') details.probe = r.probe;
	if (typeof r.endpoint === 'string') details.endpoint = r.endpoint;
	if (typeof r.supported === 'boolean') details.supported = r.supported;
	const http = asNumber(r.http_status);
	if (http !== null) details.httpStatus = http;
	if (typeof r.reported_status === 'string') details.reportedStatus = r.reported_status;
	const latency = asNumber(r.latency_ms) ?? asNumber(r.latency);
	if (latency !== null) details.latencyMs = latency;
	if (Array.isArray(r.ports)) {
		details.ports = r.ports.map((p) => asNumber(p)).filter((p): p is number => p !== null);
	}
	const components = r.components ?? r.component_states;
	if (components && typeof components === 'object' && !Array.isArray(components)) {
		details.components = Object.entries(components as Record<string, unknown>)
			.slice(0, 20)
			.map(([name, state]) => ({ name, state: String(state) }));
	}
	return Object.keys(details).length > 0 ? details : null;
}

export function normalizeServiceStatus(
	status: DumbServiceStatus,
	discovered?: Map<string, DiscoveredService>
): ServiceStatus | null {
	const processName = status.process_name;
	if (!processName) return null;
	const info = discovered?.get(processName);
	return {
		key: info?.key ?? serviceKeyFromName(processName),
		name: info?.name ?? processName,
		processName,
		enabled: info?.enabled ?? true,
		runState: normalizeRunState(status.status),
		health: normalizeHealthStatus(status.health_status, status.healthy),
		healthReason: typeof status.health_reason === 'string' ? status.health_reason : null,
		healthDetails: normalizeHealthDetails(status.health_details),
		restart: normalizeRestart(status.restart),
		cpuPercent: null,
		memoryBytes: null,
		pid: null,
		observedAt: Date.now()
	};
}

function normalizeFilesystems(
	raw: DumbFilesystem[] | undefined,
	legacyDisk: DumbMetricsSnapshot['system']
): FilesystemMetric[] {
	const out: FilesystemMetric[] = [];
	for (const fs of raw ?? []) {
		const path = fs.path;
		if (!path) continue;
		out.push({
			path,
			totalBytes: asNumber(fs.total) ?? 0,
			usedBytes: asNumber(fs.used) ?? 0,
			freeBytes: asNumber(fs.free) ?? 0,
			percent: asNumber(fs.percent) ?? 0,
			inodePercent: asNumber(fs.inode_percent)
		});
	}
	if (out.length === 0 && legacyDisk?.disk && legacyDisk.disk.path) {
		const d = legacyDisk.disk;
		out.push({
			path: d.path ?? '/',
			totalBytes: asNumber(d.total) ?? 0,
			usedBytes: asNumber(d.used) ?? 0,
			freeBytes: asNumber(d.free) ?? 0,
			percent: asNumber(d.percent) ?? 0,
			inodePercent: asNumber(legacyDisk.inode?.percent)
		});
	}
	return out;
}

function normalizeNetwork(
	raw: DumbNetworkInterface[] | undefined,
	legacyNet: DumbMetricsSnapshot['system']
): {
	network: NetworkInterfaceMetric[];
	totals: MetricsSnapshot['networkTotals'];
} {
	const network: NetworkInterfaceMetric[] = [];
	for (const nic of raw ?? []) {
		if (!nic.name) continue;
		network.push({
			name: nic.name,
			sentBytes: asNumber(nic.sent_bytes) ?? 0,
			recvBytes: asNumber(nic.recv_bytes) ?? 0,
			sentRate: asNumber(nic.sent_rate),
			recvRate: asNumber(nic.recv_rate)
		});
	}
	const totals =
		legacyNet?.net_io &&
		(asNumber(legacyNet.net_io.sent_bytes) !== null ||
			asNumber(legacyNet.net_io.recv_bytes) !== null)
			? {
					sentBytes: asNumber(legacyNet.net_io.sent_bytes) ?? 0,
					recvBytes: asNumber(legacyNet.net_io.recv_bytes) ?? 0
				}
			: null;
	return { network, totals };
}

function normalizeProcesses(lists: (DumbProcessMetric[] | undefined)[]): ProcessMetric[] {
	const out: ProcessMetric[] = [];
	for (const list of lists) {
		for (const proc of list ?? []) {
			const name = proc.name ?? proc.process_name;
			if (!name) continue;
			out.push({
				name,
				pid: asNumber(proc.pid),
				cpuPercent: asNumber(proc.cpu_percent),
				memoryBytes: asNumber(proc.rss)
			});
		}
	}
	return out;
}

export function normalizeMetrics(raw: DumbMetricsSnapshot): MetricsSnapshot {
	const system = raw.system ?? {};
	const mem = system.mem;
	const { network, totals } = normalizeNetwork(system.network_interfaces, system);
	return {
		timestamp: toEpochMs(raw.timestamp) ?? Date.now(),
		receivedAt: Date.now(),
		cpuPercent: asNumber(system.cpu_percent),
		cpuCount: asNumber(system.cpu_count),
		loadAvg:
			Array.isArray(system.load_avg) && system.load_avg.length >= 3
				? [system.load_avg[0]!, system.load_avg[1]!, system.load_avg[2]!]
				: null,
		memory:
			mem && asNumber(mem.total)
				? {
						totalBytes: asNumber(mem.total) ?? 0,
						usedBytes: asNumber(mem.used) ?? 0,
						percent: asNumber(mem.percent) ?? 0
					}
				: null,
		filesystems: normalizeFilesystems(system.filesystems, system),
		network,
		networkTotals: totals,
		processes: normalizeProcesses([raw.dumb_managed, raw.external]),
		databaseHealth: Object.entries(raw.database_health ?? {})
			.filter(([name]) => Boolean(name))
			.map(([name, obs]) => ({
				processName: name,
				healthy: typeof obs?.healthy === 'boolean' ? obs.healthy : null,
				reason: typeof obs?.reason === 'string' ? obs.reason : null,
				observedAt: toEpochMs(obs?.timestamp) ?? Date.now()
			}))
	};
}
