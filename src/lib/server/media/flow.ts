/**
 * Cross-service media flow correlation (DEEL 2).
 *
 * Answers, per media item: what does the Arr say (missing/queue/history),
 * what happened to each acquisition request (grabbed / failed / imported,
 * and via which emulated client — SABnzbd = InfiniDysk path, qBittorrent =
 * Decypharr path), and is the divergence normal eventual consistency or a
 * persistent problem?
 *
 * Rules the implementation enforces:
 * - **Observe first.** Nothing here triggers searches, edits queues or
 *   touches any component. Read-only Arr history/missing/queue reads only
 *   (brief §2).
 * - **Stable identity.** Correlation keys are `sonarr:<instance>:episode:<id>`
 *   and `radarr:<instance>:movie:<id>`; acquisitions are keyed by the
 *   upstream download GUID. Titles are display-only (brief §10/§11).
 * - **Eventual consistency is not a warning.** Measured on the real stack,
 *   a successful grab imports within seconds-to-2 minutes (S.W.A.T. S04E05:
 *   grab 00:17 → import 00:19). Anything inside the grace windows is shown
 *   as Acquiring/Importing, never as a mismatch (brief §23/§32).
 * - **Repeated requests need context.** A re-grab is only "repeated" while
 *   the previous acquisition is still active (not imported) or very recent —
 *   a fresh acquisition long after a completed one is normal (brief §20).
 */
import type {
	MediaAcquisition,
	MediaFlowItem,
	MediaFlowSnapshot,
	MediaSourceObservation
} from '$lib/types';
import { AcquisitionLedger } from './ledger';
import { acquisitionPath, episodeKey, movieKey } from './identity';

export const MEDIA_FLOW_TUNING = {
	/** Correlation cycle cadence (Arr history/missing reads are bounded). */
	cycleMs: 2 * 60_000,
	/** History page fetched per integration per cycle (newest first). */
	historyPageSize: 200,
	/** Missing page fetched per integration per cycle. */
	missingPageSize: 50,
	/** How long a grabbed-but-not-imported request stays "acquiring". */
	acquiringGraceMs: 30 * 60_000,
	/** Missing-after-import grace before a mismatch finding (brief §24). */
	mismatchGraceMs: 15 * 60_000,
	/** A completed acquisition protects against "repeated" this long. */
	completionShieldMs: 4 * 60 * 60_000,
	/** Failures before "acquisition keeps failing" opens. */
	failingThreshold: 3,
	/** Requests per item within this horizon count as the repeat cluster. */
	repeatWindowMs: 72 * 60 * 60_000,
	/** Ledger window for flow construction. */
	ledgerWindowMs: 72 * 60 * 60_000,
	/** Enough propagation samples for median/p95. */
	propagationMinSamples: 5,
	/** Maximum flows handed to the UI. */
	maxItems: 12
} as const;

export interface ArrObservation {
	integrationId: string;
	sourceType: 'sonarr' | 'radarr';
	/** Missing (wanted) items from the Arr's own list. */
	missing: { mediaKey: string; title: string; mediaId: number }[];
	/** History events (grabbed / downloadFailed / downloadFolderImported). */
	events: {
		requestId: string;
		mediaKey: string;
		title: string;
		client: string | null;
		event: 'grabbed' | 'downloadFailed' | 'downloadFolderImported' | 'downloaded';
		at: number;
	}[];
	/** Queue presence per media key (live acquisition work). */
	queue: { mediaKey: string; state: 'downloading' | 'importing' }[];
}

export interface MediaFinding {
	fingerprint: string;
	severity: 'warning' | 'info';
	title: string;
	summary: string;
	evidence: string;
	mediaKey: string | null;
}

export interface MediaFlowContext {
	/** Any DEEL-1 mount target currently unresponsive/read-error. */
	mountUnhealthy: boolean;
	mountLabel: string | null;
}

export interface ArrSourceBatch {
	sources: ArrObservation[];
	/**
	 * True only when EVERY enabled Sonarr/Radarr answered this cycle. The
	 * close-out sweep (resolving findings absent from the current picture)
	 * runs only on complete data: a failed Arr read must never look like
	 * "the condition disappeared".
	 */
	complete: boolean;
}

