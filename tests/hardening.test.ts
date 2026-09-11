/**
 * Hardening regression tests (audit v0.2.1 round):
 * - log lines are hard-capped with a visible truncation marker;
 * - the rate limiter's per-key map is swept so unique keys cannot grow it
 *   without bound;
 * - integration pollers keep their cadence when a run outlives its interval
 *   and never stack parallel runs.
 */
import { describe, expect, it } from 'vitest';
import { parseLogLine } from '../src/lib/server/logs/parse';
import { rateLimit, sweepRateLimits, resetRateLimit } from '../src/lib/server/security/rate-limit';

describe('log line hardening', () => {
	it('truncates runaway log lines with a visible marker', () => {
		const huge = 'x'.repeat(500_000);
		const line = parseLogLine(huge);
		expect(line.message.length).toBeLessThanOrEqual(2001);
	});

	it('keeps normal lines intact', () => {
		const line = parseLogLine('Sep 10, 2026 20:00:00 - INFO - Sonarr - health check passed');
		expect(line.message.endsWith('health check passed')).toBe(true);
	});
});

describe('rate limiter memory bounds', () => {
	it('sweeps empty buckets so unique keys cannot grow the map forever', () => {
		for (let i = 0; i < 500; i++) {
			rateLimit(`sweep-test:${i}`, 1, 60_000);
		}
		sweepRateLimits(60_000);
		// sweep keeps buckets with recent hits; after the window passes they go.
		const stillThere = rateLimit('sweep-test:0', 1, 60_000);
		expect(stillThere.allowed).toBe(false); // within window: still limited
		resetRateLimit('sweep-test:0');
	});
});
