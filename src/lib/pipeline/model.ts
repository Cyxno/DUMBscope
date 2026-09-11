/**
 * PipelineViewModel: the single presentation layer that turns live topology
 * domain data into the user-facing media pipeline (stages, friendly names,
 * honest statuses, stage-to-stage flow).
 *
 * Everything user-facing that talks about "the pipeline" — the Pipeline page
 * (desktop + mobile renderers), the Overview mini pipeline and the Services
 * grouping — projects from this model. Domain data (TopologyGraph) stays
 * untouched; no mapping logic lives in Svelte templates.
 */
import type { PipelineCategory, TopologyNode } from '$lib/types';
import { matchCatalog } from '$lib/shared/catalog';

/** User-facing stages, in flow order. Supporting sits beside the flow. */
export const PIPELINE_STAGES = [
	'requests',
	'automation',
	'acquisition',
	'storage',
	'media'
] as const;

export type PipelineFlowStage = (typeof PIPELINE_STAGES)[number];
export type PipelineStageId = PipelineFlowStage | 'supporting' | 'infrastructure';

/**
 * Semantic UI status. `running` means: process is up, but no deep health
 * probe reported — shown as a quiet neutral state, never as a warning.
 * `affected` is presentation-only: a healthy service downstream of a root
 * cause. See docs/design-system.md ("One shared semantic status model").
 */
export type PipelineStatus =
	'healthy' | 'running' | 'degraded' | 'critical' | 'offline' | 'affected' | 'stale';

export interface PipelineService {
	key: string;
	/** Canonical user-facing name — never truncated, never a raw identifier. */
	name: string;
	/** Instance qualifier (e.g. "RealDebrid"), only when meaningful. */
	instanceLabel: string | null;
	descriptor: string;
	stage: PipelineStageId;
	status: PipelineStatus;
	/** Part of DUMB's managed registry (the services the hero counts). */
	managed: boolean;
	running: boolean;
	/** Explicitly stopped (a real state) — as opposed to never reported. */
	stopped: boolean;
	infrastructure: boolean;
}

export interface PipelineStage {
	id: PipelineStageId;
	label: string;
	description: string;
	/** Worst service status inside the stage; null when the stage is empty. */
	status: PipelineStatus | null;
	/** True when the stage is downstream of an unresolved root cause. */
	affected: boolean;
	services: PipelineService[];
	/** Known services in this stage that are configured but never reported. */
	notRunning: PipelineService[];
}

export interface PipelineConnection {
	from: PipelineStageId;
	to: PipelineStageId;
	status: 'flowing' | 'degraded' | 'broken';
}

export interface PipelineModel {
	stages: PipelineStage[];
	supporting: PipelineStage | null;
	infrastructure: PipelineService[];
	/** Stage-to-stage trunk, only between non-empty stages. */
	connections: PipelineConnection[];
	stale: boolean;
	/** Correlated root cause driving the failure presentation, if any. */
	rootCause: { key: string; name: string; stage: PipelineFlowStage } | null;
}

export interface PipelineModelInput {
	nodes: TopologyNode[];
	/** Keys of DUMB's managed registry (the services counted in the hero). */
	managedKeys?: string[];
	/** True when live telemetry is stale/disconnected: keep last-known data. */
	stale?: boolean;
	/**
	 * Service keys flagged as likely root cause by incident correlation.
	 * Matched against key or name (the engine stores either form).
	 */
	rootCauseKeys?: string[];
}

const STAGE_LABELS: Record<PipelineStageId, string> = {
	requests: 'Requests',
	automation: 'Automation',
	acquisition: 'Acquisition',
	storage: 'Storage',
	media: 'Media',
	supporting: 'Supporting',
	infrastructure: 'Infrastructure'
};

const STAGE_DESCRIPTIONS: Record<PipelineStageId, string> = {
	requests: 'What to watch',
	automation: 'Wants, upgrades, indexers',
	acquisition: 'Getting the files',
	storage: 'Cloud storage & mounts',
	media: 'Playback',
	supporting: 'Helps the pipeline along',
	infrastructure: 'Platform processes'
};

/** Central category → stage mapping (user-facing, tested). */
export function stageForCategory(category: PipelineCategory): PipelineStageId {
	switch (category) {
		case 'request':
			return 'requests';
		case 'manager':
		case 'indexer':
		case 'discovery':
			return 'automation';
		case 'debrid':
		case 'usenet':
		case 'import':
		case 'acquisition':
			return 'acquisition';
		case 'bridge':
		case 'mount':
		case 'storage':
			return 'storage';
		case 'media-server':
			return 'media';
		case 'subtitles':
		case 'analytics':
		case 'auxiliary':
			return 'supporting';
		case 'core':
		case 'database':
			return 'infrastructure';
	}
}

