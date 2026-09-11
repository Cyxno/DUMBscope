/**
 * Pure library computations (brief §75): completion, backlog age, subtitle
 * coverage, queue grouping, attention ranking. No I/O, no state — fully
 * unit-testable, and every derivation documents its exact semantics.
 */
import type {
	AttentionItem,
	LibraryTotals,
	MissingItem,
	QueueGroup,
	QueueIssue,
	SubtitlesLibrary
} from './models';

/** Backlog-age buckets over RELEASED items only; future never counts (§13). */
export function ageBucketFor(
	releasedAt: number | null,
	now = Date.now()
): 'new' | '1-7d' | '7-30d' | '30d+' | null {
	if (releasedAt === null || releasedAt > now) return null;
	const days = (now - releasedAt) / 86_400_000;
	if (days < 1) return 'new';
	if (days < 7) return '1-7d';
	if (days < 30) return '7-30d';
	return '30d+';
}

export function emptyBacklogAges(): NonNullable<LibraryTotals['backlogAges']> {
	return { new: 0, '1-7d': 0, '7-30d': 0, '30d+': 0 };
}

export function countBacklogAges(
	items: MissingItem[],
	now = Date.now()
): LibraryTotals['backlogAges'] {
	const ages = emptyBacklogAges();
	for (const item of items) {
		if (item.status !== 'missing') continue;
		const bucket = ageBucketFor(item.releasedAt, now);
		if (bucket) ages[bucket] += 1;
	}
	return ages;
}

/**
 * Completion = (released monitored items − monitored missing) / released
 * monitored items × 100. Future (unaired/unreleased) items and unmonitored
 * items are excluded on both sides (brief §14). Conservative edge case: the
 * "released monitored" denominator includes a series' unmonitored aired
 * episodes (aggregate statistics do not split them), which can only make the
 * number look slightly worse — never misleadingly better.
 */
export function completionPct(releasedMonitored: number, monitoredMissing: number): number | null {
	if (releasedMonitored <= 0) return null;
	const pct = ((releasedMonitored - monitoredMissing) / releasedMonitored) * 100;
	return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
}

/**
 * Per-language subtitle coverage. Required = monitored items where the
 * language is wanted (union of wanted-code2s across items); missing = items
 * listing that code2 in missing_subtitles.
 */
export function subtitleCoverage(
	monitoredCount: number,
	languagesWanted: Map<string, number>,
	languagesMissing: Map<string, number>,
	languageNames: Map<string, string>
): SubtitlesLibrary['languages'] {
	const codes = new Set([...languagesWanted.keys(), ...languagesMissing.keys()]);
	const rows: SubtitlesLibrary['languages'] = [];
	for (const code of codes) {
		const missing = languagesMissing.get(code) ?? 0;
		const required = Math.max(languagesWanted.get(code) ?? 0, missing);
		rows.push({
			code2: code,
			name: languageNames.get(code) ?? code.toUpperCase(),
			required,
			missing,
			coveragePct: required > 0 ? Math.round(((required - missing) / required) * 1000) / 10 : null
		});
	}
	void monitoredCount;
	return rows.sort((a, b) => b.missing - a.missing || a.code2.localeCompare(b.code2));
}

const QUEUE_KIND_RULES: { re: RegExp; kind: QueueGroup['kind'] }[] = [
	{ re: /failed/i, kind: 'failed' },
	{ re: /importblocked|import blocked|manualimportrequired/i, kind: 'importing' },
	{ re: /queued|delay|pending/i, kind: 'queued' },
	{ re: /downloading|paused/i, kind: 'downloading' },
	{ re: /importing/i, kind: 'importing' }
];

export function queueStatusKind(status: string, trackedDownloadState: string): QueueGroup['kind'] {
	const haystack = `${status} ${trackedDownloadState}`;
	for (const rule of QUEUE_KIND_RULES) if (rule.re.test(haystack)) return rule.kind;
	return 'downloading';
}

