/**
 * Media finding lifecycle (v0.8): the correlator must resolve findings via a
 * complete-cycle open/close sweep, must never resolve on incomplete data,
 * and a "repeated acquisition request" must resolve when the acquisition is
 * no longer verifiably active.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
	MediaFlowCorrelator,
	type ArrObservation,
	type ArrSourceBatch,
	type MediaFinding
} from '../src/lib/server/media/flow';
import { AcquisitionLedger } from '../src/lib/server/media/ledger';
import { episodeKey } from '../src/lib/server/media/identity';
import { getDb } from '../src/lib/server/database/db';

const MIN = 60_000;
let now = 1_750_000_000_000;

function observation(overrides: Partial<ArrObservation> = {}): ArrObservation {
	return {
		integrationId: 'sonarr-a',
		sourceType: 'sonarr',
		missing: [],
		events: [],
		queue: [],
		...overrides
	};
}

function grab(
	episodeId: number,
	requestId: string,
	ageMin: number
): ArrObservation['events'][number] {
	return {
		requestId,
		mediaKey: episodeKey('sonarr-a', episodeId),
		title: 'Some Show S01E01',
		client: 'SABnzbd',
		event: 'grabbed',
		at: now - ageMin * MIN
	};
}

interface Harness {
	findings: MediaFinding[];
	resolved: { fp: string; message: string }[];
	open: Set<string>;
	correlator: MediaFlowCorrelator;
}

function build(openFps: string[] = []): Harness {
	const h: Harness = { findings: [], resolved: [], open: new Set(openFps), correlator: null! };
	h.correlator = new MediaFlowCorrelator({
		now: () => now,
		ledger: new AcquisitionLedger(() => now),
		loader: async () => ({ sources: [], complete: true }),
		getActiveFingerprints: () => [...h.open],
		onFinding: (f) => {
			h.findings.push(f);
			h.open.add(f.fingerprint);
		},
		onResolve: (fp, message) => {
			h.resolved.push({ fp, message });
			h.open.delete(fp);
		}
	});
	(h.correlator as unknown as { t: Record<string, number> }).t.cycleMs = 0;
	return h;
}

beforeEach(() => {
	now = 1_750_000_000_000;
	getDb().prepare('DELETE FROM media_acquisitions').run();
	getDb().prepare('DELETE FROM remediation_actions').run();
});

describe('complete-cycle close sweep', () => {
	it('resolves a repeat finding whose item vanished from the ledger window', async () => {
		const h = build();
		const mediaKey = episodeKey('sonarr-a', 7);

		// Cycle 1: two grabs, previous never completed, item missing → repeat.
		await h.correlator.tick({
			mountUnhealthy: false,
			mountLabel: null
		});
		// Feed observations by swapping the loader output through a direct cycle.
		const sources = () => [
			observation({
				missing: [{ mediaKey, title: 'Show', mediaId: 7 }],
				events: [grab(7, 'req-1', 90), grab(7, 'req-2', 5)]
			})
		];
		(h.correlator as unknown as { loader: () => Promise<ArrSourceBatch> }).loader = async () => ({
			sources: sources(),
			complete: true
		});
		await h.correlator.tick({ mountUnhealthy: false, mountLabel: null });
		expect(h.open.has(`media-repeat:${mediaKey}`)).toBe(true);

		// Cycle 2 (later than the ledger window): the item aged out of history
		// entirely. The close sweep must resolve the stale finding.
		now += 80 * 60_000;
		(h.correlator as unknown as { loader: () => Promise<ArrSourceBatch> }).loader = async () => ({
			sources: [],
			complete: true
		});
		await h.correlator.tick({ mountUnhealthy: false, mountLabel: null });
		expect(h.open.has(`media-repeat:${mediaKey}`)).toBe(false);
		expect(h.resolved.some((r) => r.fp === `media-repeat:${mediaKey}`)).toBe(true);
	});

	it('never resolves when any enabled Arr read failed (incomplete cycle)', async () => {
		const h = build([`media-failing:${episodeKey('sonarr-a', 9)}`]);
		(h.correlator as unknown as { loader: () => Promise<ArrSourceBatch> }).loader = async () => ({
			sources: [],
			complete: false
		});
		await h.correlator.tick({ mountUnhealthy: false, mountLabel: null });
		expect(h.open.has(`media-failing:${episodeKey('sonarr-a', 9)}`)).toBe(true);
		expect(h.resolved).toHaveLength(0);
	});
});

describe('repeat active-work verification', () => {
	it('resolves the repeat when the acquisition becomes inactive (imported)', async () => {
		const h = build();
		const mediaKey = episodeKey('sonarr-a', 3);
		(h.correlator as unknown as { loader: () => Promise<ArrSourceBatch> }).loader = async () => ({
			sources: [
				observation({
					missing: [{ mediaKey, title: 'Show', mediaId: 3 }],
					events: [grab(3, 'req-1', 200), grab(3, 'req-2', 100)]
				})
			],
			complete: true
		});
		await h.correlator.tick({ mountUnhealthy: false, mountLabel: null });
		expect(h.open.has(`media-repeat:${mediaKey}`)).toBe(true);

		// The item imports and the Arr stops reporting it missing.
		now += 20 * MIN;
		(h.correlator as unknown as { loader: () => Promise<ArrSourceBatch> }).loader = async () => ({
			sources: [
				observation({
					missing: [],
					events: [
						grab(3, 'req-1', 220),
						grab(3, 'req-2', 120),
						{
							requestId: 'req-2',
							mediaKey,
							title: 'Show',
							client: 'SABnzbd',
							event: 'downloadFolderImported',
							at: now - 2 * MIN
						}
					]
				})
			],
			complete: true
		});
		await h.correlator.tick({ mountUnhealthy: false, mountLabel: null });
		expect(h.open.has(`media-repeat:${mediaKey}`)).toBe(false);
	});

	it('does not hold the repeat open for a silent cluster (nothing missing, queued, or recent)', async () => {
		const h = build();
		const mediaKey = episodeKey('sonarr-a', 11);
		// Two grabs 30h back, item NOT missing, no queue, no recent activity.
		(h.correlator as unknown as { loader: () => Promise<ArrSourceBatch> }).loader = async () => ({
			sources: [
				observation({
					missing: [],
					events: [grab(11, 'req-1', 1_800), grab(11, 'req-2', 1_795)]
				})
			],
			complete: true
		});
		await h.correlator.tick({ mountUnhealthy: false, mountLabel: null });
		expect(h.open.has(`media-repeat:${mediaKey}`)).toBe(false);
	});
});