/** Status wording — one vocabulary for the whole UI. */
export function pipelineStatusLabel(status: PipelineStatus): string {
	switch (status) {
		case 'healthy':
			return 'Healthy';
		case 'running':
			return 'Running';
		case 'degraded':
			return 'Degraded';
		case 'critical':
			return 'Unhealthy';
		case 'offline':
			return 'Not running';
		case 'affected':
			return 'May be affected';
		case 'stale':
			return 'Stale';
	}
}

/** User-facing stage label ("Requests"), central copy. */
export function pipelineStageLabel(id: PipelineStageId): string {
	return STAGE_LABELS[id];
}

function titleCase(value: string): string {
	return value
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');
}

const INSTANCE_SUFFIX = /\s+instances?\s+(.+)$/i;

function friendlyIdentity(node: TopologyNode): { name: string; instanceLabel: string | null } {
	const entry = matchCatalog(node.name, node.key);
	const match = node.name.match(INSTANCE_SUFFIX);
	const rawBase = (match ? node.name.slice(0, match.index) : node.name).replace(/_/g, ' ').trim();
	const name = entry?.displayName ?? (titleCase(rawBase) || node.name);
	let instanceLabel: string | null = null;
	const rawInstance = match?.[1]?.trim();
	// Keep the source casing ("RealDebrid" stays as reported).
	if (rawInstance && rawInstance.toLowerCase() !== 'default') {
		instanceLabel = rawInstance;
	}
	return { name, instanceLabel };
}

/** Derive the semantic status from the raw process + health state. */
export function pipelineStatusFor(node: Pick<TopologyNode, 'health' | 'runState'>): PipelineStatus {
	if (node.health === 'unhealthy') return 'critical';
	if (node.health === 'degraded' || node.health === 'starting') return 'degraded';
	if (node.health === 'healthy') return node.runState === 'running' ? 'healthy' : 'offline';
	// No health report: a running process is fine, just unverified. Anything
	// not running (stopped or never reported) is offline/not running.
	return node.runState === 'running' || node.runState === 'starting' ? 'running' : 'offline';
}

const STATUS_RANK: Record<PipelineStatus, number> = {
	critical: 0,
	offline: 1,
	degraded: 2,
	affected: 3,
	stale: 4,
	running: 5,
	healthy: 6
};

export function worstStatus(statuses: PipelineStatus[]): PipelineStatus | null {
	if (statuses.length === 0) return null;
	return statuses.reduce((worst, s) => (STATUS_RANK[s] < STATUS_RANK[worst] ? s : worst));
}

