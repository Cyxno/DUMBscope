/**
 * InfiniDysk / NzbWebDAV log observability (brief §4).
 *
 * InfiniDysk's repair loop, article failures and provider fallbacks are all
 * visible in its log output — which DUMBscope ALREADY receives on the existing
 * /ws/logs stream. This module parses those lines into structured facts and
 * keeps bounded rolling aggregates (per-file repair loops, 430s, missing
 * segments). No extra polling, no log files mounted, no duplicate alerting:
 * DUMBscope observes and visualises, Hermes stays the alerting layer.
 *
 * Known line shapes (DUMB prefixes everything with its own logger; the inner
 * level tags are the truthful severity):
 *   … INF] Health check classified /content/…/file.mkv as failed: 6599
 *       missing/corrupt segment(s) (largest run …) Starting repair.
 *   … ERR] File /content/…/file.mkv has missing articles: Article with
 *       message-id … not found. Server responded: 430 No Such Article
 *   … WRN] Usenet segment was unavailable from all eligible provider sources.
 *       Segment: …; File: file.mkv; Operation: stat; …
 *   … WRN] Suppressed 759 additional unavailable-segment warnings for file.mkv
 *       in the previous 60 seconds.
 *   … INF] Provider news.example.com error: … Falling back to news.other.tld
 */
import type { InfiniDyskFileRecord } from '$lib/types';

export const INFINIDYSK_TUNING = {
	/** Rolling window kept in memory (aggregates 24h; enough for recurrence). */
	windowMs: 24 * 60 * 60_000,
	/** A repair started within this window counts as "repair active". */
	repairActiveMs: 15 * 60_000,
	/** Max per-file records kept (bounded memory; heaviest files surface). */
	maxFileRecords: 200
} as const;

export type InfiniDyskTuning = { [K in keyof typeof INFINIDYSK_TUNING]: number };

export interface InfiniDyskParsedEvent {
	kind:
		| 'repair-start'
		| 'article-430'
		| 'missing-segment'
		| 'suppressed-warnings'
		| 'provider-fallback';
	at: number;
	/** Media file (basename or path) the fact belongs to, when known. */
	file: string | null;
	segments: number | null;
	count: number | null;
	/** Original inner level (INF/WRN/ERR) when present. */
	level: 'info' | 'warn' | 'error' | null;
}

/**
 * Parse one InfiniDysk log line (the full DUMB line or just the inner part).
 * Returns null for lines that carry none of the observed facts.
 */
export function parseInfiniDyskLine(line: string, now = Date.now()): InfiniDyskParsedEvent | null {
	const levelMatch = /\[[^\]]*?\b(INF|WRN|ERR|FTL)\]/.exec(line);
	const level = levelMatch
		? levelMatch[1] === 'INF'
			? 'info'
			: levelMatch[1] === 'WRN'
				? 'warn'
				: 'error'
		: null;

	// Repair loop: "Health check classified <path> as failed: N missing/corrupt
	// segment(s) … Starting repair."
	const repair =
		/Health check classified\s+(\S+)\s+as failed:\s*([\d,]+)\s*missing\/corrupt segment/i.exec(
			line
		);
	if (repair) {
		return {
			kind: 'repair-start',
			at: now,
			file: basenameOf(repair[1]),
			segments: parseCount(repair[2]),
			count: null,
			level
		};
	}

	// 430: "File <path> has missing articles: Article with message-id … 430 No Such Article"
	const missing430 = /File\s+(\S+)\s+has missing articles:.*430\s+No Such Article/i.exec(line);
	if (missing430) {
		return {
			kind: 'article-430',
			at: now,
			file: basenameOf(missing430[1]),
			segments: null,
			count: null,
			level
		};
	}

	// Suppressed warning rollup: "Suppressed N additional unavailable-segment warnings for <file>"
	const suppressed =
		/Suppressed\s+([\d,]+)\s+additional unavailable-segment warnings for\s+(.+?)\s+in the previous/i.exec(
			line
		);
	if (suppressed) {
		return {
			kind: 'suppressed-warnings',
			at: now,
			file: basenameOf(suppressed[2]),
			segments: null,
			count: parseCount(suppressed[1]),
			level
		};
	}

	// Unavailable segment: "… File: <name>; Operation: stat;" (name may contain spaces).
	const unavailable =
		/unavailable from all eligible provider sources.*File:\s*([^;]+);/i.exec(line) ??
		/Usenet segment was unavailable.*File:\s*([^;]+);/i.exec(line);
	if (unavailable) {
		return {
			kind: 'missing-segment',
			at: now,
			file: basenameOf(unavailable[1]),
			segments: 1,
			count: null,
			level
		};
	}

	// Provider fallback: "Provider <host> error: … Falling back to <host>"
	const fallback = /Provider\s+(\S+)\s+error:.*Falling back to\s+(\S+)/i.exec(line);
	if (fallback) {
		return { kind: 'provider-fallback', at: now, file: null, segments: null, count: null, level };
	}
	return null;
}

function parseCount(raw: string | undefined): number | null {
	if (!raw) return null;
	const n = Number(raw.replace(/,/g, ''));
	return Number.isFinite(n) ? n : null;
}

function basenameOf(raw: string | undefined): string | null {
	if (!raw) return null;
	const trimmed = raw.trim().replace(/\/+$/, '');
	if (!trimmed) return null;
	const base = trimmed.split('/').pop() ?? trimmed;
	return base || trimmed;
}

interface FileState {
	repairs: number[];
	lastRepairAt: number | null;
	lastError: string | null;
	missingSegments: { at: number; count: number }[];
	days: Set<string>;
}

