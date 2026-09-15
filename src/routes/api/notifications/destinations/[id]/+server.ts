/**
 * Single notification destination: update (label/enabled/config) or delete.
 * Secrets are write-only — omitted config fields keep their stored values.
 */
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { jsonError, readJson } from '$lib/server/security/validation';
import {
	deleteDestination,
	getDestination,
	lastDelivery,
	lastError,
	toPublicDestination,
	updateDestination
} from '$lib/server/notifications/store';

const patchSchema = z.object({
	label: z.string().trim().min(1).max(64).optional(),
	enabled: z.boolean().optional(),
	config: z
		.object({
			webhookUrl: z.string().trim().url().max(512).optional(),
			botToken: z.string().trim().min(1).max(256).optional(),
			apiBase: z.string().trim().url().max(256).optional(),
			chatId: z.string().trim().min(1).max(64).optional()
		})
		.strip()
		.optional()
});

export const PATCH: RequestHandler = async ({ request, params }) => {
	const body = await readJson(request).catch(() => null);
	if (!body) return jsonError('Invalid JSON body');
	const parsed = patchSchema.safeParse(body);
	if (!parsed.success) return jsonError('Invalid destination payload');

	const existing = getDestination(params.id!);
	if (!existing) return jsonError('Destination not found', 404);

	const config = parsed.data.config
		? { ...(existing.config ?? {}), ...cleanSecrets(existing.kind, parsed.data.config) }
		: undefined;
	const updated = updateDestination(params.id!, {
		label: parsed.data.label,
		enabled: parsed.data.enabled,
		config
	});
	if (!updated) return jsonError('Destination not found', 404);
	return json({
		destination: {
			...toPublicDestination(updated),
			lastDelivery: lastDelivery(updated.id),
			lastError: lastError(updated.id)
		}
	});
};

function cleanSecrets(
	kind: string,
	config: { webhookUrl?: string; botToken?: string; chatId?: string; apiBase?: string }
): Record<string, string> {
	if (kind === 'discord') {
		return config.webhookUrl ? { webhookUrl: config.webhookUrl } : {};
	}
	const out: Record<string, string> = {};
	if (config.botToken) out.botToken = config.botToken;
	if (config.chatId) out.chatId = config.chatId;
	if (config.apiBase) out.apiBase = config.apiBase;
	return out;
}

export const DELETE: RequestHandler = async ({ params }) => {
	if (!getDestination(params.id!)) return jsonError('Destination not found', 404);
	deleteDestination(params.id!);
	return json({ ok: true });
};
