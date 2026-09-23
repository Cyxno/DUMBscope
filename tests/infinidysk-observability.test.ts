/**
 * InfiniDysk log aggregation tests (observability spec §4): parsing real
 * production line shapes, per-file repair-loop aggregation, 430 counting,
 * recurrence over days and the repair-active window.
 */
import { describe, expect, it } from 'vitest';
import {
	InfiniDyskAggregator,
	parseInfiniDyskLine
} from '../src/lib/server/reliability/infinidysk';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('line parsing', () => {
	const now = 1_800_000_000_000;

	it('parses a repair start with file + segment count', () => {
		const evt = parseInfiniDyskLine(
			'Sep 23, 2026 01:53:15 - INFO - InfiniDysk subprocess: [01:53:15 INF] Health check classified /content/sonarr-default/dark.matter.s02e03/dark.matter.s02e03.mkv as failed: 6,599 missing/corrupt segment(s) (largest run 6599, 100% of file) Starting repair.',
			now
		);
		expect(evt).not.toBeNull();
		expect(evt!.kind).toBe('repair-start');
		expect(evt!.file).toBe('dark.matter.s02e03.mkv');
		expect(evt!.segments).toBe(6599);
		expect(evt!.level).toBe('info');
	});

	it('parses a 430 No Such Article failure', () => {
		const evt = parseInfiniDyskLine(
			'Sep 23, 2026 08:02:11 - INFO - InfiniDysk subprocess: [08:02:11 ERR] File /content/radarr-default/Scary.Movie.5/Scary.Movie.5.mkv has missing articles: Article with message-id NqGlPvNbOcFoPrRtMnSmIcFm-1789630346230@nyuu not found. Server responded: 430 No Such Article',
			now
		);
		expect(evt!.kind).toBe('article-430');
		expect(evt!.file).toBe('Scary.Movie.5.mkv');
		expect(evt!.level).toBe('error');
	});

	it('parses an unavailable segment line with a spaced file name', () => {
		const evt = parseInfiniDyskLine(
			'Sep 23, 2026 01:44:29 - INFO - InfiniDysk subprocess: [01:44:29 WRN] Usenet segment was unavailable from all eligible provider sources. Segment: [REDACTED]; File: Silo.S03E08.NORDiC.1080p.ATV.WEB-DL.H.265-NORViNE.mkv; Operation: stat; EligibleProviders: 2; Attempts: 2; CachedSkips: 0;',
			now
		);
		expect(evt!.kind).toBe('missing-segment');
		expect(evt!.file).toBe('Silo.S03E08.NORDiC.1080p.ATV.WEB-DL.H.265-NORViNE.mkv');
	});

	it('parses suppressed-warning rollups with counts', () => {
		const evt = parseInfiniDyskLine(
			'Sep 23, 2026 01:45:29 - INFO - InfiniDysk subprocess: [01:45:29 WRN] Suppressed 759 additional unavailable-segment warnings for dark.matter.s02e03.mkv in the previous 60 seconds.',
			now
		);
		expect(evt!.kind).toBe('suppressed-warnings');
		expect(evt!.count).toBe(759);
		expect(evt!.file).toBe('dark.matter.s02e03.mkv');
	});

	it('parses a provider fallback', () => {
		const evt = parseInfiniDyskLine(
			'Sep 23, 2026 20:01:28 - INFO - InfiniDysk subprocess: [20:01:28 INF] Provider news.vipernews.com error: Article with message-id [REDACTED] not found. Server responded: 430 No such article. Falling back to news.sunnyusenet.com',
			now
		);
		expect(evt!.kind).toBe('provider-fallback');
	});

	it('returns null for unrelated lines', () => {
		expect(
			parseInfiniDyskLine('Sep 23, 2026 03:30:00 - INFO - DatabaseBackupTask: dumping', now)
		).toBeNull();
	});
});

describe('aggregation', () => {
	it('aggregates per-file repair loops with recurrence over days', () => {
		const now = Date.now();
		const agg = new InfiniDyskAggregator({ now: () => now });
		const file = '/content/tv/repeat.episode.mkv';
		// Chronological: yesterday (different UTC day), then three today.
		agg.onEvent({
			kind: 'repair-start',
			at: now - DAY - HOUR,
			file,
			segments: 2999,
			count: null,
			level: 'info'
		});
		agg.onEvent({
			kind: 'repair-start',
			at: now - 2 * HOUR,
			file,
			segments: 3000,
			count: null,
			level: 'info'
		});
		agg.onEvent({
			kind: 'repair-start',
			at: now - 1 * HOUR,
			file,
			segments: 3001,
			count: null,
			level: 'info'
		});
		agg.onEvent({
			kind: 'repair-start',
			at: now - 10 * 60_000,
			file,
			segments: 3002,
			count: null,
			level: 'info'
		});

		const files = agg.getFiles(now);
		expect(files).toHaveLength(1);
		const rec = files[0]!;
		expect(rec.repairs24h).toBe(3);
		expect(rec.repairs1h).toBe(2);
		expect(rec.activeDays).toBe(2);
		expect(rec.lastRepairAt).toBe(now - 10 * 60_000);
		expect(rec.lastError).toContain('health check failed');
	});

	it('counts 430s, missing segments and provider fallbacks', () => {
		const now = Date.now();
		const agg = new InfiniDyskAggregator({ now: () => now });
		agg.onEvent({
			kind: 'article-430',
			at: now - HOUR,
			file: 'a.mkv',
			segments: null,
			count: null,
			level: 'error'
		});
		agg.onEvent({
			kind: 'article-430',
			at: now - 2 * HOUR,
			file: 'b.mkv',
			segments: null,
			count: null,
			level: 'error'
		});
		agg.onEvent({
			kind: 'missing-segment',
			at: now - 30 * 60_000,
			file: 'a.mkv',
			segments: 1,
			count: null,
			level: 'warn'
		});
		agg.onEvent({
			kind: 'suppressed-warnings',
			at: now - 20 * 60_000,
			file: 'a.mkv',
			segments: null,
			count: 40,
			level: 'warn'
		});
		agg.onEvent({
			kind: 'provider-fallback',
			at: now - 5 * 60_000,
			file: null,
			segments: null,
			count: null,
			level: 'info'
		});

		const c = agg.counters(now);
		expect(c.article430_24h).toBe(2);
		expect(c.article430_1h).toBe(1);
		expect(c.missingSegments24h).toBe(41); // 1 explicit + 40 suppressed
		expect(c.providerFallbacks24h).toBe(1);
	});

	it('reports repair active only within the quiet window', () => {
		const now = Date.now();
		let clock = now;
		const agg = new InfiniDyskAggregator({ now: () => clock });
		agg.onEvent({
			kind: 'repair-start',
			at: now - 5 * 60_000,
			file: 'x.mkv',
			segments: 10,
			count: null,
			level: 'info'
		});
		expect(agg.isRepairActive()).toBe(true);
		clock = now + 20 * 60_000;
		expect(agg.isRepairActive()).toBe(false);
	});

	it('prunes entries older than the window', () => {
		const now = Date.now();
		const agg = new InfiniDyskAggregator({ now: () => now });
		agg.onEvent({
			kind: 'repair-start',
			at: now - 3 * DAY,
			file: 'old.mkv',
			segments: 1,
			count: null,
			level: 'info'
		});
		agg.onEvent({
			kind: 'repair-start',
			at: now - HOUR,
			file: 'new.mkv',
			segments: 1,
			count: null,
			level: 'info'
		});
		agg.prune(now);
		expect(agg.getFiles(now).map((f) => f.file)).toEqual(['new.mkv']);
	});
});