export interface QueueSourceInput {
	type: string;
	integrationId: string;
	status: string;
	trackedDownloadStatus: string;
	trackedDownloadState: string;
}

/** Combined queue view (§26): one grouped snapshot across Sonarr + Radarr. */
export function groupQueue(items: QueueSourceInput[]): {
	groups: QueueGroup[];
	issues: QueueIssue[];
} {
	const byKind = new Map<QueueGroup['kind'], QueueGroup>();
	for (const item of items) {
		const kind =
			item.trackedDownloadStatus === 'failure'
				? 'failed'
				: item.trackedDownloadStatus === 'warning'
					? 'warning'
					: queueStatusKind(item.status, item.trackedDownloadState);
		let group = byKind.get(kind);
		if (!group) {
			group = { kind, count: 0, sources: [] };
			byKind.set(kind, group);
		}
		group.count += 1;
		const source = group.sources.find((s) => s.integrationId === item.integrationId);
		if (source) source.count += 1;
		else group.sources.push({ type: item.type, integrationId: item.integrationId, count: 1 });
	}
	return { groups: [...byKind.values()], issues: queueIssues(items) };
}

export function queueIssues(items: QueueSourceInput[]): QueueIssue[] {
	const issues: QueueIssue[] = [];
	for (const item of items) {
		if (item.trackedDownloadStatus === 'failure') {
			issues.push({
				integrationId: item.integrationId,
				type: item.type,
				title: 'Import failed',
				reason: 'Download completed but the import was rejected by the library.',
				severity: 'issue'
			});
		} else if (item.trackedDownloadStatus === 'warning') {
			issues.push({
				integrationId: item.integrationId,
				type: item.type,
				title: 'Download needs attention',
				reason: 'The download client reports a problem with this item.',
				severity: 'attention'
			});
		}
	}
	return issues.slice(0, 50);
}

export interface AttentionRuleInput {
	/** Integration availability: missing entries mean "not configured". */
	available: Record<'tv' | 'movies' | 'subtitles', boolean>;
	failedImports: number;
	queueIssues: QueueIssue[];
	healthWarnings: { integrationId: string; type: string; message: string }[];
	missing: MissingItem[];
	stale: Record<'tv' | 'movies' | 'subtitles', boolean>;
}

/**
 * "Needs attention" rules (brief §39–§43): explicit, severity-ranked, and
 * deliberately narrow. Library backlog is NOT an incident — only operational
 * failures rank as issues.
 */
export function rankAttention(input: AttentionRuleInput): AttentionItem[] {
	const out: AttentionItem[] = [];

	if (input.failedImports > 0) {
		out.push({
			id: 'import-failures',
			severity: 'issue',
			title: `${input.failedImports} import ${input.failedImports === 1 ? 'issue' : 'issues'}`,
			detail: 'Downloads finished but could not be imported.',
			href: '/library?view=queue&filter=issues'
		});
	}
	for (const issue of input.queueIssues) {
		out.push({
			id: `queue-${issue.integrationId}`,
			severity: 'issue',
			title: `${issue.title} (${issue.type})`,
			detail: issue.reason,
			href: '/library?view=queue&filter=issues'
		});
	}
	for (const warning of input.healthWarnings.slice(0, 3)) {
		out.push({
			id: `health-${warning.integrationId}`,
			severity: 'issue',
			title: `Health warning (${warning.type})`,
			detail: warning.message,
			href: '/library?view=queue'
		});
	}

	const old30 = input.missing.filter((m) => m.ageBucket === '30d+').length;
	if (old30 > 0) {
		out.push({
			id: 'long-missing',
			severity: 'attention',
			title: `${old30} missing ${old30 === 1 ? 'item' : 'items'} older than 30 days`,
			detail: 'Released this long ago without becoming available — worth a look.',
			href: '/library?view=tv&filter=missing&sort=oldest'
		});
	}

	return out;
}
