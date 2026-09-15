/**
 * Interface customization preferences (DEEL 3).
 *
 * Browser-local by design (brief §96/§151): stored in localStorage under one
 * versioned key, parsed defensively — corrupt or outdated JSON falls back to
 * safe defaults without crashing (brief §101/§102). Existing users upgrade to
 * exactly the current UI: every default matches the pre-customization look
 * (brief §100). Theme/accent/stream settings stay in the account settings;
 * everything here is per-browser.
 *
 * Changing preferences never triggers server traffic (brief §143).
 */

export type MotionPref = 'system' | 'reduced' | 'full';
export type DensityPref = 'comfortable' | 'compact' | 'dense';
export type ChartPalettePref = 'default' | 'colorblind' | 'monochrome';
export type SidebarMode = 'expanded' | 'compact' | 'icons';
export type LandingPage = '/' | '/pipeline' | '/library' | '/services' | '/incidents' | '/system';
export type DashboardPreset = 'balanced' | 'media' | 'operations' | 'minimal' | 'custom';
export type LibraryTab = 'overview' | 'tv' | 'movies' | 'subtitles' | 'queue';
export type PosterSize = 'small' | 'medium' | 'large';
export type DateStyle = 'relative' | 'absolute' | 'both';
export type TimeFormat = 'system' | '24' | '12';
export type UnitPref = 'auto' | 'gb' | 'gib';
export type StorageUnitPref = 'auto' | 'gb' | 'gib' | 'tb' | 'tib';
export type StatusDetail = 'simple' | 'detailed';

export interface Preferences {
	version: 1;
	/** Appearance */
	theme: 'system' | 'dark' | 'oled' | 'light';
	accent:
		| 'cyan'
		| 'blue'
		| 'indigo'
		| 'violet'
		| 'teal'
		| 'emerald'
		| 'amber'
		| 'rose'
		| 'orange'
		| 'slate';
	motion: MotionPref;
	density: DensityPref;
	chartPalette: ChartPalettePref;
	textSize: 'standard' | 'large';
	contrast: 'standard' | 'high';
	focusOutlines: 'standard' | 'enhanced';
	reduceTransparency: boolean;
	statusLabels: boolean;
	/** Navigation */
	sidebarMode: SidebarMode;
	landingPage: LandingPage;
	navOrder: string[];
	navHidden: string[];
	/** Dashboard */
	dashboardPreset: DashboardPreset;
	dashboardOrder: string[];
	dashboardHidden: string[];
	/** Library */
	libraryTab: LibraryTab;
	libraryView: 'grid' | 'list';
	posterSize: PosterSize;
	/** Data display */
	dateStyle: DateStyle;
	timeFormat: TimeFormat;
	memoryUnit: UnitPref;
	storageUnit: StorageUnitPref;
	statusDetail: StatusDetail;
	technicalIds: boolean;
}

export const PREFERENCES_KEY = 'dumbscope.prefs.v1';
export const PREFERENCES_VERSION = 1;

/** Canonical nav item ids (AppShell consumes these). */
import { NAV_IDS, normalizeNavOrder } from './navigation';

export { NAV_IDS };

export const LANDING_OPTIONS: { value: LandingPage; label: string }[] = [
	{ value: '/', label: 'Overview' },
	{ value: '/pipeline', label: 'Pipeline' },
	{ value: '/library', label: 'Library' },
	{ value: '/services', label: 'Services' },
	{ value: '/incidents', label: 'Incidents' },
	{ value: '/system', label: 'System' }
];

/** Overview widget ids, in the default (Balanced) order. */
export const DASHBOARD_WIDGETS = [
	'pipeline',
	'integrations',
	'library',
	'reliability',
	'stackHealth',
	'resources',
	'incidents',
	'history'
] as const;

export const WIDGET_LABELS: Record<string, string> = {
	pipeline: 'Pipeline summary',
	integrations: 'Integrations',
	library: 'Library summary',
	reliability: 'Reliability',
	stackHealth: 'Stack health',
	resources: 'System resources',
	incidents: 'Recent incidents',
	history: 'Resource history'
};

export const DASHBOARD_PRESETS: Record<
	Exclude<DashboardPreset, 'custom'>,
	{ label: string; description: string; order: string[]; hidden: string[] }
> = {
	balanced: {
		label: 'Balanced',
		description: 'The default overview — everything, current order',
		order: [...DASHBOARD_WIDGETS],
		hidden: []
	},
	media: {
		label: 'Media-focused',
		description: 'Library and pipeline first, incidents within reach',
		order: ['library', 'pipeline', 'integrations', 'incidents', 'history'],
		hidden: ['reliability', 'stackHealth', 'resources']
	},
	operations: {
		label: 'Operations',
		description: 'Reliability and resources up top for operations work',
		order: ['reliability', 'stackHealth', 'resources', 'pipeline', 'incidents', 'integrations'],
		hidden: ['library', 'history']
	},
	minimal: {
		label: 'Minimal',
		description: 'Just the essentials',
		order: ['pipeline', 'library', 'incidents'],
		hidden: ['reliability', 'stackHealth', 'resources', 'integrations', 'history']
	}
};

export const DEFAULT_PREFERENCES: Preferences = {
	version: PREFERENCES_VERSION,
	theme: 'dark',
	accent: 'cyan',
	motion: 'system',
	density: 'comfortable',
	chartPalette: 'default',
	textSize: 'standard',
	contrast: 'standard',
	focusOutlines: 'standard',
	reduceTransparency: false,
	statusLabels: false,
	sidebarMode: 'expanded',
	landingPage: '/',
	navOrder: [...NAV_IDS],
	navHidden: [],
	dashboardPreset: 'balanced',
	dashboardOrder: [...DASHBOARD_WIDGETS],
	dashboardHidden: [],
	libraryTab: 'overview',
	libraryView: 'grid',
	posterSize: 'medium',
	dateStyle: 'relative',
	timeFormat: 'system',
	memoryUnit: 'auto',
	storageUnit: 'auto',
	statusDetail: 'detailed',
	technicalIds: false
};

