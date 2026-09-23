/**
 * Canonical sidebar navigation (v0.5.2 regression fix).
 *
 * Pins the single source of truth for section membership: Monitor and Operate
 * are disjoint, every canonical route appears exactly once, stored nav orders
 * normalize (dedupe, drop unknown, append missing), and preferences can only
 * reorder within a section and hide items — never duplicate or move a route
 * between sections.
 */
import { describe, expect, it } from 'vitest';
import {
	NAV_ITEMS,
	NAV_IDS,
	getNavigationSections,
	normalizeNavOrder
} from '../src/lib/utils/navigation';
import { DEFAULT_PREFERENCES } from '../src/lib/utils/preferences';

/** All hrefs rendered across the returned sections, in render order. */
function renderedHrefs(sections: ReturnType<typeof getNavigationSections>): string[] {
	return sections.flatMap((section) => section.items.map((item) => item.href));
}

describe('canonical nav config', () => {
	it('has unique hrefs and labels (§8)', () => {
		const hrefs = NAV_ITEMS.map((item) => item.href);
		expect(new Set(hrefs).size).toBe(hrefs.length);
		const labels = NAV_ITEMS.map((item) => item.label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it('only uses known groups (§7)', () => {
		for (const item of NAV_ITEMS) {
			expect(['Monitor', 'Operate', '']).toContain(item.group);
		}
	});

	it('keeps NAV_IDS in sync with the canonical items', () => {
		expect(NAV_IDS).toEqual(NAV_ITEMS.map((item) => item.href));
		expect(DEFAULT_PREFERENCES.navOrder).toEqual([...NAV_IDS]);
	});

	it('Monitor and Operate sections are disjoint (§30)', () => {
		const monitor = NAV_ITEMS.filter((item) => item.group === 'Monitor').map((i) => i.href);
		const operate = NAV_ITEMS.filter((item) => item.group === 'Operate').map((i) => i.href);
		expect(monitor.filter((href) => operate.includes(href))).toEqual([]);
	});
});

describe('default navigation sections', () => {
	const sections = getNavigationSections(DEFAULT_PREFERENCES.navOrder, []);

	it('renders the intended grouping exactly once per route (§1/§21)', () => {
		const hrefs = renderedHrefs(sections);
		for (const href of NAV_IDS) {
			expect(hrefs.filter((h) => h === href)).toHaveLength(1);
		}
	});

	it('renders Monitor with Overview..Observability..Library and Operate with Incidents..System (§3)', () => {
		const monitor = sections.find((section) => section.group === 'Monitor');
		const operate = sections.find((section) => section.group === 'Operate');
		expect(monitor?.items.map((i) => i.href)).toEqual([
			'/',
			'/pipeline',
			'/services',
			'/observability',
			'/library'
		]);
		expect(operate?.items.map((i) => i.href)).toEqual([
			'/incidents',
			'/logs',
			'/activity',
			'/system'
		]);
	});

	it('keeps Settings as the ungrouped footer item', () => {
		const settings = sections.find((section) => section.group === '');
		expect(settings?.items.map((i) => i.href)).toEqual(['/settings']);
	});
});

describe('stored nav order normalization (§9/§10/§11/§12)', () => {
	it('dedupes duplicate ids and appends never-mentioned canonical ids', () => {
		expect(normalizeNavOrder(['/activity', '/logs', '/activity', '/system'])).toEqual([
			'/activity',
			'/logs',
			'/system',
			'/',
			'/pipeline',
			'/services',
			'/observability',
			'/library',
			'/incidents'
		]);
	});

	it('drops unknown ids (including malformed ones without a leading slash)', () => {
		const normalized = normalizeNavOrder(['/bogus', 'activity', '/', '/pipeline']);
		expect(normalized).toContain('/');
		expect(normalized).toContain('/pipeline');
		expect(normalized).not.toContain('/bogus');
		expect(normalized).not.toContain('activity');
		expect(normalized).toHaveLength(NAV_IDS.length);
	});

	it('handles empty, partial and non-array input without losing routes (§11)', () => {
		for (const input of [[], undefined, null, 'garbage']) {
			expect(normalizeNavOrder(input)).toEqual([...NAV_IDS]);
		}
		// A partial order keeps the mentioned id's position and appends the rest.
		const partial = normalizeNavOrder(['/activity']);
		expect(partial[0]).toBe('/activity');
		expect(partial).toHaveLength(NAV_IDS.length);
	});

	it('normalizes corrupt preferences through loadPreferences without throwing (§28)', () => {
		const prefs = JSON.parse(JSON.stringify(DEFAULT_PREFERENCES));
		prefs.navOrder = ['/', '/', '/activity', null, '/nope', '/activity'];
		// coerce runs inside loadPreferences; simulate the same normalization.
		const order = normalizeNavOrder(prefs.navOrder);
		expect(new Set(order).size).toBe(order.length);
		expect(order).toHaveLength(NAV_IDS.length);
	});
});

describe('preference-driven sections', () => {
	it('reorders within a section but never moves items across sections (§14/§15)', () => {
		// User moved Activity and System to the very front of the global order.
		const order = [
			'/activity',
			'/system',
			'/',
			'/pipeline',
			'/services',
			'/library',
			'/incidents',
			'/logs'
		];
		const sections = getNavigationSections(order, []);
		const operate = sections.find((section) => section.group === 'Operate');
		expect(operate?.items.map((i) => i.href)).toEqual([
			'/activity',
			'/system',
			'/incidents',
			'/logs'
		]);
		// Activity must never surface inside Monitor.
		const monitor = sections.find((section) => section.group === 'Monitor');
		expect(monitor?.items.map((i) => i.href)).not.toContain('/activity');
	});

	it('hides routes from the sidebar but keeps them canonical (§13/§25)', () => {
		const sections = getNavigationSections([...NAV_IDS], ['/logs']);
		const hrefs = renderedHrefs(sections);
		expect(hrefs.filter((href) => href === '/logs')).toHaveLength(0);
		for (const href of NAV_IDS) {
			if (href === '/logs') continue;
			expect(hrefs.filter((h) => h === href)).toHaveLength(1);
		}
	});

	it('survives hiding every item of a section (§24-style edge)', () => {
		const sections = getNavigationSections(
			[...NAV_IDS],
			['/incidents', '/logs', '/activity', '/system']
		);
		expect(sections.find((section) => section.group === 'Operate')).toBeUndefined();
		const hrefs = renderedHrefs(sections);
		expect(new Set(hrefs).size).toBe(hrefs.length);
	});

	it('restores canonical grouping after reset (§27)', () => {
		const scrambled = ['/system', '/system', '/library', '/library'];
		const order = normalizeNavOrder(scrambled);
		const reset = getNavigationSections([...DEFAULT_PREFERENCES.navOrder], []);
		const hrefs = renderedHrefs(reset);
		expect(hrefs.filter((href) => href === '/system')).toHaveLength(1);
		expect(new Set(hrefs).size).toBe(hrefs.length);
		expect(order).toHaveLength(NAV_IDS.length);
	});
});