/** Bounded rolling aggregator over the parsed InfiniDysk facts. */
export class InfiniDyskAggregator {
	private readonly nowFn: () => number;
	private readonly t: InfiniDyskTuning;
	private files = new Map<string, FileState>();
	private repairs: number[] = [];
	private article430: number[] = [];
	private missingSegments: { at: number; count: number }[] = [];
	private providerFallbacks: number[] = [];

	constructor(options: { now?: () => number; tuning?: Partial<InfiniDyskTuning> } = {}) {
		this.nowFn = options.now ?? (() => Date.now());
		this.t = { ...INFINIDYSK_TUNING, ...options.tuning };
	}

	onEvent(event: InfiniDyskParsedEvent): void {
		const day = new Date(event.at).toISOString().slice(0, 10);
		switch (event.kind) {
			case 'repair-start': {
				this.repairs.push(event.at);
				if (event.file) {
					const st = this.stateFor(event.file);
					st.repairs.push(event.at);
					st.lastRepairAt = event.at;
					st.lastError = `health check failed (${event.segments ?? '?'} missing/corrupt segments)`;
					st.days.add(day);
				}
				break;
			}
			case 'article-430': {
				this.article430.push(event.at);
				if (event.file) {
					const st = this.stateFor(event.file);
					st.lastError = 'article missing on provider (430 No Such Article)';
					st.days.add(day);
				}
				break;
			}
			case 'missing-segment': {
				this.missingSegments.push({ at: event.at, count: 1 });
				if (event.file) {
					const st = this.stateFor(event.file);
					st.missingSegments.push({ at: event.at, count: 1 });
					st.days.add(day);
				}
				break;
			}
			case 'suppressed-warnings': {
				const count = event.count ?? 0;
				this.missingSegments.push({ at: event.at, count });
				if (event.file) {
					const st = this.stateFor(event.file);
					st.missingSegments.push({ at: event.at, count });
				}
				break;
			}
			case 'provider-fallback': {
				this.providerFallbacks.push(event.at);
				break;
			}
		}
	}

	/** A repair started recently and no newer evidence of completion exists. */
	isRepairActive(quietMs = this.t.repairActiveMs): boolean {
		const now = this.nowFn();
		const last = this.repairs[this.repairs.length - 1];
		return last !== undefined && now - last <= quietMs;
	}

	/** Per-file records, heaviest (most repairs) first — bounded list. */
	getFiles(now = this.nowFn()): InfiniDyskFileRecord[] {
		const hourAgo = now - 60 * 60_000;
		const dayAgo = now - this.t.windowMs;
		const out: InfiniDyskFileRecord[] = [];
		for (const [file, st] of this.files) {
			const repairs24h = st.repairs.filter((at) => at >= dayAgo).length;
			if (repairs24h === 0 && st.lastRepairAt !== null && st.lastRepairAt < dayAgo) continue;
			out.push({
				file,
				repairs1h: st.repairs.filter((at) => at >= hourAgo).length,
				repairs24h,
				lastRepairAt: st.lastRepairAt,
				lastError: st.lastError,
				activeDays: st.days.size,
				missingSegments24h: st.missingSegments
					.filter((m) => m.at >= dayAgo)
					.reduce((a, b) => a + b.count, 0)
			});
		}
		out.sort(
			(a, b) => b.repairs24h - a.repairs24h || (b.lastRepairAt ?? 0) - (a.lastRepairAt ?? 0)
		);
		return out.slice(0, this.t.maxFileRecords);
	}

	counters(now = this.nowFn()): {
		repairs1h: number;
		repairs24h: number;
		article430_1h: number;
		article430_24h: number;
		missingSegments1h: number;
		missingSegments24h: number;
		providerFallbacks24h: number;
		lastRepairAt: number | null;
	} {
		const hourAgo = now - 60 * 60_000;
		const dayAgo = now - this.t.windowMs;
		const last = this.repairs.length > 0 ? this.repairs[this.repairs.length - 1]! : null;
		return {
			repairs1h: this.repairs.filter((at) => at >= hourAgo).length,
			repairs24h: this.repairs.filter((at) => at >= dayAgo).length,
			article430_1h: this.article430.filter((at) => at >= hourAgo).length,
			article430_24h: this.article430.filter((at) => at >= dayAgo).length,
			missingSegments1h: this.missingSegments
				.filter((m) => m.at >= hourAgo)
				.reduce((a, b) => a + b.count, 0),
			missingSegments24h: this.missingSegments
				.filter((m) => m.at >= dayAgo)
				.reduce((a, b) => a + b.count, 0),
			providerFallbacks24h: this.providerFallbacks.filter((at) => at >= dayAgo).length,
			lastRepairAt: last
		};
	}

	/** Drop entries older than the window (called on a slow housekeeping pass). */
	prune(now = this.nowFn()): void {
		const cutoff = now - this.t.windowMs;
		this.repairs = this.repairs.filter((at) => at >= cutoff);
		this.article430 = this.article430.filter((at) => at >= cutoff);
		this.missingSegments = this.missingSegments.filter((m) => m.at >= cutoff);
		this.providerFallbacks = this.providerFallbacks.filter((at) => at >= cutoff);
		for (const [file, st] of this.files) {
			st.repairs = st.repairs.filter((at) => at >= cutoff);
			st.missingSegments = st.missingSegments.filter((m) => m.at >= cutoff);
			if (
				st.repairs.length === 0 &&
				st.missingSegments.length === 0 &&
				(st.lastRepairAt === null || st.lastRepairAt < cutoff)
			) {
				this.files.delete(file);
			}
		}
	}

	private stateFor(file: string): FileState {
		let st = this.files.get(file);
		if (!st) {
			st = {
				repairs: [],
				lastRepairAt: null,
				lastError: null,
				missingSegments: [],
				days: new Set()
			};
			this.files.set(file, st);
		}
		return st;
	}
}
