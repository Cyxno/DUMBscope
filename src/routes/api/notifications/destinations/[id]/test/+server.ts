/** Test-button endpoint: fires a test notification at one destination (§11). */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { jsonError } from '$lib/server/security/validation';
import { sendTestDelivery } from '$lib/server/notifications/engine';

export const POST: RequestHandler = async ({ params }) => {
	const result = await sendTestDelivery(params.id!);
	if (!result.ok && result.error === 'destination not found') {
		return jsonError('Destination not found', 404);
	}
	return json({ ok: result.ok, error: result.error });
};
