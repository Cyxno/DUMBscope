/**
 * Notification rules API: list / create / update / delete. Rules carry their
 * own filters (from a preset or custom), destinations, cooldown and quiet
 * hours. No secrets flow through here.
 */
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type { RequestHandler } from './$types';
import { jsonError, readJson } from '$lib/server/security/validation';
import { createRule, listRules, updateRule, deleteRule } from '$lib/server/notifications/store';
import {
	CATEGORIES,
	EVENTS,
	SEVERITIES,
	isValidHhMm,
	type NotificationRule
} from '$lib/shared/notifications';

const severitySchema = z.enum(SEVERITIES as unknown as [string, ...string[]]);
const categorySchema = z.enum(CATEGORIES as unknown as [string, ...string[]]);
const eventSchema = z.enum(EVENTS as unknown as [string, ...string[]]);

const ruleSchema = z
	.object({
		label: z.string().trim().min(1).max(64),
		enabled: z.boolean().default(true),
		preset: z.enum(['critical_only', 'warnings_critical', 'operations', 'everything', 'custom']),
		severities: z.array(severitySchema).max(4).default([]),
		categories: z.array(categorySchema).max(7).default([]),
		services: z.array(z.string().trim().min(1).max(128)).max(50).default([]),
		events: z.array(eventSchema).max(4).default([]),
		destinationIds: z.array(z.string().trim().min(1).max(64)).max(10).default([]),
		cooldownMinutes: z
			.number()
			.int()
			.min(0)
			.max(7 * 24 * 60)
			.default(60),
		quietEnabled: z.boolean().default(false),
		quietStart: z
			.string()
			.regex(/^([01]\d|2[0-3]):[0-5]\d$/)
			.nullable()
			.default(null),
		quietEnd: z
			.string()
			.regex(/^([01]\d|2[0-3]):[0-5]\d$/)
			.nullable()
			.default(null),
		quietTimezone: z.string().trim().max(64).nullable().default(null),
		quietBehavior: z.enum(['defer', 'suppress']).default('defer'),
		ratePerMinute: z.number().int().min(1).max(60).nullable().default(null)
	})
	.refine(
		(rule) => !rule.quietEnabled || (isValidHhMm(rule.quietStart) && isValidHhMm(rule.quietEnd)),
		{ message: 'Quiet hours require a start and end time (HH:MM)' }
	);

function toStored(rule: NotificationRule): Omit<NotificationRule, 'id'> {
	return { ...rule };
}

export const GET: RequestHandler = () => {
	return json({ rules: listRules() });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await readJson(request).catch(() => null);
	if (!body) return jsonError('Invalid JSON body');
	const parsed = ruleSchema.safeParse(body);
	if (!parsed.success)
		return jsonError(`Invalid rule payload: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
	const created = createRule(toStored(parsed.data as NotificationRule & { id?: string }));
	return json({ rule: created });
};

export const PUT: RequestHandler = async ({ request }) => {
	const body = await readJson(request).catch(() => null);
	if (!body) return jsonError('Invalid JSON body');
	const parsed = ruleSchema.safeParse(body);
	if (!parsed.success)
		return jsonError(`Invalid rule payload: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
	const id = (body as { id?: string }).id;
	if (!id) return jsonError('Rule id is required');
	const updated = updateRule(id, toStored(parsed.data as NotificationRule & { id?: string }));
	if (!updated) return jsonError('Rule not found', 404);
	return json({ rule: updated });
};

export const DELETE: RequestHandler = async ({ request }) => {
	const body = await readJson(request).catch(() => null);
	const id = (body as { id?: string } | null)?.id;
	if (!id) return jsonError('Rule id is required');
	if (!deleteRule(id)) return jsonError('Rule not found', 404);
	return json({ ok: true });
};
