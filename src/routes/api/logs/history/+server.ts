import { jsonError, jsonOk } from '$lib/server/security/validation';
import { getHub } from '$lib/server/telemetry/hub';
import { DumbError } from '$lib/server/dumb/client';
import { splitLines, parseLogLine } from '$lib/server/logs/parse';
import type { RequestHandler } from './$types';

/**
 * Historical log backfill for one process via DUMB's cursor-based logs API
 * (DUMB applies its own redaction before we ever see the bytes).
 */
export const GET: RequestHandler = async ({ url }) => {
	const processName = url.searchParams.get('process_name');
	if (!processName) return jsonError('process_name is required');
	const hub = getHub();
	const client = hub.getClient();
	if (!client) return jsonError('DUMB is not configured', 409);

	const maxBytes = Math.min(
		1_048_576,
		Math.max(16_384, Number(url.searchParams.get('max_bytes') ?? 262_144))
	);
	try {
		const chunk = await client.logsChunk(processName, undefined);
		const text = (chunk.chunk ?? '').slice(-maxBytes);
		const processNames = new Set(hub.getDiscovered().map((d) => d.processName));
		const lines = splitLines(text).map((line) => parseLogLine(line, { processNames }));
		return jsonOk({
			processName,
			reset: chunk.reset ?? true,
			cursor: chunk.cursor ?? null,
			lines
		});
	} catch (err) {
		return jsonError(err instanceof DumbError ? err.message : 'Could not read logs from DUMB', 502);
	}
};