export interface MediaFlowCorrelatorOptions {
	now?: () => number;
	ledger?: AcquisitionLedger;
	loader: () => Promise<ArrSourceBatch>;
	onFinding: (finding: MediaFinding) => void;
	onResolve: (fingerprint: string, message: string) => void;
	/** Currently open media fingerprints (from the incident store/engine). */
	getActiveFingerprints?: () => string[];
	tuning?: Partial<Record<keyof typeof MEDIA_FLOW_TUNING, number>>;
}

interface FlowWork {
	/** Stable identity — the map key this work was created under. */
	key: string;
	observations: MediaSourceObservation[];
	title: string;
	sourceType: 'sonarr' | 'radarr';
	integrationId: string;
	mediaId: number | null;
	isMissing: boolean;
	lastGrabAt: number | null;
	lastFailureAt: number | null;
	lastImportAt: number | null;
	acquisitions: number;
	classification: MediaFlowItem['classification'];
}

export class MediaFlowCorrelator {
	private readonly nowFn: () => number;
	private readonly ledger: AcquisitionLedger;
	private readonly loader: () => Promise<ArrSourceBatch>;
	private readonly onFinding: (finding: MediaFinding) => void;
	private readonly onResolve: (fingerprint: string, message: string) => void;
	private readonly getActiveFingerprints: () => string[];
	private readonly t: Record<keyof typeof MEDIA_FLOW_TUNING, number>;

	private lastCycleAt = 0;
	private running = false;
	private items: MediaFlowItem[] = [];
	private metrics: MediaFlowSnapshot['metrics'] = {
		repeatedRequests24h: 0,
		activeMediaMismatches: 0,
		resolvedMediaMismatches: 0,
		propagation: { samples: 0, medianMs: null, p95Ms: null }
	};
	private mismatches = new Map<string, number>(); // mediaKey → firstMismatchAt
	private resolvedMismatchCount = 0;

	constructor(options: MediaFlowCorrelatorOptions) {
		this.nowFn = options.now ?? (() => Date.now());
		this.ledger = options.ledger ?? new AcquisitionLedger(options.now);
		this.loader = options.loader;
		this.onFinding = options.onFinding;
		this.onResolve = options.onResolve;
		this.getActiveFingerprints = options.getActiveFingerprints ?? (() => []);
		this.t = { ...MEDIA_FLOW_TUNING, ...options.tuning } as Record<
			keyof typeof MEDIA_FLOW_TUNING,
			number
		>;
	}

	getMetrics(): MediaFlowSnapshot['metrics'] {
		return this.metrics;
	}

	getItems(): MediaFlowItem[] {
		return this.items;
	}

	snapshot(): MediaFlowSnapshot {
		return {
			generatedAt: this.lastCycleAt,
			items: this.items,
			metrics: this.metrics
		};
	}

	/** Run one correlation cycle. Failure-isolated and non-overlapping. */
	async tick(context: MediaFlowContext): Promise<void> {
		const now = this.nowFn();
		if (this.running || now - this.lastCycleAt < this.t.cycleMs) return;
		this.running = true;
		this.lastCycleAt = now;
		try {
			const batch = await this.loader();
			this.buildFlows(batch.sources, batch.complete, context, now);
			this.computePropagation();
		} catch {
			// A failed Arr read must never take down the reliability loop; the
			// next cycle simply tries again.
		} finally {
			this.running = false;
		}
	}

	// ---------------------------------------------------------------------------
	// Correlation
	// ---------------------------------------------------------------------------

