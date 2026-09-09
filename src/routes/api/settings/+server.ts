import {
	jsonError,
	jsonOk,
	readJson,
	dumbUrlSchema,
	validateDumbUrl
} from '$lib/server/security/validation';
import {
	getSettings,
	getSettingsForClient,
	setUiPreference,
	setStreamInterval,
	setDumbUrl,
	setDumbCredentials
} from '$lib/server/config/settings';
import { getHub } from '$lib/server/telemetry/hub';
import { DumbClient, DumbAuthError, DumbError } from '$lib/server/dumb/client';
import { z } from 'zod';
import type { RequestHandler } from './$types';

const patchSchema = z.object({
	theme: z.enum(['dark', 'oled', 'light']).optional(),
	accent: z.enum(['cyan', 'blue', 'indigo', 'violet']).optional(),
	reducedMotion: z.boolean().optional(),
	statusInterval: z.number().min(0.5).max(10).optional(),
	metricsInterval: z.number().min(0.5).max(10).optional(),
	dumbUrl: dumbUrlSchema.optional(),
	dumbUsername: z.string().trim().min(1).max(128).optional(),
	dumbPassword: z.string().min(1).max(256).optional()
});

/** Settings view: never includes secrets, only presence flags. */
export const GET: RequestHandler = async () => {
	return jsonOk(getSettingsForClient());
};

export const PATCH: RequestHandler = async ({ request }) => {
	const body = await readJson(request);
	const parsed = patchSchema.safeParse(body);
	if (!parsed.success) {
		return jsonError(parsed.error.issues[0]?.message ?? 'Invalid settings payload');
	}
	const patch = parsed.data;

	// Display + stream preferences: apply directly.
	if (patch.theme) setUiPreference('theme', patch.theme);
	if (patch.accent) setUiPreference('accent', patch.accent);
	if (patch.reducedMotion !== undefined)
		setUiPreference('reducedMotion', String(patch.reducedMotion));
	if (patch.statusInterval) setStreamInterval('statusInterval', patch.statusInterval);
	if (patch.metricsInterval) setStreamInterval('metricsInterval', patch.metricsInterval);

	// Connection changes: validate, then test credentials when provided.
	const url = patch.dumbUrl ?? getSettings().dumbUrl;
	if (patch.dumbUrl !== undefined || patch.dumbUsername || patch.dumbPassword) {
		if (!url) return jsonError('A DUMB URL is required');
		let base: string;
		try {
			base = validateDumbUrl(url).base;
		} catch (err) {
			return jsonError(err instanceof Error ? err.message : 'Invalid DUMB URL');
		}
		if (patch.dumbUsername && !patch.dumbPassword) {
			return jsonError('Provide both username and password');
		}
		if (patch.dumbPassword && !patch.dumbUsername) {
			return jsonError('Provide both username and password');
		}

		if (patch.dumbUsername && patch.dumbPassword) {
			const client = new DumbClient({ baseUrl: base, getCredentials: () => null, timeoutMs: 8000 });
			try {
				const authStatus = await client.authStatus().catch(() => null);
				if (authStatus?.enabled) {
					await client.loginWith(patch.dumbUsername, patch.dumbPassword);
				}
			} catch (err) {
				if (err instanceof DumbAuthError) {
					return jsonError('DUMB rejected these credentials', 400);
				}
				if (err instanceof DumbError) {
					return jsonError(`${err.message}. Settings were not changed.`, 502);
				}
			}
			setDumbCredentials({ username: patch.dumbUsername, password: patch.dumbPassword });
		}
		if (patch.dumbUrl !== undefined) {
			setDumbUrl(base);
		}
		getHub().reload();
	}

	return jsonOk(getSettingsForClient());
};
