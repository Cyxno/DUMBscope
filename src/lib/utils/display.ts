/**
 * Preferences-aware display helpers (DEEL 3, brief §83-§88).
 *
 * Formatting reads the browser-local customization at call time: units
 * (GB/GiB), time format (12/24h), status detail level and technical
 * identifiers. Defaults reproduce the historical output exactly (§100).
 */
import { prefs } from '$lib/stores/prefs.svelte';

function unitScale(unit: 'auto' | 'gb' | 'gib' | 'tb' | 'tib'): { base: number; labels: string[] } {
	const decimal = unit === 'gb' || unit === 'tb';
	const base = decimal ? 1000 : 1024;
	if (unit === 'tb' || unit === 'tib') return { base, labels: ['B', 'KB', 'MB', 'GB', 'TB'] };
	return { base, labels: ['B', 'KB', 'MB', 'GB'] };
}

/** Bytes with the configured memory/storage unit behaviour. */
export function formatBytesPref(
	bytes: number | null | undefined,
	kind: 'memory' | 'storage' = 'memory'
): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
	if (bytes === 0) return '0 B';
	const unit = kind === 'memory' ? prefs.memoryUnit : prefs.storageUnit;
	if (unit === 'auto') {
		// Historical behaviour: binary steps with decimal GB labels.
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
		return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
	}
	const { base, labels } = unitScale(unit);
	let value = bytes;
	let i = 0;
	while (value >= base && i < labels.length - 1) {
		value /= base;
		i++;
	}
	return `${value.toFixed(i === 0 ? 0 : 1)} ${labels[i]}`;
}

/** Clock formatting honouring the 12/24-hour preference. */
export function formatClock(date: Date): string {
	const hour12 = prefs.timeFormat === '12' ? true : prefs.timeFormat === '24' ? false : undefined;
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12 });
}

/** Full timestamp honouring the time preference. */
export function formatTimestamp(ms: number): string {
	const d = new Date(ms);
	if (prefs.timeFormat === '12' || prefs.timeFormat === 'system') {
		return d.toLocaleString([], {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			hour12: prefs.timeFormat === '12'
		});
	}
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	return `${d.toLocaleString([], { month: 'short', day: 'numeric' })} ${hh}:${mm}`;
}

/**
 * Status copy at the configured detail level (§87): simple collapses amber
 * nuance into "Attention" — detailed keeps the honest state vocabulary.
 */
export function statusCopy(state: string): string {
	if (prefs.statusDetail === 'simple') {
		const simple: Record<string, string> = {
			live: 'Connected',
			connected: 'Connected',
			starting: 'Starting',
			connecting: 'Starting',
			reconnecting: 'Attention',
			degraded: 'Attention',
			stale: 'Attention',
			offline: 'Problem',
			'credentials-invalid': 'Problem',
			healthy: 'Healthy',
			unhealthy: 'Problem',
			unconfigured: 'Not configured'
		};
		return simple[state] ?? state;
	}
	const detailed: Record<string, string> = {
		live: 'Connected',
		starting: 'Starting',
		reconnecting: 'Reconnecting',
		degraded: 'Degraded',
		stale: 'Stale — recovering',
		offline: 'Unreachable',
		'credentials-invalid': 'Authentication failed'
	};
	return detailed[state] ?? state;
}

/** Technical identifiers line (§88): only rendered when enabled. */
export function techLine(parts: Record<string, string | number | null>): string | null {
	if (!prefs.technicalIds) return null;
	const usable = Object.entries(parts)
		.filter(([, v]) => v !== null && v !== undefined && v !== '')
		.map(([k, v]) => `${k}=${v}`);
	return usable.length > 0 ? usable.join(' · ') : null;
}
