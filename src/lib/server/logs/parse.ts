/**
 * Parse DUMB log lines into structured LogLine records.
 *
 * DUMB's documented live log format is:
 *   `Apr 12, 2025 10:04:01 - INFO - message text`
 * Some services prefix the message with their own name; when we know the
 * discovered process names we lift a leading `Name:`/`Name -` prefix out of the
 * message. Anything unparseable becomes level `raw` with the full text — the
 * log viewer still shows it.
 */
import type { LogLevel, LogLine } from '$lib/types';

const MONTHS: Record<string, number> = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	oct: 9,
	nov: 10,
	dec: 11
};

const LEVELS: Record<string, LogLevel> = {
	debug: 'debug',
	info: 'info',
	warning: 'warn',
	warn: 'warn',
	error: 'error',
	critical: 'error',
	fatal: 'error'
};

const LINE_RE =
	/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})\s+-\s+([A-Za-z]+)\s+-\s+([\s\S]*)$/;

let nextId = 1;
export function resetLogIds(): void {
	nextId = 1;
}

export interface ParseContext {
	/** Known process names, used to attribute log lines to services. */
	processNames?: ReadonlySet<string>;
}

/** Hard cap per line: a runaway service must not blow up memory or browsers. */
export const MAX_LOG_LINE_LENGTH = 4_000;

export function parseLogLine(
	rawText: string,
	ctx: ParseContext = {},
	receivedAt = Date.now()
): LogLine {
	const truncated = rawText.length > MAX_LOG_LINE_LENGTH;
	const text = truncated ? rawText.slice(0, MAX_LOG_LINE_LENGTH) + '… [truncated]' : rawText;
	const match = LINE_RE.exec(text);
	if (!match) {
		return {
			id: nextId++,
			ts: null,
			level: 'raw',
			process: '',
			message: text.slice(0, 2000),
			receivedAt
		};
	}
	const [, mon, day, year, hh, mm, ss, levelRaw, rest] = match;
	const month = MONTHS[(mon ?? '').toLowerCase()];
	const ts =
		month !== undefined
			? new Date(Number(year), month, Number(day), Number(hh), Number(mm), Number(ss)).getTime()
			: null;

	let process = '';
	let message = (rest ?? '').trimEnd();
	const prefix = /^([A-Za-z0-9 ._+/-]{2,40}?)\s*[:\u2013-]\s+([\s\S]*)$/;
	const prefixMatch = prefix.exec(message);
	if (
		prefixMatch &&
		ctx.processNames?.has(prefixMatch[1]!.trim()) &&
		prefixMatch[2] !== undefined
	) {
		process = prefixMatch[1]!.trim();
		message = prefixMatch[2];
	}

	const level = LEVELS[(levelRaw ?? '').toLowerCase()] ?? 'raw';
	return { id: nextId++, ts, level, process, message, receivedAt };
}

/** Split a chunk of text into lines, tolerating \r\n. */
export function splitLines(chunk: string): string[] {
	return chunk.split(/\r?\n/).filter((line) => line.length > 0);
}
