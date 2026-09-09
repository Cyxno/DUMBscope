import { getHub } from '$lib/server/telemetry/hub';
import { getDb } from '$lib/server/database/db';
import { appInfo } from '$lib/shared/app-info';
import type { RequestHandler } from './$types';

/**
 * Server-Sent Events stream: the single realtime channel between the browser
 * and DUMBscope. On connect the client receives a full state replay, then live
 * events (connection, services, metrics, log, incident, activity).
 */
export const GET: RequestHandler = ({ locals }) => {
	if (!locals.user) return new Response('Authentication required', { status: 401 });

	const hub = getHub();
	const db = getDb();
	const encoder = new TextEncoder();

	let unsubscribe: (() => void) | null = null;
	let heartbeat: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			const write = (chunk: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					cleanup();
				}
			};
			const sendEvent = (event: string, data: unknown) => {
				write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
			};

			const cleanup = () => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				if (heartbeat) clearInterval(heartbeat);
				try {
					controller.close();
				} catch {
					// Already closed by the platform.
				}
			};

			// Initial replay so the UI renders instantly.
			sendEvent('hello', {
				version: appInfo().version,
				buildSha: appInfo().buildSha,
				configured: hub.isConfigured,
				capabilities: hub.getCapabilities().raw,
				dbOk: (() => {
					try {
						return db.prepare('SELECT 1 AS ok').get()?.ok === 1;
					} catch {
						return false;
					}
				})()
			});
			sendEvent('connection', hub.getConnection());
			sendEvent('services', {
				services: hub.getServices(),
				discovered: hub.getDiscovered(),
				overview: hub.overview()
			});
			const metrics = hub.getMetrics();
			if (metrics) sendEvent('metrics', metrics);
			sendEvent('metricsHistory', { points: hub.getMetricsHistory(600) });
			sendEvent('logs', { lines: hub.getLogs(undefined, 300) });
			sendEvent('incidents', { active: hub.getActiveIncidents() });
			sendEvent('topology', hub.topology());

			unsubscribe = hub.addSubscriber(
				({ event, data }) => sendEvent(event, data),
				() => cleanup()
			);
			heartbeat = setInterval(() => write(`: ping ${Date.now()}\n\n`), 20_000);
		},
		cancel() {
			unsubscribe?.();
			if (heartbeat) clearInterval(heartbeat);
		}
	});

	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		}
	});
};
