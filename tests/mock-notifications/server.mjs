#!/usr/bin/env node
/**
 * Mock notification endpoints for Alerts & Notifications e2e tests (§19).
 *
 * - POST /discord/gw-hook        → Discord webhook (records the post)
 * - POST /telegram/bot<TOK>/sendMessage → Telegram sendMessage
 * - GET  /_received              → what was delivered so far
 * - POST /_mode {mode}           → 'ok' | 'fail500' | 'fail429' | 'timeout'
 * - POST /_reset                 → clear recordings
 *
 * Never talks to the real Discord or Telegram.
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_NOTIF_PORT || 4214);
const HOST = process.env.MOCK_NOTIF_HOST || '127.0.0.1';
const received = [];
let mode = 'ok';

const json = (res, body, code = 200) => {
	res.writeHead(code, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
	let raw = '';
	req.on('data', (chunk) => (raw += chunk));
	req.on('end', () => {
		const url = req.url ?? '';
		if (req.method === 'GET' && url === '/health') return json(res, { ok: true });

		if (req.method === 'GET' && url === '/_received') return json(res, { received });

		if (req.method === 'POST' && url === '/_mode') {
			mode = JSON.parse(raw || '{}').mode || 'ok';
			return json(res, { mode });
		}
		if (req.method === 'POST' && url === '/_reset') {
			received.length = 0;
			mode = 'ok';
			return json(res, { ok: true });
		}

		if (req.method === 'POST' && (url === '/discord/gw-hook' || url.startsWith('/discord/'))) {
			if (mode === 'fail500') return json(res, { error: 'mock unavailable' }, 500);
			if (mode === 'fail429') return json(res, { error: 'slow down' }, 429);
			if (mode === 'timeout') {
				setTimeout(() => json(res, { error: 'timed out' }, 500), 15000);
				return;
			}
			received.push({ at: Date.now(), channel: 'discord', url, body: raw });
			return json(res, { ok: true });
		}

		if (req.method === 'POST' && url.startsWith('/telegram/bot')) {
			if (mode === 'fail500') return json(res, { error: 'mock unavailable' }, 500);
			received.push({ at: Date.now(), channel: 'telegram', url, body: raw });
			return json(res, { ok: true, result: { message_id: received.length } });
		}

		json(res, { error: 'not found' }, 404);
	});
});

server.listen(PORT, HOST, () => {
	console.log(`[mock-notifications] listening on http://127.0.0.1:${PORT}`);
});
