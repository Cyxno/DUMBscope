import { jsonOk } from '$lib/server/security/validation';
import { queryTimeline, timelineStats } from '$lib/server/reliability/timeline';
import type { TimelineEvent } from '$lib/types';
import type { RequestHandler } from './$types';

const VALID_KINDS: ReadonlySet<TimelineEvent['kind']> = new Set([
	'restart',
	'memory-anomaly',
	'repair-loop',
	'mount',
	'oom',
	'cgroup-high',
	'cgroup-max',
	'thermal',
	'deploy',
	'download-failure',
	'health'
]);

/**
 * Combined DUMB timeline (brief §8): one merged, newest-first feed of
 * restarts, memory anomalies, repair loops, mount failures, OOM, cgroup
 * high/max events, thermal spikes, deploys and download failures. Correlation
 * display only — no causality is claimed and nothing here notifies.
 */
export const GET: RequestHandler = async ({ url }) => {
	const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get('hours') ?? 24)));
	const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 200)));
	const service = url.searchParams.get('service');
	const kindsParam = url.searchParams.get('kinds');
	const kinds = (kindsParam ? kindsParam.split(',') : [])
		.map((k) => k.trim())
		.filter((k): k is TimelineEvent['kind'] => VALID_KINDS.has(k as TimelineEvent['kind']));
	return jsonOk({
		hours,
		kinds: kinds.length > 0 ? kinds : null,
		service,
		events: queryTimeline({ hours, kinds, service, limit }),
		stats: timelineStats()
	});
};
