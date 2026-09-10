/**
 * Adapter registration + lazy start. Called from the request pipeline so the
 * first authenticated request boots the integration pollers.
 */
import { ensureIntegrationsStarted, registerAdapter } from './manager';
import { createArrAdapter } from './arr/adapters';

let registered = false;

export function ensureIntegrationsUp(): void {
	if (!registered) {
		registerAdapter(createArrAdapter('sonarr'));
		registerAdapter(createArrAdapter('radarr'));
		registered = true;
	}
	ensureIntegrationsStarted();
}