	private buildFlows(
		sources: ArrObservation[],
		dataComplete: boolean,
		context: MediaFlowContext,
		now: number
	): void {
		const work = new Map<string, FlowWork>();
		const workOf = (mediaKey: string, seed: Partial<FlowWork>): FlowWork => {
			let w = work.get(mediaKey);
			if (!w) {
				w = {
					key: mediaKey,
					observations: [],
					title: 'Unknown',
					sourceType: 'sonarr',
					integrationId: '',
					mediaId: null,
					isMissing: false,
					lastGrabAt: null,
					lastFailureAt: null,
					lastImportAt: null,
					acquisitions: 0,
					classification: null,
					...seed
				};
				work.set(mediaKey, w);
			}
			return w;
		};

		this.propagationSamples = [];
		for (const source of sources) {
			// Feed the ledger (dedupes on request identity), then build from it.
			for (const event of source.events) {
				this.ledger.observe({ ...event, integrationId: source.integrationId });
			}
			for (const m of source.missing) {
				const w = workOf(m.mediaKey, {
					title: m.title,
					sourceType: source.sourceType,
					integrationId: source.integrationId,
					mediaId: m.mediaId
				});
				w.isMissing = true;
				w.observations.push({
					source: source.sourceType,
					integrationId: source.integrationId,
					state: 'missing',
					observedAt: now,
					confidence: 'exact',
					evidence: 'Arr reports the item missing'
				});
			}
			for (const q of source.queue) {
				const w = workOf(q.mediaKey, { sourceType: source.sourceType });
				w.observations.push({
					source: source.sourceType,
					integrationId: source.integrationId,
					state: q.state,
					observedAt: now,
					confidence: 'exact',
					evidence: 'item is in the Arr queue'
				});
			}
		}

		// Ledger activity (bounded window) — including items no longer missing.
		const acquisitions = this.ledger.recent(this.t.repeatWindowMs);
		// Propagation delays come straight from completed acquisitions
		// (grab → import), recomputed per cycle from the same bounded window.
		for (const acq of acquisitions) {
			if (acq.acceptedAt !== null && acq.completedAt !== null) {
				const delay = acq.completedAt - acq.acceptedAt;
				if (delay >= 0 && delay <= 6 * 60 * 60_000) this.propagationSamples.push(delay);
			}
		}
		const byMedia = new Map<string, MediaAcquisition[]>();
		for (const acq of acquisitions) {
			const list = byMedia.get(acq.mediaKey) ?? [];
			list.push(acq);
			byMedia.set(acq.mediaKey, list);
		}

		const activeFingerprints = new Set<string>();
		for (const [mediaKey, acqs] of byMedia) {
			const existing = work.get(mediaKey);
			const w = workOf(mediaKey, existing ? { ...existing } : { sourceType: 'sonarr' });
			const sorted = [...acqs].sort((a, b) => a.firstSeen - b.firstSeen);
			w.acquisitions = sorted.length;
			const last = sorted[sorted.length - 1]!;
			w.title = last.title || w.title;
			if (!w.integrationId) w.integrationId = last.integrationId;
			// The ledger key IS the stable identity: parse the Arr-native id so
			// items that are not (any longer) missing keep their stable key too.
			if (w.mediaId === null) {
				const parts = mediaKey.split(':');
				const parsed = Number(parts[3]);
				if (Number.isFinite(parsed)) w.mediaId = parsed;
			}
			w.lastGrabAt = Math.max(...sorted.map((a) => a.acceptedAt ?? a.firstSeen));
			w.lastFailureAt = Math.max(...sorted.map((a) => a.failedAt ?? 0)) || null;
			w.lastImportAt = Math.max(...sorted.map((a) => a.completedAt ?? 0)) || null;
			const path = acquisitionPath(last.client);
			w.observations.push({
				source:
					path === 'decypharr' ? 'decypharr' : path === 'infinidysk' ? 'infinidysk' : 'sonarr',
				integrationId: last.integrationId,
				state: last.completedAt
					? 'available'
					: last.failedAt && (!last.acceptedAt || last.failedAt > last.acceptedAt)
						? 'failed'
						: 'accepted',
				observedAt: last.lastObservedAt,
				confidence: 'exact',
				evidence: `${sorted.length} request${sorted.length === 1 ? '' : 's'} · last "${last.lastEvent}" via ${last.client ?? 'unknown client'} ${relTime(this.nowFn(), last.lastObservedAt)}`
			});

			// --- Findings (brief §19/§24/§25) -------------------------------
			const repeatFp = `media-repeat:${mediaKey}`;
			const mismatchFp = `media-mismatch:${mediaKey}`;
			const failingFp = `media-failing:${mediaKey}`;
			const repeated = this.detectRepeat(mediaKey, sorted, now, w);
			const mismatch = this.detectMismatch(w, sorted, now);

			if (mismatch) {
				activeFingerprints.add(mismatchFp);
				this.onFinding({
					fingerprint: mismatchFp,
					severity: 'warning',
					title: `${w.title}: state mismatch`,
					summary: `The Arr imported this item but still reports it missing — waiting ${Math.round((now - (w.lastImportAt ?? now)) / 60_000)} min since import`,
					evidence: `last import ${relTime(this.nowFn(), w.lastImportAt)} · Arr missing=yes`,
					mediaKey
				});
			} else {
				this.onResolve(mismatchFp, 'Arr state caught up with the acquisition');
			}

			if (repeated) {
				activeFingerprints.add(repeatFp);
				this.onFinding({
					fingerprint: repeatFp,
					severity: 'warning',
					title: `${w.title}: repeated acquisition request`,
					summary: `${repeated.count} requests in ${relDuration(now - repeated.clusterStart)} while an acquisition was still active`,
					evidence: `${sorted.length} total requests in the ledger window · latest "${last.lastEvent}" via ${last.client ?? '?'} · ${
						context.mountUnhealthy
							? `storage mount unhealthy (${context.mountLabel}) — likely storage availability issue`
							: 'no acquisition completed yet'
					}`,
					mediaKey
				});
			} else {
				this.onResolve(repeatFp, 'No repeat while active');
			}

			const failures = sorted.filter((a) => a.failedAt !== null).length;
			const stillMissing = w.isMissing && !w.lastImportAt;
			if (stillMissing && failures >= this.t.failingThreshold) {
				activeFingerprints.add(failingFp);
				this.onFinding({
					fingerprint: failingFp,
					severity: 'warning',
					title: `${w.title}: acquisition keeps failing`,
					summary: `${failures} failed requests, item still missing${context.mountUnhealthy ? ` — storage mount unhealthy (${context.mountLabel}), likely storage availability issue` : ''}`,
					evidence: `last failure ${relTime(this.nowFn(), w.lastFailureAt)}`,
					mediaKey
				});
			} else {
				this.onResolve(failingFp, 'Acquisition stopped failing');
			}

			w.classification = classify(w, repeated, mismatch, failures, context, this.t, now);
		}

		// Complete-cycle close-out: any still-open media finding that the FULL
		// current picture no longer shows is resolved — including items whose
		// acquisitions aged out of the history window, vanished from the queue
		// or disappeared from history entirely. This is the fix for incidents
		// that stayed ACTIVE for days after the underlying condition ended:
		// scoped resolution only touched keys still being evaluated. On
		// incomplete data (any enabled Arr unreadable) the sweep is skipped —
		// a failed read must never resolve findings.
		if (dataComplete) {
			for (const fp of this.getActiveFingerprints()) {
				if (
					!fp.startsWith('media-repeat:') &&
					!fp.startsWith('media-mismatch:') &&
					!fp.startsWith('media-failing:')
				)
					continue;
				if (activeFingerprints.has(fp)) continue;
				this.onResolve(fp, 'Resolved: the condition is no longer present in the current Arr state');
			}
		}

		// Mismatch resolution bookkeeping for the metrics.
		for (const [mediaKey, since] of this.mismatches) {
			if (!activeFingerprints.has(`media-mismatch:${mediaKey}`)) {
				this.mismatches.delete(mediaKey);
				this.resolvedMismatchCount++;
			} else {
				void since;
			}
		}
		for (const fp of activeFingerprints) {
			if (fp.startsWith('media-mismatch:')) {
				const key = fp.slice('media-mismatch:'.length);
				this.mismatches.set(key, this.mismatches.get(key) ?? this.nowFn());
			}
		}

		this.metrics = {
			repeatedRequests24h: this.countRepeats24h(byMedia, work, now),
			activeMediaMismatches: this.mismatches.size,
			resolvedMediaMismatches: this.resolvedMismatchCount,
			propagation: this.propagation
		};

		// UI items: attention-first, capped (brief §29 — no card overload).
		const rank = (w: FlowWork) =>
			(w.classification === 'repeated-request' ? 3 : 0) +
			(w.classification === 'mount-unavailable' ? 3 : 0) +
			(w.classification === 'state-propagation-delay' ? 2 : 0) +
			(w.classification === 'arr-import-delay' ? 2 : 0) +
			(w.isMissing ? 1 : 0);
		this.items = [...work.values()]
			.sort((a, b) => rank(b) - rank(a) || (b.lastGrabAt ?? 0) - (a.lastGrabAt ?? 0))
			.slice(0, this.t.maxItems)
			.map((w) => this.toFlowItem(w, now));
	}

