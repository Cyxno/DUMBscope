/**
 * DEEL 3 — interface customization preferences.
 *
 * Pins the safety envelope of the browser-local preference store: unknown or
 * corrupt data falls back to defaults without throwing, enum fields are
 * re-validated, Settings can never be hidden from the navigation, dashboards
 * normalize to the known widget set, presets resolve to the stock layouts,
 * and every default reproduces the pre-customization UI (§100/§101/§102).
 */
import { describe, expect, it } from 'vitest';
import {
	loadPreferences,
	savePreferences,
	DEFAULT_PREFERENCES,
	applyPreset,
	DASHBOARD_WIDGETS,
	PREFERENCES_KEY
} from '../src/lib/utils/preferences';

function storageWith(initial: Record<string, string>): Storage {
	const data: Record<string, string> = { ...initial };
	return {
		getItem: (key: string) => data[key] ?? null,
		setItem: (key: string, value: string) => {
			data[key] = value;
		},
		removeItem: (key: string) => delete data[key],
		clear: () => {
			for (const key of Object.keys(data)) delete data[key];
		},
		key: () => null,
		get length() {
			return Object.keys(data).length;
		}
	} as Storage;
}

describe('preferences store', () => {
	it('new users get the shipped defaults (identical to the pre-customization UI)', () => {
		const prefs = loadPreferences(storageWith({}));
		expect(prefs).toEqual(DEFAULT_PREFERENCES);
		expect(prefs.motion).toBe('system');
		expect(prefs.density).toBe('comfortable');
		expect(prefs.sidebarMode).toBe('expanded');
		expect(prefs.landingPage).toBe('/');
		expect(prefs.dashboardPreset).toBe('balanced');
		expect(prefs.libraryTab).toBe('overview');
		expect(prefs.posterSize).toBe('medium');
	});

	it('existing users without new keys keep defaults; stored values round-trip', () => {
		const store = storageWith({});
		savePreferences({ ...DEFAULT_PREFERENCES, density: 'dense', landingPage: '/library' }, store);
		const prefs = loadPreferences(store);
		expect(prefs.density).toBe('dense');
		expect(prefs.landingPage).toBe('/library');
		expect(prefs.chartPalette).toBe('default');
	});

	it('corrupt JSON falls back to safe defaults without crashing (§101)', () => {
		const store = storageWith({ [PREFERENCES_KEY]: '{not json at all' });
		const prefs = loadPreferences(store);
		expect(prefs).toEqual(DEFAULT_PREFERENCES);
	});

	it('unknown fields and wrong types are dropped, valid ones kept', () => {
		const store = storageWith({
			[PREFERENCES_KEY]: JSON.stringify({
				version: 1,
				density: 'dense',
				motion: 'teleport', // invalid enum → default
				navHidden: 'yes', // wrong type → default []
				textSize: 'large',
				someFutureField: true // unknown → dropped silently
			})
		});
		const prefs = loadPreferences(store);
		expect(prefs.density).toBe('dense');
		expect(prefs.textSize).toBe('large');
		expect(prefs.motion).toBe(DEFAULT_PREFERENCES.motion);
		expect(prefs.navHidden).toEqual([]);
	});

	it('Settings can never be hidden and unknown nav ids are filtered (§21)', () => {
		const store = storageWith({
			[PREFERENCES_KEY]: JSON.stringify({
				version: 1,
				navHidden: ['/settings', '/activity', '/nonexistent'],
				navOrder: ['/', '/bogus', '/library']
			})
		});
		const prefs = loadPreferences(store);
		expect(prefs.navHidden).not.toContain('/settings');
		expect(prefs.navHidden).not.toContain('/nonexistent');
		expect(prefs.navHidden).toContain('/activity');
		// Order normalizes to the known set, missing ids appended.
		expect(prefs.navOrder[0]).toBe('/');
		expect(prefs.navOrder).toContain('/pipeline');
	});

	it('dashboard order normalizes to the known widget set', () => {
		const store = storageWith({
			[PREFERENCES_KEY]: JSON.stringify({
				version: 1,
				dashboardOrder: ['reliability', 'pipeline'],
				dashboardHidden: ['pipeline', 'made-up']
			})
		});
		const prefs = loadPreferences(store);
		expect(prefs.dashboardOrder[0]).toBe('reliability');
		expect(prefs.dashboardOrder[1]).toBe('pipeline');
		for (const widget of DASHBOARD_WIDGETS) expect(prefs.dashboardOrder).toContain(widget);
		expect(prefs.dashboardHidden).not.toContain('made-up');
	});

	it('presets resolve to the documented layouts (§30-§34)', () => {
		const media = applyPreset('media');
		expect(media.order[0]).toBe('library');
		expect(media.hidden).toContain('reliability');

		const operations = applyPreset('operations');
		expect(operations.order[0]).toBe('reliability');
		expect(operations.hidden).toContain('library');

		const minimal = applyPreset('minimal');
		expect(minimal.hidden).toContain('integrations');

		const balanced = applyPreset('balanced');
		expect(balanced.order).toEqual([...DASHBOARD_WIDGETS]);
		expect(balanced.hidden).toEqual([]);
	});

	it('null storage (SSR / private mode) never throws', () => {
		expect(loadPreferences(null)).toEqual(DEFAULT_PREFERENCES);
		savePreferences(DEFAULT_PREFERENCES, null); // must not throw
	});
});
