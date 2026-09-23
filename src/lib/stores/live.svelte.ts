/**
 * Client-side live state, fed by the single SSE stream (`/api/stream`).
 *
 * One EventSource per tab; the server fans out from its shared DUMB
 * connection. All buffers are capped so a log flood or long session cannot
 * grow memory without bound.
 */
import type {
	ConnectionSnapshot,
	DiscoveredService,
	Incident,
	IncidentCounts,
	LogLine,
	MediaFlowSnapshot,
	MetricsHistoryPoint,
	MetricsSnapshot,
	ObservabilitySnapshot,
	RemediationActionView,
	ReliabilitySnapshot,
	ServiceStatus,
	StackOverview,
	TopologyGraph
} from '$lib/types';

const MAX_LOG_LINES = 3000;

export type FeedState = 'connecting' | 'live' | 'reconnecting' | 'stale';

function defaults(): ConnectionSnapshot {
	return {
		state: 'connecting',
		streams: {
			rest: 'connecting',
			status: 'connecting',
			metrics: 'connecting',
			logs: 'connecting'
		},
		lastUpdateAt: null,
		lastSuccessAt: null,
		connectedSince: null,
		stateSince: Date.now(),
		lastError: null,
		reconnectAttempts: 0,
		dumbVersion: null,
		authMode: 'unknown',
		probes: {
			http: { status: 'unknown', code: null, detail: null, at: null, okAt: null },
			auth: { status: 'unknown', code: null, detail: null, at: null, okAt: null },
			rest: { status: 'unknown', code: null, detail: null, at: null, okAt: null }
		}
	};
}

class LiveStore {
	connection = $state<ConnectionSnapshot>(defaults());
	services = $state<ServiceStatus[]>([]);
	discovered = $state<DiscoveredService[]>([]);
	overview = $state<StackOverview>({
		health: 'unknown',
		servicesOnline: 0,
		servicesDegraded: 0,
		servicesUnhealthy: 0,
		servicesStopped: 0,
		servicesTotal: 0,
		activeIncidents: 0,
		criticalIncidents: 0
	});
	metrics = $state<MetricsSnapshot | null>(null);
	metricsHistory = $state<MetricsHistoryPoint[]>([]);
	/** Rolling per-service CPU series for card sparklines. */
	cpuSeries = $state<Record<string, number[]>>({});
	logs = $state<LogLine[]>([]);
	activeIncidents = $state<Incident[]>([]);
	/** Header badges: open problems by state plus resolved history size. */
	incidentCounts = $state<IncidentCounts>({ active: 0, acknowledged: 0, resolved: 0 });
	topology = $state<TopologyGraph>({ nodes: [], edges: [] });
	reliability = $state<ReliabilitySnapshot>({
		mounts: [],
		memory: [],
		stats: { mountRounds: 0, fsCalls: 0, lastRoundMs: null, memoryTracked: 0 }
	});
	mediaFlow = $state<
		MediaFlowSnapshot & {
			recommendations: RemediationActionView[];
			actions: RemediationActionView[];
		}
	>({
		generatedAt: 0,
		items: [],
		metrics: {
			repeatedRequests24h: 0,
			activeMediaMismatches: 0,
			resolvedMediaMismatches: 0,
			propagation: { samples: 0, medianMs: null, p95Ms: null }
		},
		recommendations: [],
		actions: []
	});
	/** Deep DUMB observability (cgroup, per-service memory, InfiniDysk, …). */
	observability = $state<ObservabilitySnapshot | null>(null);
	capabilities = $state<Record<string, unknown>>({});
	version = $state<string | null>(null);
	feed = $state<FeedState>('connecting');
	lastEventAt = $state<number>(Date.now());

	#source: EventSource | null = null;
	#staleTimer: ReturnType<typeof setInterval> | null = null;
	#started = false;

