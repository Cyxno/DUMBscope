/**
 * Adapter registration + lazy start. Called from the request pipeline so the
 * first authenticated request boots the integration pollers.
 */
import { registerAdapter, ensureIntegrationsStarted } from './manager';
import { createArrAdapter } from './arr/adapters';
import type { IntegrationAdapter, IntegrationConfig } from './manager';
import type { IntegrationType } from './types';
import { plexPollers, prowlarrPollers, seerrPollers, tautulliPollers } from './pollers';
import { startRetentionJob } from './retention';

/** Every outbound probe gets a hard timeout; no request may hang forever. */
async function withTimeout(
	url: string,
	headers: Record<string, string>,
	ms = 8_000
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	try {
		return await fetch(url, { headers, signal: controller.signal });
	} catch (err) {
		if (err instanceof Error && err.name === 'AbortError') {
			throw new Error('timeout: integration did not respond in time');
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

function keyAdapter(
	type: IntegrationType,
	test: (ctx: { url: string; apiKey: string | null }) => Promise<{ version?: string }>,
	pollers: () => ReturnType<typeof plexPollers>
): IntegrationAdapter {
	return {
		type,
		test: async (config: IntegrationConfig, apiKey: string | null) =>
			test({ url: config.url, apiKey }),
		pollers
	};
}

let registered = false;

export function ensureAdaptersRegistered(): void {
	if (registered) return;
	registered = true;

	registerAdapter(createArrAdapter('sonarr'));
	registerAdapter(createArrAdapter('radarr'));

	registerAdapter(
		keyAdapter(
			'prowlarr',
			async ({ url, apiKey }) => {
				const response = await withTimeout(`${url.replace(/\/+$/, '')}/api/v1/system/status`, {
					'X-Api-Key': apiKey ?? ''
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const data = (await response.json()) as { version?: string };
				return { version: data.version };
			},
			prowlarrPollers
		)
	);

	registerAdapter(
		keyAdapter(
			'plex',
			async ({ url, apiKey }) => {
				const response = await withTimeout(`${url.replace(/\/+$/, '')}/identity`, {
					'X-Plex-Token': apiKey ?? '',
					accept: 'application/json'
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const data = (await response.json()) as { MediaContainer?: { version?: string } };
				return { version: data.MediaContainer?.version };
			},
			plexPollers
		)
	);

	registerAdapter(
		keyAdapter(
			'seerr',
			async ({ url, apiKey }) => {
				const response = await withTimeout(`${url.replace(/\/+$/, '')}/api/v1/settings/main`, {
					'X-Api-Key': apiKey ?? ''
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const data = (await response.json()) as { appVersion?: string };
				return { version: data.appVersion };
			},
			seerrPollers
		)
	);

	registerAdapter(
		keyAdapter(
			'tautulli',
			async ({ url, apiKey }) => {
				const response = await withTimeout(
					`${url.replace(/\/+$/, '')}/api/v2?apikey=${encodeURIComponent(apiKey ?? '')}&cmd=get_tautulli_info`,
					{}
				);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const data = (await response.json()) as {
					response?: { data?: { version?: string } };
				};
				return { version: data.response?.data?.version };
			},
			tautulliPollers
		)
	);

	ensureIntegrationsStarted();
	startRetentionJob();
}

export function ensureIntegrationsUp(): void {
	ensureAdaptersRegistered();
	ensureIntegrationsStarted();
}