	private propagation: MediaFlowSnapshot['metrics']['propagation'] = {
		samples: 0,
		medianMs: null,
		p95Ms: null
	};

	private propagationSamples: number[] = [];

	private computePropagation(): void {
		const samples = this.propagationSamples.slice(-100);
		this.propagation = {
			samples: samples.length,
			medianMs: samples.length >= this.t.propagationMinSamples ? percentile(samples, 50) : null,
			p95Ms: samples.length >= this.t.propagationMinSamples ? percentile(samples, 95) : null
		};
	}

	/**
	 * A repeat: a new grab for an item whose previous request is still active
	 * (never imported) or completed only within the completion shield. Returns
	 * the repeat cluster evidence when found (brief §19/§20/§21).
	 *
	 * "Still active" is verified, not assumed: an acquisition counts as active
	 * while the item is missing from the Arr, sits in its queue, or saw grab
	 * activity inside the acquiring grace. A cluster with none of those —
	 * nothing imported, nothing queued, no activity for hours — is a stale
	 * history echo, not an active problem, and must not hold the finding open.
	 */
	private detectRepeat(
		mediaKey: string,
		sorted: MediaAcquisition[],
		now: number,
		w: FlowWork
	): { count: number; clusterStart: number } | null {
		if (sorted.length < 2) return null;
		const inWindow = sorted.filter((a) => now - a.firstSeen <= this.t.repeatWindowMs);
		if (inWindow.length < 2) return null;
		const latest = sorted[sorted.length - 1]!;
		const previous = sorted[sorted.length - 2]!;
		const latestIsNew = (latest.acceptedAt ?? latest.firstSeen) - previous.firstSeen > 60_000;
		if (!latestIsNew) return null;
		if (previous.completedAt !== null) {
			// The previous request completed. A follow-up grab is only a
			// *repeat* when the item is STILL missing (the import did not
			// stick); otherwise it is a normal upgrade/new acquisition
			// (brief §20). Give quick propagation the mismatch grace first.
			if (!w.isMissing) return null;
			if (now - previous.completedAt < this.t.mismatchGraceMs) return null;
			return { count: inWindow.length, clusterStart: inWindow[0]!.firstSeen };
		}
		// Previous request never completed: still active inside the window?
		if ((latest.acceptedAt ?? latest.firstSeen) - previous.firstSeen > this.t.repeatWindowMs)
			return null;
		// Active-work verification: missing in the Arr, in the queue, or
		// recent grab/failure activity keeps the repeat alive; a silent
		// cluster resolves instead of lingering for the whole window.
		const inQueue = w.observations.some(
			(o) => o.state === 'downloading' || o.state === 'importing'
		);
		const lastActivity = Math.max(
			...sorted.map((a) => Math.max(a.firstSeen, a.failedAt ?? 0, a.completedAt ?? 0))
		);
		const activeWork = w.isMissing || inQueue || now - lastActivity <= this.t.acquiringGraceMs;
		if (!activeWork) return null;
		return { count: inWindow.length, clusterStart: inWindow[0]!.firstSeen };
	}

