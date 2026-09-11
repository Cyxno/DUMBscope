/**
 * Bridges the live SSE store to the PipelineViewModel. This is the ONE place
 * that converts live app state into model input, so the Pipeline page, the
 * Overview summary and the Services grouping always draw the same story.
 */
import { live } from '$lib/stores/live.svelte';
import {
	buildPipelineModel,
	stageForCategory,
	type PipelineModel,
	type PipelineService
} from './model';
import type { TopologyNode } from '$lib/types';

/**
 * Query params understood as read-only presentation overrides for QA:
 * `?demo=failure` renders the InfiniDysk-failure story, `?demo=stale` the
 * disconnected/stale story. They never touch data, only this tab's rendering.
 */
export type PipelineDemo = 'failure' | 'stale' | null;

export function pipelineDemoFromUrl(url: URL): PipelineDemo {
	const value = url.searchParams.get('demo');
	return value === 'failure' || value === 'stale' ? value : null;
}

export function pipelineModelFromLive(demo: PipelineDemo = null): PipelineModel {
	const nodes: TopologyNode[] = live.topology.nodes;
	let stale = live.feed !== 'live';
	let rootCauseKeys: string[] = live.activeIncidents
		.map((incident) => incident.rootCauseService)
		.filter((value): value is string => Boolean(value));

	if (demo === 'failure') {
		const infiny = nodes.find((n) => /infini\s?dysk/i.test(n.key + ' ' + n.name));
		const storageFallback = nodes.find((n) => stageForCategory(n.category) === 'storage');
		const target = infiny ?? storageFallback;
		if (target) rootCauseKeys = [target.key];
		stale = false;
	} else if (demo === 'stale') {
		stale = true;
		rootCauseKeys = [];
	}

	return buildPipelineModel({
		nodes,
		managedKeys: live.services.map((service) => service.key),
		stale,
		rootCauseKeys
	});
}

/** Fast lookup: pipeline identity + stage for one service key. */
export function pipelineMetaForKey(model: PipelineModel, key: string): PipelineService | null {
	for (const stage of [...model.stages, model.supporting]) {
		if (!stage) continue;
		const found = [...stage.services, ...stage.notRunning].find((s) => s.key === key);
		if (found) return found;
	}
	for (const svc of model.infrastructure) if (svc.key === key) return svc;
	return null;
}
