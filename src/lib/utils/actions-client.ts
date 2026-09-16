/**
 * Client side of Safe Actions (docs/ACTIONS.md). Thin runner used by the
 * Library detail drawers and the service drawer: POST the allowlisted action,
 * then follow its state with a bounded poll — mirroring the server's bounded
 * follow-up. "Search requested" is reported as requested, never as "found".
 */

export type ActionRunState =
	'executing' | 'accepted' | 'completed' | 'unconfirmed' | 'failed' | 'rejected';

export interface ActionRunUpdate {
	state: ActionRunState;
	message: string | null;
}

export interface ActionResult {
	ok: boolean;
	state: ActionRunState;
	message: string | null;
}

const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 8;

/** Execute one allowlisted action and follow it to a terminal state. */
export async function runAction(
	actionId: string,
	integrationId: string,
	target: Record<string, unknown>,
	onUpdate?: (update: ActionRunUpdate) => void
): Promise<ActionResult> {
	onUpdate?.({ state: 'executing', message: null });
	let id: string | null = null;
	try {
		const res = await fetch('/api/actions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ actionId, integrationId, target })
		});
		const data = (await res.json()) as {
			error?: string;
			id?: string;
			state?: string;
			message?: string | null;
		};
		if (!res.ok) {
			const message = data.error ?? 'Action rejected';
			onUpdate?.({ state: 'rejected', message });
			return { ok: false, state: 'rejected', message };
		}
		id = data.id ?? null;
		onUpdate?.({
			state: 'accepted',
			message: data.message ?? 'Action accepted'
		});
	} catch {
		const message = 'Could not reach DUMBscope';
		onUpdate?.({ state: 'failed', message });
		return { ok: false, state: 'failed', message };
	}
	if (!id) return { ok: true, state: 'accepted', message: 'Action accepted' };

	// Bounded follow (§13): a handful of polls, then settle honestly.
	for (let poll = 0; poll < MAX_POLLS; poll++) {
		await sleep(POLL_INTERVAL_MS);
		try {
			const res = await fetch(`/api/actions/${encodeURIComponent(id)}`);
			if (!res.ok) continue;
			const action = (await res.json()) as { state?: string; message?: string | null };
			if (action.state === 'completed') {
				onUpdate?.({ state: 'completed', message: action.message ?? null });
				return { ok: true, state: 'completed', message: action.message ?? null };
			}
			if (action.state === 'failed') {
				onUpdate?.({ state: 'failed', message: action.message ?? null });
				return { ok: false, state: 'failed', message: action.message ?? null };
			}
			if (action.state === 'unconfirmed') {
				onUpdate?.({ state: 'unconfirmed', message: action.message ?? null });
				return { ok: true, state: 'unconfirmed', message: action.message ?? null };
			}
		} catch {
			/* transient — keep polling within the bound */
		}
	}
	return { ok: true, state: 'accepted', message: 'Requested — result not observed yet' };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Integration config subset the UI needs for actions + links (no secrets). */
export interface IntegrationRef {
	id: string;
	type: string;
	url: string;
	publicUrl: string | null;
	enabled: boolean;
	actions: {
		canSearchEpisode: boolean;
		canSearchSeason: boolean;
		canRefreshSeries: boolean;
		canSearchMovie: boolean;
		canRefreshMovie: boolean;
	};
}

let integrationsCache: IntegrationRef[] | null = null;

/** Cached integration list for link/action wiring in detail views. */
export async function loadIntegrations(force = false): Promise<IntegrationRef[]> {
	if (integrationsCache && !force) return integrationsCache;
	const res = await fetch('/api/integrations');
	if (!res.ok) return integrationsCache ?? [];
	const data = (await res.json()) as {
		integrations: {
			config: {
				id: string;
				type: string;
				url: string;
				publicUrl: string | null;
				enabled: boolean;
			};
			actions: IntegrationRef['actions'];
		}[];
	};
	integrationsCache = data.integrations.map((i) => ({
		id: i.config.id,
		type: i.config.type,
		url: i.config.url,
		publicUrl: i.config.publicUrl ?? null,
		enabled: i.config.enabled,
		actions: i.actions
	}));
	return integrationsCache;
}

/** Server settings subset for link building (§2). */
export interface LinkSettings {
	linkOpenPreference: 'auto' | 'internal' | 'public';
}

let settingsCache: LinkSettings | null = null;

export async function loadLinkSettings(force = false): Promise<LinkSettings> {
	if (settingsCache && !force) return settingsCache;
	try {
		const res = await fetch('/api/settings');
		if (res.ok) settingsCache = (await res.json()) as LinkSettings;
	} catch {
		/* fall through to default */
	}
	return settingsCache ?? { linkOpenPreference: 'auto' };
}

export function invalidateActionCaches(): void {
	integrationsCache = null;
	settingsCache = null;
}
