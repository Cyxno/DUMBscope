/**
 * Reactive customization store (DEEL 3): loads browser-local preferences once,
 * exposes them as Svelte 5 state and applies the presentation attributes to
 * <html> so the design system reacts (brief §97: live apply, no save button).
 */
import {
	loadPreferences,
	savePreferences,
	DEFAULT_PREFERENCES,
	type Preferences
} from '../utils/preferences';

function initial(seed?: { theme?: string; accent?: string }): Preferences {
	if (typeof window === 'undefined') return { ...DEFAULT_PREFERENCES };
	return loadPreferences(
		window.localStorage,
		seed as { theme: Preferences['theme']; accent: Preferences['accent'] }
	);
}

export const prefs = $state<Preferences>(initial());

let initialized = false;

/** Apply presentation attributes + persist. Call once from the app layout. */
export function initPreferences(seed?: { theme?: string; accent?: string }): void {
	console.log('[prefs] init seed', JSON.stringify(seed), 'initialized:', initialized);
	if (typeof document !== 'undefined' && !initialized) {
		// Re-seed when a stored set predates theme/accent moving browser-local.
		const stored = localStorage.getItem('dumbscope.prefs.v1');
		if (stored) {
			try {
				const parsed = JSON.parse(stored) as Record<string, unknown>;
				if (typeof parsed.theme !== 'string') {
					prefs.theme =
						seed?.theme !== undefined ? (seed.theme as Preferences['theme']) : prefs.theme;
					prefs.accent =
						seed?.accent !== undefined ? (seed.accent as Preferences['accent']) : prefs.accent;
					savePreferences(prefs);
				}
			} catch {
				/* defaults apply */
			}
		}
	}
	if (initialized || typeof document === 'undefined') return;
	initialized = true;
	applyAttributes(prefs);
	// Resolve 'system' motion live (brief §14: respect prefers-reduced-motion).
	if (typeof matchMedia !== 'undefined') {
		const query = matchMedia('(prefers-reduced-motion: reduce)');
		query.addEventListener('change', () => applyMotion(prefs.motion));
	}
}

export function updatePreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
	console.log('[prefs] update', key, '=', value);
	prefs[key] = value;
	savePreferences(prefs);
	applyAttributes(prefs);
}

/** Replace the whole preference set (presets, reset). */
export function replacePreferences(next: Preferences): void {
	Object.assign(prefs, next);
	savePreferences(prefs);
	applyAttributes(prefs);
}

/** Reset everything back to the shipped defaults (brief §99/§227). */
export function resetPreferences(): void {
	replacePreferences({ ...DEFAULT_PREFERENCES });
}

function applyAttributes(p: Preferences): void {
	if (typeof document === 'undefined') return;
	const root = document.documentElement;
	// Theme: 'system' resolves through the OS color-scheme preference.
	if (typeof matchMedia !== 'undefined') {
		const scheme = matchMedia('(prefers-color-scheme: light)');
		const resolveTheme = () => {
			root.dataset.theme = p.theme === 'system' ? (scheme.matches ? 'light' : 'dark') : p.theme;
		};
		resolveTheme();
		scheme.removeEventListener('change', resolveTheme);
		scheme.addEventListener('change', resolveTheme);
	} else {
		root.dataset.theme = p.theme === 'system' ? 'dark' : p.theme;
	}
	root.dataset.accent = p.accent;
	applyMotion(p.motion);
	root.dataset.density = p.density;
	root.dataset.chartPalette = p.chartPalette;
	root.dataset.textSize = p.textSize;
	root.dataset.contrast = p.contrast;
	root.dataset.focus = p.focusOutlines;
	root.dataset.transparency = p.reduceTransparency ? 'reduced' : 'standard';
	root.dataset.statusLabels = String(p.statusLabels);
}

function applyMotion(motion: Preferences['motion']): void {
	if (typeof document === 'undefined') return;
	const systemReduced =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	const reduced = motion === 'reduced' || (motion === 'system' && systemReduced);
	document.documentElement.dataset.reducedMotion = String(reduced);
	document.documentElement.dataset.motion = motion;
}
