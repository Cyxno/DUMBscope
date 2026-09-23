/**
 * Observability API response tests (observability spec §14): the three
 * read-only endpoints answer with the documented payload shapes, degrade
 * honestly when no cgroup source is configured and serve the timeline.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as observability } from '../src/routes/api/observability/+server';
import { GET as history } from '../src/routes/api/observability/history/+server';
import { GET as timeline } from '../src/routes/api/observability/timeline/+server';
import { getHub, resetHub } from '../src/lib/server/telemetry/hub';
import { recordObservabilityEvent } from '../src/lib/server/reliability/timeline';
import { getDb } from '../src/lib/server/database/db';
import type { ObservabilitySnapshot } from '$lib/types';

function url(query: Record<string, string> = {}): URL {
	const u = new URL('http://localhost/api/x');
	for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
	return u;
}

afterAll(() => {
	resetHub();
});

describe('GET /api/observability', () => {
	it('answers with the full payload and degrades honestly without a cgroup source', async () => {
		getHub(); // unconfigured hub: no DUMB, no integrations
		const response = await observability({ url: url() } as never);
		expect(response.status).toBe(200);
		const body = (await response.json()) as ObservabilitySnapshot;
		expect(body.cgroup).toBeTruthy();
		expect(body.cgroup.source).toBeNull();
		expect(body.cgroup.unavailableReason).toBeTruthy();
		expect(Array.isArray(body.services)).toBe(true);
		expect(Array.isArray(body.baselineShifts)).toBe(true);
		expect(body.infiniDysk.available).toBe(false);
		expect(body.infiniDysk.unavailableReason).toBeTruthy();
		expect(Array.isArray(body.thermal.zones)).toBe(true);
		expect(Array.isArray(body.ars)).toBe(true);
		expect(body.routing.clients).toEqual([]);
		expect(body.routing.preferredProtocol).toEqual({ sonarr: null, radarr: null });
		expect(Array.isArray(body.versions)).toBe(true);
	});
});

describe('GET /api/observability/history', () => {
	it('bounds the window and returns chart-ready arrays', async () => {
		const response = await history({ url: url({ hours: '24' }) } as never);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			hours: number;
			cgroup: unknown[];
			thermal: unknown[];
		};
		expect(body.hours).toBe(24);
		expect(Array.isArray(body.cgroup)).toBe(true);
		expect(Array.isArray(body.thermal)).toBe(true);
	});
});

describe('GET /api/observability/timeline', () => {
	beforeEach(() => {
		try {
			getDb().prepare('DELETE FROM observability_events').run();
		} catch {
			// isolated
		}
	});

	it('serves recorded events with kind filtering and stats', async () => {
		const now = Date.now();
		recordObservabilityEvent({
			at: now,
			kind: 'repair-loop',
			service: 'infinidysk',
			title: 'repair started: a.mkv'
		});
		recordObservabilityEvent({ at: now - 60_000, kind: 'deploy', title: 'Sonarr 4.0.19 → 4.0.20' });

		const all = await timeline({ url: url({ hours: '24' }) } as never);
		expect(all.status).toBe(200);
		const allBody = (await all.json()) as {
			events: { kind: string; title: string }[];
			stats: { rows: number };
		};
		expect(allBody.events).toHaveLength(2);
		expect(allBody.events[0]!.title).toBe('repair started: a.mkv'); // newest first
		expect(allBody.stats.rows).toBe(2);

		const filtered = await timeline({ url: url({ hours: '24', kinds: 'deploy' }) } as never);
		const filteredBody = (await filtered.json()) as { events: { kind: string }[] };
		expect(filteredBody.events).toHaveLength(1);
		expect(filteredBody.events[0]!.kind).toBe('deploy');
	});

	it('answers an empty timeline cleanly', async () => {
		const response = await timeline({ url: url({ hours: '1', limit: '10' }) } as never);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { events: unknown[]; stats: { rows: number } };
		expect(body.events).toEqual([]);
		expect(body.stats.rows).toBe(0);
	});
});