/** Fields that only make sense on a desktop pointer/screen (brief §103). */
export function isDesktopOnlyField(field: keyof Preferences): boolean {
	return field === 'sidebarMode';
}

function coerce(raw: unknown, defaults: Preferences): Preferences {
	if (typeof raw !== 'object' || raw === null) return { ...defaults };
	const input = raw as Record<string, unknown>;
	const out: Preferences = { ...defaults };
	// Only copy known fields with matching primitive types; anything corrupt,
	// unknown or structurally invalid simply keeps its default.
	for (const key of Object.keys(defaults) as (keyof Preferences)[]) {
		const value = input[key];
		const reference = defaults[key];
		if (Array.isArray(reference)) {
			// Accept any all-string array; membership normalization happens below.
			if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
				(out[key] as string[]) = value as string[];
			}
			continue;
		}
		if (typeof reference === 'boolean') {
			if (typeof value === 'boolean') (out[key] as boolean) = value;
			continue;
		}
		if (typeof reference === 'number') {
			if (typeof value === 'number' && Number.isFinite(value)) (out[key] as number) = value;
			continue;
		}
		if (typeof reference === 'string' && typeof value === 'string') {
			// String enums: accept only values seen in the defaults union —
			// approximated by accepting any string (the field's type documents
			// the union) but re-validating against the known option lists below.
			(out[key] as string) = value;
		}
	}
	// Re-validate string enums against their option sets.
	const enumChecks: [keyof Preferences, readonly string[]][] = [
		['theme', ['system', 'dark', 'oled', 'light']],
		[
			'accent',
			['cyan', 'blue', 'indigo', 'violet', 'teal', 'emerald', 'amber', 'rose', 'orange', 'slate']
		],
		['motion', ['system', 'reduced', 'full']],
		['density', ['comfortable', 'compact', 'dense']],
		['chartPalette', ['default', 'colorblind', 'monochrome']],
		['textSize', ['standard', 'large']],
		['contrast', ['standard', 'high']],
		['focusOutlines', ['standard', 'enhanced']],
		['sidebarMode', ['expanded', 'compact', 'icons']],
		['landingPage', LANDING_OPTIONS.map((o) => o.value)],
		['dashboardPreset', ['balanced', 'media', 'operations', 'minimal', 'custom']],
		['libraryTab', ['overview', 'tv', 'movies', 'subtitles', 'queue']],
		['libraryView', ['grid', 'list']],
		['posterSize', ['small', 'medium', 'large']],
		['dateStyle', ['relative', 'absolute', 'both']],
		['timeFormat', ['system', '24', '12']],
		['memoryUnit', ['auto', 'gb', 'gib']],
		['storageUnit', ['auto', 'gb', 'gib', 'tb', 'tib']],
		['statusDetail', ['simple', 'detailed']]
	];
	for (const [key, allowed] of enumChecks) {
		const value = out[key] as string;
		if (!allowed.includes(value)) (out[key] as string) = defaults[key] as string;
	}
	// Hidden nav may never hide Settings; landing must exist in the nav set.
	out.navHidden = out.navHidden.filter(
		(id) => id !== '/settings' && (NAV_IDS as readonly string[]).includes(id)
	);
	// Drop unknown ids, dedupe repeats, append never-mentioned canonical ids.
	out.navOrder = normalizeNavOrder(out.navOrder);
	out.dashboardHidden = out.dashboardHidden.filter((id) =>
		(DASHBOARD_WIDGETS as readonly string[]).includes(id)
	);
	out.dashboardOrder = [
		...out.dashboardOrder.filter((id) => (DASHBOARD_WIDGETS as readonly string[]).includes(id)),
		...DASHBOARD_WIDGETS.filter((id) => !out.dashboardOrder.includes(id))
	];
	if (!LANDING_OPTIONS.some((o) => o.value === out.landingPage)) out.landingPage = '/';
	return out;
}

/**
 * Load preferences defensively — never throws, never returns partial state.
 * `seed` supplies account defaults (DB theme/accent) for first runs so
 * existing users keep their stored theme (§100).
 */
export function loadPreferences(
	storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage,
	seed?: Partial<Pick<Preferences, 'theme' | 'accent'>>
): Preferences {
	const base = { ...DEFAULT_PREFERENCES, ...(seed ?? {}) };
	if (!storage) return base;
	try {
		const raw = storage.getItem(PREFERENCES_KEY);
		if (!raw) return base;
		return coerce(JSON.parse(raw), base);
	} catch {
		return base;
	}
}

export function savePreferences(
	prefs: Preferences,
	storage: Storage | null = typeof localStorage === 'undefined' ? null : localStorage
): void {
	if (!storage) return;
	try {
		storage.setItem(PREFERENCES_KEY, JSON.stringify({ ...prefs, version: PREFERENCES_VERSION }));
	} catch {
		// Storage full/unavailable: preferences stay in-memory for the session.
	}
}

/** Dashboard preset definitions resolved into order+hidden. */
export function applyPreset(preset: Exclude<DashboardPreset, 'custom'>): {
	order: string[];
	hidden: string[];
} {
	const def = DASHBOARD_PRESETS[preset];
	return { order: [...def.order], hidden: [...def.hidden] };
}
