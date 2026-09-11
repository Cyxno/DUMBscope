/**
 * QA demo overrides must be production-safe: ignored unless the deployment
 * explicitly opts in (PUBLIC_QA_DEMOS=1), and purely a presentation concern.
 */
import { describe, expect, it } from 'vitest';
import { pipelineDemoFromUrl } from '../src/lib/pipeline/demo';

const url = (demo: string) => new URL(`https://dumbscope.local/?demo=${demo}`);

describe('pipeline demo overrides', () => {
	it('parses known demos when enabled', () => {
		expect(pipelineDemoFromUrl(url('failure'), true)).toBe('failure');
		expect(pipelineDemoFromUrl(url('stale'), true)).toBe('stale');
	});

	it('ignores unknown demo values even when enabled', () => {
		expect(pipelineDemoFromUrl(url('nonsense'), true)).toBeNull();
	});

	it('ignores demo params entirely when not enabled (production default)', () => {
		expect(pipelineDemoFromUrl(url('failure'), false)).toBeNull();
		expect(pipelineDemoFromUrl(url('stale'), false)).toBeNull();
		expect(pipelineDemoFromUrl(new URL('https://dumbscope.local/'), true)).toBeNull();
	});
});
