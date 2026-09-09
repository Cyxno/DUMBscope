import { jsonOk } from '$lib/server/security/validation';
import { hasAdminUser } from '$lib/server/security/sessions';
import { getSettings } from '$lib/server/config/settings';
import { setupNeeded } from '$lib/server/setup';
import { getDb } from '$lib/server/database/db';
import type { RequestHandler } from './$types';

/** Public, minimal first-run state for the wizard. No secrets, no URLs. */
export const GET: RequestHandler = async () => {
	getDb();
	return jsonOk({
		needsSetup: !hasAdminUser(),
		setupCodeRequired: setupNeeded(),
		configured: getSettings().setupCompleted && Boolean(getSettings().dumbUrl)
	});
};
