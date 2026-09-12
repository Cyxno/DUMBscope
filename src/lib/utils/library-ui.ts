/**
 * Client-side presentation helpers for the library browsers: human labels,
 * calm status colors (§88-§91) and compact quality badges (§92). All display
 * formatting happens here — API payloads carry normalized data only (§55).
 */

export function qualityBadge(name: string | null): string | null {
	if (!name) return null;
	// Structured names like WEBDL-1080p / Bluray-2160p / HDTV-720p.
	const match = /^([A-Za-z]+)-(\d+[pi])$/i.exec(name);
	if (!match) return name;
	const source = match[1]!.toLowerCase();
	const resolution = match[2]!.toLowerCase();
	const sourceLabel =
		source === 'webdl'
			? 'WEB-DL'
			: source === 'webrip'
				? 'WEBRip'
				: source === 'bluray'
					? 'Blu-ray'
					: source === 'blurayremux'
						? 'Remux'
						: source === 'hdtv'
							? 'HDTV'
							: source === 'dvd'
								? 'DVD'
								: source.toUpperCase();
	return `${sourceLabel} ${resolution.toUpperCase()}`;
}

export function resolutionBadge(resolution: number | null): string | null {
	if (resolution === null) return null;
	return resolution >= 1000 ? `${resolution}p` : `${resolution}p`;
}

/** Calm status palette: missing = amber-light, never critical red (§89). */
export function episodeStateClass(state: string): string {
	switch (state) {
		case 'available':
			return 'text-healthy';
		case 'missing':
			return 'text-degraded';
		case 'downloading':
			return 'text-accent-text';
		case 'queued':
		case 'importing':
			return 'text-accent-text';
		case 'future':
			return 'text-text-faint';
		case 'unmonitored':
			return 'text-text-faint';
		default:
			return 'text-text-muted';
	}
}

export function formatDate(ts: number | null | undefined): string {
	if (!ts) return '—';
	return new Date(ts).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export function daysAgo(ts: number | null | undefined, now = Date.now()): string {
	if (!ts) return '—';
	const days = Math.floor((now - ts) / 86_400_000);
	if (days < 0) return `in ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`;
	if (days === 0) return 'today';
	if (days === 1) return 'yesterday';
	return `${days} days ago`;
}

export function seriesStatusClass(status: string): string {
	if (status === 'continuing') return 'text-healthy';
	if (status === 'ended') return 'text-text-muted';
	return 'text-text-faint';
}

export function seriesStatusLabel(status: string): string {
	if (status === 'continuing') return 'Continuing';
	if (status === 'ended') return 'Ended';
	return 'Upcoming';
}

export function movieStatusLabel(hasFile: boolean, isAvailable: boolean): string {
	if (hasFile) return 'Available';
	if (!isAvailable) return 'Upcoming';
	return 'Missing';
}
