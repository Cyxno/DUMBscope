/**
 * Adapter registration + lazy start. Called from the request pipeline so the
 * first authenticated request boots the integration pollers.
 */
import { registerAdapter, ensureIntegrationsStarted } from './manager';
import { createArrAdapter } from './arr/adapters';
import type { IntegrationAdapter, IntegrationConfig } from './manager';
import type { IntegrationType } from './types';
import { plexPollers, prowlarrPollers, seerrPollers, tautulliPollers } from './pollers';

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
				const response = await fetch(`${url.replace(/\/+$/, '')}/api/v1/system/status`, {
					headers: { 'X-Api-Key': apiKey ?? '' }
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
				const response = await fetch(`${url.replace(/\/+$/, '')}/identity`, {
					headers: { 'X-Plex-Token': apiKey ?? '', accept: 'application/json' }
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
				const response = await fetch(`${url.replace(/\/+$/, '')}/api/v1/settings/main`, {
					headers: { 'X-Api-Key': apiKey ?? '' }
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
				const response = await fetch(
					`${url.replace(/\/+$/, '')}/api/v2?apikey=${encodeURIComponent(apiKey ?? '')}&cmd=get_tautulli_info`
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
}

export function ensureIntegrationsUp(): void {
	ensureAdaptersRegistered();
	ensureIntegrationsStarted();
}
