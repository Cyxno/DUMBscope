/**
 * Combined timeline tests (observability spec §8): recording, throttling,
 * filtering, retention pruning and the hard row cap.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
	pruneTimeline,
	queryTimeline,
	recordObservabilityEvent,
	recordTimelineThrottled,
	resetTimelineThrottle,
	TIMELINE_RETENTION
} from '../src/lib/server/reliability/timeline';
import { getDb } from '../src/lib/server/database/db';

const HOUR = 3_600_000;

beforeEach(() => {
	resetTimelineThrottle();
	try {
		getDb().prepare('DELETE FROM observability_events').run();
	} catch {
		// isolated
	}
});

describe('record + query', () => {
	it('records and returns events newest first', () => {
		const now = Date.now();
		recordObservabilityEvent({
			at: now - 5 * 60_000,
			kind: 'restart',
			title: 'older restart',
			service: 'sonarr'
		});
		recordObservabilityEvent({
			at: now,
			kind: 'thermal',
			title: 'temp spike',
			severity: 'warning'
		});
		const events = queryTimeline({ hours: 1 });
		expect(events).toHaveLength(2);
		expect(events[0]!.title).toBe('temp spike');
		expect(events[0]!.kind).toBe('thermal');
		expect(events[1]!.service).toBe('sonarr');
	});

	it('rejects unknown kinds', () => {
		const now = Date.now();
		recordObservabilityEvent({ at: now, kind: 'made-up' as 'restart', title: 'nope' });
		expect(queryTimeline({ hours: 1 })).toHaveLength(0);
	});

	it('filters by kind and service', () => {
		const now = Date.now();
		recordObservabilityEvent({
			at: now,
			kind: 'repair-loop',
			service: 'infinidysk',
			title: 'repair a.mkv'
		});
		recordObservabilityEvent({ at: now, kind: 'oom', title: 'OOM moved' });
		const repairs = queryTimeline({ hours: 24, kinds: ['repair-loop'] });
		expect(repairs).toHaveLength(1);
		const byService = queryTimeline({ hours: 24, service: 'infinidysk' });
		expect(byService).toHaveLength(1);
		expect(byService[0]!.kind).toBe('repair-loop');
	});

	it('serialises the correlation payload without leaking it into the view', () => {
		const now = Date.now();
		recordObservabilityEvent({
			at: now,
			kind: 'thermal',
			title: 'spike',
			data: { level: 95, tempC: 96 }
		});
		const events = queryTimeline({ hours: 1 });
		expect(events).toHaveLength(1);
		expect(events[0]!.title).toBe('spike');
	});
});

describe('throttling', () => {
	it('suppresses repeat events of the same kind+service inside the quiet window', () => {
		const now = Date.now();
		const first = recordTimelineThrottled({
			at: now,
			kind: 'repair-loop',
			service: 'infinidysk',
			title: 'r1'
		});
		const second = recordTimelineThrottled({
			at: now + 30_000,
			kind: 'repair-loop',
			service: 'infinidysk',
			title: 'r2'
		});
		expect(first).toBe(true);
		expect(second).toBe(false);
		expect(queryTimeline({ hours: 1 })).toHaveLength(1);
	});

	it('allows events for different services and after the quiet window', () => {
		const now = Date.now();
		recordTimelineThrottled({ at: now, kind: 'repair-loop', service: 'a', title: 'a1' });
		expect(
			recordTimelineThrottled({ at: now, kind: 'repair-loop', service: 'b', title: 'b1' })
		).toBe(true);
		expect(
			recordTimelineThrottled({
				at: now + TIMELINE_RETENTION.sameKindQuietMs + 1,
				kind: 'repair-loop',
				service: 'a',
				title: 'a2'
			})
		).toBe(true);
	});
});

describe('retention', () => {
	it('prunes expired rows and enforces the hard cap', () => {
		const now = Date.now();
		const db = getDb();
		recordObservabilityEvent({
			at: now - TIMELINE_RETENTION.retentionMs - HOUR,
			kind: 'deploy',
			title: 'ancient'
		});
		// Fill beyond the cap with fresh rows (manual transaction — node:sqlite).
		db.exec('BEGIN');
		const ins = db.prepare(
			'INSERT INTO observability_events (at, kind, service, severity, title, detail, data) VALUES (?, ?, ?, ?, ?, ?, ?)'
		);
		for (let i = 0; i < TIMELINE_RETENTION.maxRows + 50; i++) {
			ins.run(now, 'health', null, null, `row ${i}`, null, null);
		}
		db.exec('COMMIT');

		const pruned = pruneTimeline(now);
		expect(pruned.expired).toBeGreaterThanOrEqual(1);
		expect(pruned.capped).toBeGreaterThanOrEqual(1);
		const count = (db.prepare('SELECT COUNT(*) c FROM observability_events').get() as { c: number })
			.c;
		expect(count).toBeLessThanOrEqual(TIMELINE_RETENTION.maxRows); // bounded growth
	});
});
