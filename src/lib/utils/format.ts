/** Formatting helpers shared by every page. */

export function formatBytes(bytes: number | null | undefined, digits = 1): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return '—';
	return `${value.toFixed(digits)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ${minutes % 60}m`;
	const days = Math.floor(hours / 24);
	return `${days}d ${hours % 24}h`;
}

export function formatTime(ts: number | null | undefined): string {
	if (!ts) return '—';
	return new Date(ts).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
}

export function formatClock(ts: number | null | undefined): string {
	if (!ts) return '—';
	return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(ts: number | null | undefined): string {
	if (!ts) return '—';
	return new Date(ts).toLocaleString([], {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
}

export function relativeTime(ts: number | null | undefined, now = Date.now()): string {
	if (!ts) return 'never';
	const delta = Math.max(0, now - ts);
	const seconds = Math.round(delta / 1000);
	if (seconds < 5) return 'just now';
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

export function titleCase(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}
