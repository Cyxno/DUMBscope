/**
 * DEEL 2 — cross-service media state correlation.
 *
 * Drives the MediaFlowCorrelator with an injected loader and controlled
 * clock over the real acquisition ledger (SQLite). Pins the rules from the
 * root-cause investigation (docs/MEDIA-CORRELATION.md): acquisition-active
 * overrides plain missing, eventual consistency never warns, repeats need an
 * active previous request, identity is instance-namespaced and never
 * title-based, and out-of-order/late events never regress state.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
	MediaFlowCorrelator,
	type ArrObservation,
	type MediaFinding
} from '../src/lib/server/media/flow';
import { AcquisitionLedger, LEDGER_TUNING } from '../src/lib/server/media/ledger';
import { episodeKey, movieKey, acquisitionPath } from '../src/lib/server/media/identity';
import { getDb } from '../src/lib/server/database/db';

const MIN = 60_000;

function observation(
	integrationId: string,
	overrides: Partial<ArrObservation> = {}
): ArrObservation {
	return {
		integrationId,
		sourceType: 'sonarr',
		missing: [],
		events: [],
		queue: [],
		...overrides
	};
}

describe('media flow correlation', () => {
	let now: number;
	let clock: () => number;
	let findings: MediaFinding[];
	let resolved: string[];
	let loader: () => Promise<ArrObservation[]>;
	let correlator: MediaFlowCorrelator;

	beforeEach(() => {
		now = 1_750_000_000_000;
		clock = () => now;
		findings = [];
		resolved = [];
		loader = async () => [];
		// Test isolation: the SQLite store is per-file, so clear the ledger.
		getDb().prepare('DELETE FROM media_acquisitions').run();
		getDb().prepare('DELETE FROM remediation_actions').run();
		correlator = new MediaFlowCorrelator({
			now: clock,
			loader: () => loader(),
			onFinding: (f) => findings.push(f),
			onResolve: (fp) => resolved.push(fp)
		});
		// Cycle throttle: run every tick in tests.
		(correlator as unknown as { t: Record<string, number> }).t.cycleMs = 0;
	});

	async function tick(context = { mountUnhealthy: false, mountLabel: null }): Promise<void> {
		await correlator.tick(context);
	}

	const grab = (
		integrationId: string,
		episodeId: number,
		requestId: string,
		ageMin: number,
		client = 'SABnzbd'
	): ArrObservation['events'][number] => ({
		requestId,
		mediaKey: episodeKey(integrationId, episodeId),
		title: 'Some Show S01E01',
		client,
		event: 'grabbed',
		at: now - ageMin * MIN
	});

	it('missing only: honest missing state, no finding', async () => {
		loader = async () => [
			observation('sonarr-a', {
				missing: [{ mediaKey: episodeKey('sonarr-a', 1), title: 'Some Show S01E01', mediaId: 1 }]
			})
		];
		await tick();
		expect(findings).toHaveLength(0);
		expect(correlator.snapshot().items[0]!.summary).toBe('missing');
	});

	it('missing + recent accepted grab: acquiring overrides missing (brief §15), no finding', async () => {
		loader = async () => [
			observation('sonarr-a', {
				missing: [{ mediaKey: episodeKey('sonarr-a', 1), title: 'Some Show S01E01', mediaId: 1 }],
				events: [grab('sonarr-a', 1, 'req-1', 4)]
			})
		];
		await tick();
		expect(findings).toHaveLength(0);
		const item = correlator.snapshot().items[0]!;
		expect(item.summary).toBe('acquiring');
		// Raw source state stays visible (brief §13).
		expect(item.observations.some((o) => o.source === 'sonarr' && o.state === 'missing')).toBe(
			true
		);
		expect(item.observations.some((o) => o.source === 'infinidysk' && o.state === 'accepted')).toBe(
			true
		);
	});

	it('repeated request while active: warning finding with count', async () => {
		loader = async () => [
			observation('sonarr-a', {
				missing: [{ mediaKey: episodeKey('sonarr-a', 1), title: 'Some Show S01E01', mediaId: 1 }],
				events: [grab('sonarr-a', 1, 'req-1', 20), grab('sonarr-a', 1, 'req-2', 5)]
			})
		];
		await tick();
		const repeat = findings.find((f) => f.fingerprint.startsWith('media-repeat:'));
		expect(repeat).toBeDefined();
		expect(repeat!.summary).toContain('2 requests');
	});

	it('a request after a completed acquisition is NOT a repeat (shield, brief §20)', async () => {
		loader = async () => [
			observation('sonarr-a', {
				events: [
					{ ...grab('sonarr-a', 1, 'req-1', 48 * 60), event: 'grabbed' },
					{
						requestId: 'req-1',
						mediaKey: episodeKey('sonarr-a', 1),
						title: 'Some Show S01E01',
						client: 'SABnzbd',
						event: 'downloadFolderImported',
						at: now - 47 * 60 * MIN
					},
					grab('sonarr-a', 1, 'req-2', 5)
				]
			})
		];
		await tick();
		expect(findings.find((f) => f.fingerprint.startsWith('media-repeat:'))).toBeUndefined();
	});

	it('imported inside grace: no mismatch warning', async () => {
		loader = async () => [
			observation('sonarr-a', {
				missing: [{ mediaKey: episodeKey('sonarr-a', 1), title: 'Some Show S01E01', mediaId: 1 }],
				events: [
					grab('sonarr-a', 1, 'req-1', 12),
					{
						requestId: 'req-1',
						mediaKey: episodeKey('sonarr-a', 1),
						title: 'x',
						client: 'SABnzbd',
						event: 'downloadFolderImported',
						at: now - 5 * MIN
					}
				]
			})
		];
		await tick();
		expect(findings.find((f) => f.fingerprint.startsWith('media-mismatch:'))).toBeUndefined();
	});

	it('imported but still missing beyond grace: mismatch warning opens', async () => {
		loader = async () => [
			observation('sonarr-a', {
				missing: [{ mediaKey: episodeKey('sonarr-a', 1), title: 'Some Show S01E01', mediaId: 1 }],
				events: [
					grab('sonarr-a', 1, 'req-1', 40),
					{
						requestId: 'req-1',
						mediaKey: episodeKey('sonarr-a', 1),
						title: 'x',
						client: 'SABnzbd',
						event: 'downloadFolderImported',
						at: now - 20 * MIN
					}
				]
			})
		];
		await tick();
		const mismatch = findings.find((f) => f.fingerprint.startsWith('media-mismatch:'));
		expect(mismatch).toBeDefined();
		expect(mismatch!.title).toContain('state mismatch');
	});

	it('repeated failures while missing: acquisition keeps failing; with unhealthy mount: mount-unavailable', async () => {
		const events = ['req-1', 'req-2', 'req-3'].map((id, i) => grab('sonarr-a', 1, id, 30 - i * 10));
		const failed = ['req-1', 'req-2', 'req-3'].map((id, i) => ({
			requestId: id,
			mediaKey: episodeKey('sonarr-a', 1),
			title: 'Some Show S01E01',
			client: 'SABnzbd',
			event: 'downloadFailed' as const,
			at: now - (29 - i * 10) * MIN
		}));
		loader = async () => [
			observation('sonarr-a', {
				missing: [{ mediaKey: episodeKey('sonarr-a', 1), title: 'Some Show S01E01', mediaId: 1 }],
				events: [...events, ...failed]
			})
		];
		await tick({ mountUnhealthy: false, mountLabel: null });
		expect(findings.find((f) => f.fingerprint.startsWith('media-failing:'))).toBeDefined();

		findings = [];
		await tick({ mountUnhealthy: true, mountLabel: 'TV symlink root' } as never);
		const item = correlator.snapshot().items.find((i) => i.classification === 'mount-unavailable');
		expect(item).toBeDefined();
	});

	it('multi-instance: the same episode id on two Sonarr instances never collides (§64)', async () => {
		loader = async () => [
			observation('sonarr-a', {
				events: [grab('sonarr-a', 7, 'req-a', 5)]
			}),
			observation('sonarr-b', {
				events: [grab('sonarr-b', 7, 'req-b', 5, 'qBittorrent')]
			})
		];
		await tick();
		expect(episodeKey('sonarr-a', 7)).not.toBe(episodeKey('sonarr-b', 7));
		expect(correlator.snapshot().items).toHaveLength(2);
		expect(findings).toHaveLength(0); // separate items: no cross-instance repeat
	});

	it('radarr movies use their own namespaced key', async () => {
		loader = async () => [
			{
				...observation('radarr-a', { sourceType: 'radarr' as const }),
				missing: [{ mediaKey: movieKey('radarr-a', 42), title: 'Some Movie (2026)', mediaId: 42 }]
			}
		];
		await tick();
		const item = correlator.snapshot().items[0]!;
		expect(item.mediaKey).toBe('radarr:radarr-a:movie:42');
		expect(item.summary).toBe('missing');
	});

	it('late grabbed event never regresses an imported item (§66)', async () => {
		loader = async () => [
			observation('sonarr-a', {
				events: [
					grab('sonarr-a', 1, 'req-1', 30),
					{
						requestId: 'req-1',
						mediaKey: episodeKey('sonarr-a', 1),
						title: 'x',
						client: 'SABnzbd',
						event: 'downloadFolderImported',
						at: now - 25 * MIN
					},
					// Late-arriving duplicate grab frame with an older timestamp.
					grab('sonarr-a', 1, 'req-1', 29)
				]
			})
		];
		await tick();
		const item = correlator.snapshot().items[0]!;
		expect(item.summary).toBe('available');
	});

	it('queue presence reports downloading and suppresses findings', async () => {
		loader = async () => [
			observation('sonarr-a', {
				missing: [{ mediaKey: episodeKey('sonarr-a', 1), title: 'Some Show S01E01', mediaId: 1 }],
				queue: [{ mediaKey: episodeKey('sonarr-a', 1), state: 'downloading' }]
			})
		];
		await tick();
		expect(correlator.snapshot().items[0]!.summary).toBe('downloading');
		expect(findings).toHaveLength(0);
	});
});

describe('acquisition ledger', () => {
	let now: number;
	let ledger: AcquisitionLedger;

	beforeEach(() => {
		now = 1_750_000_000_000;
		getDb().prepare('DELETE FROM media_acquisitions').run();
		ledger = new AcquisitionLedger(() => now);
	});

	it('dedupes on (integration, requestId) — poll retries create no rows', () => {
		ledger.observe({
			integrationId: 'sonarr-a',
			requestId: 'r1',
			mediaKey: episodeKey('sonarr-a', 1),
			title: 'x',
			client: 'SABnzbd',
			event: 'grabbed',
			at: now
		});
		const again = ledger.observe({
			integrationId: 'sonarr-a',
			requestId: 'r1',
			mediaKey: episodeKey('sonarr-a', 1),
			title: 'x',
			client: 'SABnzbd',
			event: 'grabbed',
			at: now + MIN
		});
		expect(again!.firstSeen).toBe(now);
		expect(again!.lastObservedAt).toBe(now + MIN);
		expect(ledger.forMedia(episodeKey('sonarr-a', 1))).toHaveLength(1);
	});

	it('state moves forward: completion survives a later failure frame (COALESCE)', () => {
		ledger.observe({
			integrationId: 'sonarr-a',
			requestId: 'r1',
			mediaKey: episodeKey('sonarr-a', 1),
			title: 'x',
			client: 'SABnzbd',
			event: 'grabbed',
			at: now
		});
		ledger.observe({
			integrationId: 'sonarr-a',
			requestId: 'r1',
			mediaKey: episodeKey('sonarr-a', 1),
			title: 'x',
			client: 'SABnzbd',
			event: 'downloadFolderImported',
			at: now + MIN
		});
		const lateFailure = ledger.observe({
			integrationId: 'sonarr-a',
			requestId: 'r1',
			mediaKey: episodeKey('sonarr-a', 1),
			title: 'x',
			client: 'SABnzbd',
			event: 'downloadFailed',
			at: now
		});
		// The late failure cannot erase the recorded completion.
		expect(lateFailure!.completedAt).toBe(now + MIN);
	});

	it('prunes beyond retention and the hard cap', () => {
		const db = getDb();
		const insert = db.prepare(
			"INSERT OR IGNORE INTO media_acquisitions (integration_id, request_id, media_key, title, client, first_seen, last_observed_at) VALUES ('prune', ?, 'k', 't', NULL, ?, ?)"
		);
		insert.run(
			'old',
			now - (LEDGER_TUNING.retentionDays + 2) * 86_400_000,
			now - (LEDGER_TUNING.retentionDays + 2) * 86_400_000
		);
		insert.run('fresh', now - MIN, now - MIN);
		// Trigger prune via an observe.
		ledger.observe({
			integrationId: 'prune',
			requestId: 'trigger',
			mediaKey: 'k2',
			title: 't',
			client: null,
			event: 'grabbed',
			at: now
		});
		const rows = db
			.prepare("SELECT request_id FROM media_acquisitions WHERE integration_id = 'prune'")
			.all() as { request_id: string }[];
		expect(rows.map((r) => r.request_id)).not.toContain('old');
		expect(rows.map((r) => r.request_id)).toContain('fresh');
	});
});

describe('identity helpers', () => {
	it('maps emulated client labels to acquisition paths (source audit, §5/§6)', () => {
		expect(acquisitionPath('SABnzbd')).toBe('infinidysk');
		expect(acquisitionPath('qBittorrent')).toBe('decypharr');
		expect(acquisitionPath('something-else')).toBe('other');
		expect(acquisitionPath(null)).toBeNull();
	});
});