	private detectMismatch(w: FlowWork, sorted: MediaAcquisition[], now: number): boolean {
		if (!w.isMissing || w.lastImportAt === null) return false;
		const importedAfterMissing = sorted.some((a) => (a.completedAt ?? 0) >= now - 7 * 86_400_000);
		return importedAfterMissing && now - w.lastImportAt >= this.t.mismatchGraceMs;
	}

	private countRepeats24h(
		byMedia: Map<string, MediaAcquisition[]>,
		work: Map<string, FlowWork>,
		now: number
	): number {
		let count = 0;
		for (const [mediaKey, acqs] of byMedia) {
			if (acqs.length < 2) continue;
			const sorted = [...acqs].sort((a, b) => a.firstSeen - b.firstSeen);
			const w = work.get(mediaKey) ?? emptyWork(mediaKey);
			if (this.detectRepeat(mediaKey, sorted, now, w)) count++;
		}
		return count;
	}

	private toFlowItem(w: FlowWork, now: number): MediaFlowItem {
		const derived = deriveSummary(w, this.t, now);
		return {
			mediaKey: this.keyOf(w),
			title: w.title,
			sourceType: w.sourceType,
			integrationId: w.integrationId,
			mediaId: w.mediaId,
			observations: w.observations.slice(-8),
			summary: derived.state,
			reason: derived.reason,
			acquisitions: w.acquisitions,
			lastGrabAt: w.lastGrabAt,
			lastImportAt: w.lastImportAt,
			lastFailureAt: w.lastFailureAt,
			classification: w.classification
		};
	}