	start(): void {
		if (this.#started || typeof window === 'undefined') return;
		this.#started = true;
		this.#connect();
		this.#staleTimer ??= setInterval(() => {
			if (this.feed === 'live' && Date.now() - this.lastEventAt > 45_000) {
				this.feed = 'stale';
			}
		}, 10_000);
	}

	stop(): void {
		this.#source?.close();
		this.#source = null;
		this.#started = false;
		if (this.#staleTimer) {
			clearInterval(this.#staleTimer);
			this.#staleTimer = null;
		}
	}

	reconnect(): void {
		this.#source?.close();
		this.#source = null;
		this.#started = false;
		this.start();
	}

	#connect(): void {
		this.feed = this.#source ? 'reconnecting' : 'connecting';
		const source = new EventSource('/api/stream');
		this.#source = source;

		source.onopen = () => {
			this.feed = 'live';
			this.lastEventAt = Date.now();
		};
		source.onerror = () => {
			// EventSource retries automatically; reflect it in the UI.
			this.feed = source.readyState === EventSource.CLOSED ? 'reconnecting' : 'connecting';
		};
		source.onmessage = () => {
			this.lastEventAt = Date.now();
		};

		const on = <T>(event: string, handler: (data: T) => void) => {
			source.addEventListener(event, (evt) => {
				this.lastEventAt = Date.now();
				if (this.feed !== 'live' && source.readyState === EventSource.OPEN) this.feed = 'live';
				try {
					handler(JSON.parse((evt as MessageEvent).data) as T);
				} catch {
					// Malformed payload: skip.
				}
			});
		};

		on<{ version: string; capabilities: Record<string, unknown> }>('hello', (data) => {
			this.version = data.version;
			this.capabilities = data.capabilities ?? {};
		});
		on<ConnectionSnapshot>('connection', (data) => {
			this.connection = data;
		});
		on<{
			services: ServiceStatus[];
			discovered: DiscoveredService[];
			overview: StackOverview;
		}>('services', (data) => {
			this.services = data.services;
			this.discovered = data.discovered;
			this.overview = data.overview;
			this.#updateCpuSeries(data.services);
		});
		on<MetricsSnapshot>('metrics', (data) => {
			this.metrics = data;
			this.#pushHistoryPoint({
				t: data.timestamp,
				cpu: data.cpuPercent,
				mem: data.memory?.percent ?? null,
				disk: data.filesystems[0]?.percent ?? null
			});
		});
		on<{ points: MetricsHistoryPoint[] }>('metricsHistory', (data) => {
			this.metricsHistory = data.points;
		});
		on<{ lines: LogLine[] }>('logs', (data) => {
			this.logs = data.lines.slice(-MAX_LOG_LINES);
		});
		on<LogLine>('log', (line) => {
			this.logs.push(line);
			if (this.logs.length > MAX_LOG_LINES) {
				this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
			}
		});
		on<{ active: Incident[] }>('incidents', (data) => {
			this.activeIncidents = data.active;
			this.incidentCounts = {
				active: data.active.filter((i) => i.status === 'active').length,
				acknowledged: data.active.filter((i) => i.status === 'acknowledged').length,
				resolved: this.incidentCounts.resolved
			};
		});
		on<Incident>('incident', (incident) => {
			const open = incident.status === 'active' || incident.status === 'acknowledged';
			const idx = this.activeIncidents.findIndex((i) => i.id === incident.id);
			if (open) {
				if (idx >= 0) this.activeIncidents[idx] = incident;
				else this.activeIncidents.push(incident);
			} else if (idx >= 0) {
				this.activeIncidents.splice(idx, 1);
				if (incident.status === 'resolved') this.incidentCounts.resolved++;
			}
			this.incidentCounts = {
				active: this.activeIncidents.filter((i) => i.status === 'active').length,
				acknowledged: this.activeIncidents.filter((i) => i.status === 'acknowledged').length,
				resolved: this.incidentCounts.resolved
			};
			this.overview = {
				...this.overview,
				activeIncidents: this.activeIncidents.length,
				criticalIncidents: this.activeIncidents.filter((i) => i.severity === 'critical').length
			};
		});
		on<TopologyGraph>('topology', (data) => {
			this.topology = data;
		});
		on<ReliabilitySnapshot>('reliability', (data) => {
			this.reliability = data;
		});
		on<
			MediaFlowSnapshot & {
				recommendations: RemediationActionView[];
				actions: RemediationActionView[];
			}
		>('mediaFlow', (data) => {
			this.mediaFlow = data;
		});
		on<ObservabilitySnapshot>('observability', (data) => {
			this.observability = data;
		});
	}

	#pushHistoryPoint(point: MetricsHistoryPoint): void {
		// The server also pushes a history snapshot on connect; append live points
		// after that and cap at ~30 minutes locally.
		this.metricsHistory.push(point);
		if (this.metricsHistory.length > 1800) {
			this.metricsHistory.splice(0, this.metricsHistory.length - 1800);
		}
	}

	#updateCpuSeries(services: ServiceStatus[]): void {
		const next: Record<string, number[]> = { ...this.cpuSeries };
		for (const service of services) {
			const series = next[service.key] ?? [];
			if (service.cpuPercent !== null) {
				series.push(service.cpuPercent);
				if (series.length > 40) series.splice(0, series.length - 40);
				next[service.key] = [...series];
			}
		}
		this.cpuSeries = next;
	}

	serviceCpuSeries(key: string): number[] {
		return this.cpuSeries[key] ?? [];
	}

	serviceByKey(key: string): ServiceStatus | undefined {
		return this.services.find((s) => s.key === key);
	}
}

export const live = new LiveStore();
