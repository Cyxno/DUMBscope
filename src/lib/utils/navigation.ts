/**
 * Canonical sidebar navigation — single source of truth (brief §21-§24).
 *
 * Section membership is fixed here and must never be derived from stored
 * preferences: preferences may only reorder items (within their section) and
 * toggle visibility. Deriving membership from the preference order is what
 * produced the v0.5.1 duplicate-section regression (Monitor rendered the full
 * ordered list, Operate its own subset).
 */

export interface NavItemDef {
	href: string;
	label: string;
	/** Fixed section membership. '' = ungrouped footer item (Settings). */
	group: 'Monitor' | 'Operate' | '';
}

export const NAV_ITEMS: readonly NavItemDef[] = [
	{ href: '/', label: 'Overview', group: 'Monitor' },
	{ href: '/pipeline', label: 'Pipeline', group: 'Monitor' },
	{ href: '/services', label: 'Services', group: 'Monitor' },
	{ href: '/observability', label: 'Observability', group: 'Monitor' },
	{ href: '/library', label: 'Library', group: 'Monitor' },
	{ href: '/incidents', label: 'Incidents', group: 'Operate' },
	{ href: '/logs', label: 'Logs', group: 'Operate' },
	{ href: '/activity', label: 'Activity', group: 'Operate' },
	{ href: '/system', label: 'System', group: 'Operate' }
];

/** Canonical nav ids in default order (preference validation + settings UI). */
export const NAV_IDS: readonly string[] = NAV_ITEMS.map((item) => item.href);

/**
 * Normalize a stored nav order: drop unknown ids, dedupe repeats, and append
 * canonical items the stored list never mentioned (default order). A corrupt
 * or partial stored list can therefore never lose or duplicate routes.
 */
export function normalizeNavOrder(order: unknown): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	if (Array.isArray(order)) {
		for (const id of order) {
			if (typeof id === 'string' && !seen.has(id) && (NAV_IDS as readonly string[]).includes(id)) {
				seen.add(id);
				out.push(id);
			}
		}
	}
	for (const id of NAV_IDS) {
		if (!seen.has(id)) out.push(id);
	}
	return out;
}

export interface NavSectionDef {
	group: NavItemDef['group'];
	items: NavItemDef[];
}

/**
 * Sidebar sections for the given preferences. Group membership always comes
 * from the canonical config; `navOrder` only reorders items within their own
 * section, `navHidden` removes them from the sidebar (deep links stay
 * reachable). Every visible route appears in exactly one section exactly once.
 */
export function getNavigationSections(
	navOrder: readonly string[],
	navHidden: readonly string[]
): NavSectionDef[] {
	const order = normalizeNavOrder(navOrder);
	const hidden = new Set(navHidden);
	const sections: NavSectionDef[] = [];
	for (const group of ['Monitor', 'Operate'] as const) {
		const items = NAV_ITEMS.filter((item) => item.group === group && !hidden.has(item.href)).sort(
			(a, b) => order.indexOf(a.href) - order.indexOf(b.href)
		);
		if (items.length > 0) sections.push({ group, items });
	}
	return [...sections, { group: '', items: [{ href: '/settings', label: 'Settings', group: '' }] }];
}