	private keyOf(w: FlowWork): string {
		if (w.sourceType === 'radarr' && w.mediaId !== null)
			return movieKey(w.integrationId, w.mediaId);
		if (w.mediaId !== null) return episodeKey(w.integrationId, w.mediaId);
		return `${w.sourceType}:${w.integrationId}:unknown:${w.title}`;
	}

	/** Called by the hub when an import event is observed (propagation stats). */
	notePropagationDelay(delayMs: number): void {
		if (delayMs >= 0 && delayMs <= 6 * 60 * 60_000) this.propagationSamples.push(delayMs);
	}
}

// -----------------------------------------------------------------------------
// Derived summary (UI-only, brief §14/§15)
// -----------------------------------------------------------------------------

function deriveSummary(
	w: FlowWork,
	t: Record<keyof typeof MEDIA_FLOW_TUNING, number>,
	now: number
): { state: MediaFlowItem['summary']; reason: string | null } {
	const queueObs = w.observations.find((o) => o.state === 'downloading' || o.state === 'importing');
	if (queueObs?.state === 'importing')
		return { state: 'importing', reason: 'in the Arr import phase' };
	if (queueObs?.state === 'downloading')
		return { state: 'downloading', reason: 'in the Arr queue' };
	const acquisitionRecent = w.lastGrabAt !== null && now - w.lastGrabAt <= t.acquiringGraceMs;
	if (w.lastImportAt !== null && !w.isMissing) return { state: 'available', reason: null };
	if (acquisitionRecent && w.lastFailureAt === null) {
		return {
			state: 'acquiring',
			reason: `accepted ${relTime(now, w.lastGrabAt)} — missing state is expected until import`
		};
	}
	if (w.classification === 'repeated-request')
		return { state: 'missing', reason: 'repeated requests while acquisition active' };
	return { state: w.isMissing ? 'missing' : 'unknown', reason: null };
}

function classify(
	w: FlowWork,
	repeated: { count: number } | null,
	mismatch: boolean,
	failures: number,
	context: MediaFlowContext,
	t: Record<keyof typeof MEDIA_FLOW_TUNING, number>,
	now: number
): MediaFlowItem['classification'] {
	if (mismatch) return 'state-propagation-delay';
	if (repeated) {
		return context.mountUnhealthy && failures > 0 ? 'mount-unavailable' : 'repeated-request';
	}
	if (w.isMissing && failures >= t.failingThreshold) {
		return context.mountUnhealthy ? 'mount-unavailable' : 'arr-import-delay';
	}
	if (w.lastGrabAt !== null && now - w.lastGrabAt < t.acquiringGraceMs) {
		return 'acquisition-in-progress';
	}
	return null;
}

// -----------------------------------------------------------------------------
// The read-only loader: builds ArrObservations from configured integrations
// -----------------------------------------------------------------------------