export function buildPipelineModel(input: PipelineModelInput): PipelineModel {
	const managedKeys = new Set(input.managedKeys ?? []);
	// Defensive: malformed upstream data must never produce duplicate DOM keys.
	const unique = new Map<string, TopologyNode>();
	for (const node of input.nodes) {
		if (!unique.has(node.key)) unique.set(node.key, node);
	}
	const nodes = [...unique.values()];

	// Friendly identities first so multi-instance groups can be labelled.
	const identities = new Map<string, { name: string; instanceLabel: string | null }>();
	for (const node of nodes) {
		identities.set(node.key, friendlyIdentity(node));
	}
	// Same canonical name more than once → always qualify instances.
	const nameCounts = new Map<string, number>();
	for (const node of nodes) {
		const { name } = identities.get(node.key)!;
		nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
	}
	const ordinal = new Map<string, number>();
	for (const node of nodes) {
		const identity = identities.get(node.key)!;
		if ((nameCounts.get(identity.name) ?? 0) > 1 && !identity.instanceLabel) {
			const n = (ordinal.get(identity.name) ?? 0) + 1;
			ordinal.set(identity.name, n);
			identity.instanceLabel = `Instance ${n}`;
		}
	}

	const services: PipelineService[] = nodes.map((node) => {
		const identity = identities.get(node.key)!;
		const entry = matchCatalog(node.name, node.key);
		const running = node.runState === 'running' || node.runState === 'starting';
		let stage = stageForCategory(node.category);
		let infrastructure = stage === 'infrastructure';
		// Known platform components (catalog "core") are infrastructure even
		// when DUMB's discovery tags them as plain auxiliary processes.
		if (entry && entry.category === 'core') {
			stage = 'infrastructure';
			infrastructure = true;
		}
		// Never-running entries that are not managed and not from a known
		// adapter are catalog noise (installed-but-unused components).
		if (!running && !managedKeys.has(node.key) && !entry) {
			infrastructure = true;
			stage = 'infrastructure';
		}
		const descriptor =
			entry?.descriptor ?? (managedKeys.has(node.key) ? 'Managed service' : 'Service');
		return {
			key: node.key,
			name: identity.name,
			instanceLabel: identity.instanceLabel,
			descriptor,
			stage,
			status: pipelineStatusFor(node),
			managed: managedKeys.has(node.key),
			running,
			stopped: node.runState === 'stopped',
			infrastructure
		};
	});

	// Failure propagation: a root cause stops the flow at its stage.
	let rootCause: PipelineModel['rootCause'] = null;
	const byKey = new Map(services.map((s) => [s.key, s]));
	const byName = new Map(services.map((s) => [s.name.toLowerCase(), s]));
	for (const key of input.rootCauseKeys ?? []) {
		const svc = byKey.get(key) ?? byName.get(key.toLowerCase());
		if (svc && (PIPELINE_STAGES as readonly string[]).includes(svc.stage)) {
			svc.status = 'critical';
			rootCause = { key: svc.key, name: svc.name, stage: svc.stage as PipelineFlowStage };
			break;
		}
	}

	const rootStageIndex = rootCause ? PIPELINE_STAGES.indexOf(rootCause.stage) : -1;
	const affectedStages = new Set<PipelineFlowStage>(
		rootStageIndex >= 0 ? PIPELINE_STAGES.slice(rootStageIndex + 1) : []
	);
	if (input.stale) {
		for (const svc of services) svc.status = 'stale';
	} else if (affectedStages.size > 0) {
		for (const svc of services) {
			if (affectedStages.has(svc.stage as PipelineFlowStage) && svc.status === 'healthy') {
				svc.status = 'affected';
			}
		}
	}

	// Deterministic card ordering policy: friendly name, then stable key —
	// identical input always renders in identical order (no insertion-order luck).
	const byNameKey = (a: PipelineService, b: PipelineService) =>
		a.name.localeCompare(b.name) || a.key.localeCompare(b.key);

	function makeStage(id: PipelineStageId, group: PipelineService[]): PipelineStage {
		// "Simple" stages show live services plus explicitly stopped ones;
		// never-reported entries stay out (counted, visible in detailed mode).
		const visible = group.filter((s) => s.running || s.stopped).sort(byNameKey);
		const notRunning = group.filter((s) => !s.running && !s.stopped).sort(byNameKey);
		return {
			id,
			label: STAGE_LABELS[id],
			description: STAGE_DESCRIPTIONS[id],
			status: worstStatus(visible.map((s) => s.status)),
			affected: affectedStages.has(id as PipelineFlowStage),
			services: visible,
			notRunning
		};
	}

	const byStage = new Map<PipelineStageId, PipelineService[]>();
	for (const svc of services) {
		if (svc.infrastructure) continue;
		const list = byStage.get(svc.stage) ?? [];
		list.push(svc);
		byStage.set(svc.stage, list);
	}

	const stages = (PIPELINE_STAGES as readonly PipelineFlowStage[])
		.map((id) => makeStage(id, byStage.get(id) ?? []))
		.filter((stage) => stage.services.length > 0);

	const supportingGroup = byStage.get('supporting') ?? [];
	const supporting = supportingGroup.length > 0 ? makeStage('supporting', supportingGroup) : null;

	const infrastructure = services
		.filter((s) => s.infrastructure)
		.sort((a, b) => a.name.localeCompare(b.name));

	const connections: PipelineConnection[] = [];
	for (let i = 0; i + 1 < stages.length; i++) {
		const from = stages[i]!;
		const to = stages[i + 1]!;
		let status: PipelineConnection['status'] = 'flowing';
		if (rootCause && from.id === rootCause.stage) status = 'broken';
		else if (
			(from.status && STATUS_RANK[from.status] <= STATUS_RANK.degraded) ||
			(to.status && STATUS_RANK[to.status] <= STATUS_RANK.degraded)
		)
			status = 'degraded';
		connections.push({ from: from.id, to: to.id, status });
	}

	return {
		stages,
		supporting,
		infrastructure,
		connections,
		stale: Boolean(input.stale),
		rootCause
	};
}
