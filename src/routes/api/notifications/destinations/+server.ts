/**
 * Notification destinations API. Secrets are accepted once, encrypted at rest
 * and never returned — GET returns masked representations only (§13).
 */
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { jsonError, readJson } from '$lib/server/security/validation';
import {
	createDestination,
	createRule,
	lastDelivery,
	lastError,
	listDestinations,
	ruleCount,
	toPublicDestination
} from '$lib/server/notifications/store';
import { PRESETS } from '$lib/shared/notifications';

const configSchema = z
	.object({
		webhookUrl: z.string().trim().url().max(512).optional(),
		botToken: z.string().trim().min(1).max(256).optional(),
		apiBase: z.string().trim().url().max(256).optional(),
		chatId: z.string().trim().min(1).max(64).optional()
	})
	.strip();

const createSchema = z.object({
	kind: z.enum(['browser', 'discord', 'telegram']),
	label: z.string().trim().min(1).max(64),
	enabled: z.boolean().optional().default(true),
	config: configSchema.optional().nullable()
});

function statusFor(id: string): {
	lastDelivery: { at: number; result: string } | null;
	lastError: { at: number; error: string } | null;
} {
	return { lastDelivery: lastDelivery(id), lastError: lastError(id) };
}

export const GET: RequestHandler = () => {
	const destinations = listDestinations().map((destination) => ({
		...toPublicDestination(destination),
		...statusFor(destination.id)
	}));
	return json({ destinations });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request).catch(() => null);
	if (!body) return jsonError('Invalid JSON body');
	const parsed = createSchema.safeParse(body);
	if (!parsed.success) return jsonError('Invalid destination payload');

	const { kind, label, enabled, config } = parsed.data;
	// Only persist the secret fields each kind actually uses.
	let stored: Record<string, string> | null = null;
	if (kind === 'discord') {
		if (!config?.webhookUrl) return jsonError('Discord destinations require a webhook URL');
		stored = { webhookUrl: config.webhookUrl };
	} else if (kind === 'telegram') {
		if (!config?.botToken || !config?.chatId) {
			return jsonError('Telegram destinations require a bot token and chat id');
		}
		stored = config.apiBase
			? { botToken: config.botToken, chatId: config.chatId, apiBase: config.apiBase }
			: { botToken: config.botToken, chatId: config.chatId };
	}

	const destination = createDestination({ kind, label, enabled, config: stored });

	// First destination: seed a sensible default rule so the user gets value
	// without reading docs (skipped when any rule already exists).
	if (ruleCount() === 0) {
		const preset = PRESETS.warnings_critical;
		createRule({
			label: 'Warnings + Critical',
			enabled: true,
			preset: 'warnings_critical',
			severities: [...preset.severities],
			categories: [],
			services: [],
			events: [...preset.events],
			destinationIds: [destination.id],
			cooldownMinutes: preset.cooldownMinutes,
			quietEnabled: false,
			quietStart: null,
			quietEnd: null,
			quietTimezone: null,
			quietBehavior: 'defer',
			ratePerMinute: null
		});
	}

	return json({
		destination: { ...toPublicDestination(destination), ...statusFor(destination.id) }
	});
};