export async function loadArrObservations(): Promise<ArrSourceBatch> {
	const { listIntegrations, getApiKey } = await import('../integrations/store');
	const { ArrBaseClient } = await import('../integrations/arr/base');
	const { getCachedData } = await import('../integrations/manager');
	const out: ArrObservation[] = [];
	let enabled = 0;
	let succeeded = 0;
	for (const config of listIntegrations()) {
		if (config.enabled === false || (config.type !== 'sonarr' && config.type !== 'radarr'))
			continue;
		enabled++;
		const apiKey = getApiKey(config.id);
		if (!apiKey) {
			// Unusable configuration: this integration contributes nothing and
			// cannot succeed — mark the cycle incomplete.
			continue;
		}
		const client = new ArrBaseClient(config.url, apiKey);
		const now = Date.now();
		try {
			const history = await client.history(200);
			const events: ArrObservation['events'] = [];
			for (const rec of history) {
				const eventType = String(rec.eventType ?? '');
				if (
					!['grabbed', 'downloadFailed', 'downloadFolderImported', 'downloaded'].includes(eventType)
				)
					continue;
				const requestId = typeof rec.downloadId === 'string' ? rec.downloadId : null;
				if (!requestId) continue; // no stable identity → not correlatable
				const mediaKey =
					config.type === 'sonarr'
						? episodeKey(config.id, Number(rec.episodeId))
						: movieKey(config.id, Number(rec.movieId));
				if (!Number.isFinite(Number(rec.episodeId ?? rec.movieId))) continue;
				events.push({
					requestId,
					mediaKey,
					title: String(rec.sourceTitle ?? 'Unknown'),
					client: (rec.data as { downloadClient?: string } | undefined)?.downloadClient ?? null,
					event: eventType as 'grabbed',
					at: Date.parse(String(rec.date)) || now
				});
			}
			// Missing page with ids (title display only).
			const missingRaw = await client.wantedMissing(1, 50, {
				includeSeries: config.type === 'sonarr'
			});
			const missing = (missingRaw.records ?? [])
				.map((r) => ({
					mediaKey:
						config.type === 'sonarr'
							? episodeKey(config.id, Number(r.id))
							: movieKey(config.id, Number(r.id)),
					title:
						config.type === 'sonarr'
							? `${(r.series as { title?: string } | undefined)?.title ?? 'Series'} S${String(r.seasonNumber).padStart(2, '0')}E${String(r.episodeNumber).padStart(2, '0')}`
							: `${r.title} (${r.year ?? '?'})`,
					mediaId: Number(r.id)
				}))
				.filter((m) => Number.isFinite(m.mediaId));
			// Queue presence from the existing 15 s queue poller cache.
			const queue = getCachedData<{
				items: { episodeId: number | null; movieId: number | null; trackedDownloadState: string }[];
			}>(config.id, 'queue');
			const queueItems = (queue?.items ?? [])
				.map((q) => ({
					mediaKey:
						config.type === 'sonarr'
							? episodeKey(config.id, Number(q.episodeId))
							: movieKey(config.id, Number(q.movieId)),
					state: /import/i.test(q.trackedDownloadState)
						? ('importing' as const)
						: ('downloading' as const)
				}))
				.filter(
					(q) =>
						!q.mediaKey.includes(':unknown:') &&
						Number.isFinite(Number(q.mediaKey.split(':').pop()))
				);
			out.push({
				integrationId: config.id,
				sourceType: config.type,
				missing,
				events,
				queue: queueItems
			});
			succeeded++;
		} catch {
			// One unreadable integration must not silence the others — but it
			// does make this cycle's picture incomplete, so no close-outs run.
			continue;
		}
	}
	return { sources: out, complete: enabled === 0 || enabled === succeeded };
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

function relTime(now: number | undefined, at: number | null | undefined): string {
	if (!at) return 'unknown';
	const n = now ?? Date.now();
	const s = Math.max(0, Math.round((n - at) / 1000));
	if (s < 90) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 90) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

function relDuration(ms: number): string {
	const m = Math.round(ms / 60_000);
	if (m < 90) return `${m} min`;
	const h = m / 60;
	if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
	return `${Math.round(h / 24)} days`;
}

function percentile(sorted: number[], p: number): number {
	const s = [...sorted].sort((a, b) => a - b);
	const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
	return s[idx]!;
}

/** Minimal evaluation-only work item for ledger keys without a live source. */
function emptyWork(mediaKey: string): FlowWork {
	return {
		key: mediaKey,
		observations: [],
		title: 'Unknown',
		sourceType: 'sonarr',
		integrationId: '',
		mediaId: null,
		isMissing: false,
		lastGrabAt: null,
		lastFailureAt: null,
		lastImportAt: null,
		acquisitions: 0,
		classification: null
	};
}
