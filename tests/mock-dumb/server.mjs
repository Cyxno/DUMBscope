#!/usr/bin/env node
/**
 * Mock DUMB gateway for tests and local development.
 *
 * Implements the documented API surface DUMBscope consumes:
 *   GET  /api/health                (public)
 *   GET  /api/auth/status           (public)
 *   POST /api/auth/login            -> JWT-shaped tokens
 *   POST /api/auth/refresh
 *   GET  /api/process/processes     (bearer)
 *   GET  /api/process/capabilities  (bearer)
 *   GET  /api/logs?process_name=    (bearer)
 *   WS   /ws/status?health=true&token=…
 *   WS   /ws/metrics?bootstrap=true&token=…
 *   WS   /ws/logs?token=…
 *
 * Scenarios (env MOCK_SCENARIO): healthy | degraded | crash-loop | dependency-failure | log-burst | disk-full
 * without a Docker daemon.
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT || 3105);
const SCENARIO = process.env.MOCK_SCENARIO || 'healthy';
const AUTH_ENABLED = process.env.MOCK_AUTH !== 'off';
const USERNAME = 'admin';
const PASSWORD = 'mockpassword';
const SECRET = 'mock-jwt-secret-not-a-real-credential';

const now = () => Date.now();

function sign(payload) {
	const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
	return `${body}.${mac}`;
}

function verify(token) {
	if (!token || !token.includes('.')) return null;
	const [body, mac] = token.split('.');
	const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
	if (mac !== expected) return null;
	try {
		return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Simulated stack
// ---------------------------------------------------------------------------

const SERVICES = [
	{ name: 'DUMB Frontend', key: 'dumb-frontend', version: '1.8.2', port: 3005 },
	{ name: 'DUMB API', key: 'dumb-api', version: '1.8.2', port: 8000 },
	{ name: 'PostgreSQL 16', key: 'postgres', version: '16.3', port: 5432 },
	{ name: 'InfiniDysk', key: 'infinidysk', version: '2.4.1', port: 8282 },
	{ name: 'rclone w/ InfiniDysk', key: 'rclone', version: '1.67.0', port: 8081 },
	{ name: 'Decypharr', key: 'decypharr', version: '1.2.6', port: 8181 },
	{ name: 'Sonarr', key: 'sonarr', version: '4.0.9.2244', port: 8989 },
	{ name: 'Radarr', key: 'radarr', version: '5.14.0.9383', port: 7878 },
	{ name: 'Prowlarr', key: 'prowlarr', version: '1.29.0.4899', port: 9696 },
	{ name: 'Plex Media Server', key: 'plex', version: '1.41.0.8994', port: 32400 },
	{ name: 'Seerr', key: 'seerr', version: '2.5.2', port: 5055 }
];

// MOCK_SERVICES=N pads the stack with generated services so topology and
// dashboard layouts can be exercised at scale (e.g. 15, 30+ services).
const EXTRA = Number(process.env.MOCK_SERVICES || 0) - SERVICES.length;
for (let i = 0; EXTRA > 0 && i < EXTRA; i += 1) {
	SERVICES.push({
		name: `Mock Service ${String(i + 1).padStart(2, '0')}`,
		key: `mock-service-${i + 1}`,
		version: `1.0.${i}`,
		port: 9000 + i
	});
}

let tick = 0;
let postgresDown = false;
let sonarrCrashing = false;

const FORCE_POSTGRES_DOWN = process.env.MOCK_POSTGRES_DOWN === '1';

function scenarioTick() {
	tick += 1;
	if (FORCE_POSTGRES_DOWN) postgresDown = true;
	if (SCENARIO === 'dependency-failure' && tick === 8) postgresDown = true;
	if (SCENARIO === 'dependency-failure' && tick === 40) postgresDown = false;
	if (SCENARIO === 'crash-loop') sonarrCrashing = true;
}

function serviceStatus(service) {
	const base = {
		process_name: service.name,
		status: 'running',
		healthy: true,
		health_status: 'healthy',
		health_reason: null,
		health_details: { probe: 'process_and_ports', ports: [service.port] },
		restart: {
			restart_attempts: 0,
			restart_successes: 0,
			restart_failures: 0,
			recent_restart_attempts: 0,
			pending: false,
			next_restart_time: null,
			disabled: false,
			last_restart_time: null,
			last_failure_reason: null,
			last_exit_time: null,
			last_exit_reason: null,
			unhealthy_count: 0,
			unhealthy_threshold: 3
		}
	};

	if (service.key === 'postgres' && postgresDown) {
		return {
			...base,
			status: 'running',
			healthy: false,
			health_status: 'unhealthy',
			health_reason: 'PostgreSQL is not accepting connections',
			health_details: { probe: 'tcp', port: 5432, error: 'connection refused' }
		};
	}
	if (service.key === 'postgres' && !postgresDown && SCENARIO === 'dependency-failure') {
		return { ...base, health_status: 'healthy' };
	}

	if (service.key === 'sonarr' && (sonarrCrashing || SCENARIO === 'crash-loop')) {
		const failing = tick % 4 !== 0;
		return {
			...base,
			health_status: failing ? 'unhealthy' : 'starting',
			healthy: !failing,
			health_reason: failing ? 'Sonarr API is not responding' : 'Sonarr is starting up',
			restart: {
				...base.restart,
				restart_attempts: Math.floor(tick / 4),
				restart_successes: Math.floor(tick / 8),
				restart_failures: Math.floor(tick / 6),
				last_failure_reason: 'process exited with code 1',
				last_restart_time: Math.floor(Date.now() / 1000) - 30
			}
		};
	}

	if (SCENARIO === 'degraded' && service.key === 'infinidysk') {
		return {
			...base,
			health_status: 'degraded',
			healthy: true,
			health_reason: 'InfiniDysk reports elevated API latency',
			health_details: { probe: 'http', endpoint: '/health', http_status: 200, latency_ms: 4200 }
		};
	}

	return base;
}

function metricsSnapshot() {
	const seed = (offset) => 18 + Math.sin((tick + offset) / 6) * 9;
	const diskPercent = SCENARIO === 'disk-full' ? Math.min(97.5, 88 + tick * 0.5) : 61.4;
	return {
		timestamp: now() / 1000,
		system: {
			scope: 'cgroup',
			cpu_percent: Math.max(1, seed(0) + (SCENARIO === 'log-burst' ? 22 : 0)),
			cpu_count: 12,
			load_avg: [0.42, 0.38, 0.35],
			mem: {
				total: 34359738368,
				used: 34359738368 * (0.42 + Math.sin(tick / 9) * 0.04),
				percent: 42 + Math.sin(tick / 9) * 4
			},
			disk: {
				path: '/data',
				total: 2199023255552,
				used: 2199023255552 * (diskPercent / 100),
				free: 2199023255552 * (1 - diskPercent / 100),
				percent: diskPercent
			},
			inode: { path: '/data', percent: 4.1 },
			filesystems: [
				{
					path: '/data',
					total: 2199023255552,
					used: 2199023255552 * (diskPercent / 100),
					free: 2199023255552 * (1 - diskPercent / 100),
					percent: diskPercent,
					inode_percent: 4.1
				},
				{
					path: '/config',
					total: 107374182400,
					used: 107374182400 * 0.23,
					free: 107374182400 * 0.77,
					percent: 23.0,
					inode_percent: 1.8
				}
			],
			net_io: { sent_bytes: 1099511627776 + tick * 1e6, recv_bytes: 2199023255552 + tick * 4e6 },
			network_interfaces: [
				{
					name: 'eth0',
					sent_bytes: 1099511627776 + tick * 1e6,
					recv_bytes: 2199023255552 + tick * 4e6
				}
			]
		},
		dumb_managed: SERVICES.map((s, i) => ({
			pid: 100 + i,
			name: s.name,
			cpu_percent: Math.max(0.1, seed(i)),
			rss: 134217728 + i * 52428800
		})),
		external: [],
		database_health: {
			'PostgreSQL 16': postgresDown
				? { healthy: false, reason: 'connection refused', timestamp: now() / 1000 }
				: { healthy: true, reason: null, timestamp: now() / 1000 }
		}
	};
}

let logCounter = 0;
function nextLogLine() {
	logCounter += 1;
	const service = SERVICES[(logCounter * 3) % SERVICES.length];
	const stamp = new Date().toLocaleString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	});
	if (SCENARIO === 'log-burst' && logCounter % 3 === 0) {
		return `${stamp} - ERROR - ${service.name} - upstream request failed after 3 attempts (attempt ${logCounter})`;
	}
	if (service.key === 'postgres' && postgresDown) {
		return `${stamp} - ERROR - ${service.name} - FATAL: the database system is shutting down`;
	}
	const messages = [
		'health check passed',
		'library scan completed in 1.4s',
		'import queue empty',
		'connection pool ready (8 clients)'
	];
	return `${stamp} - INFO - ${service.name} - ${messages[logCounter % messages.length]}`;
}

function processesPayload() {
	return {
		processes: SERVICES.map((s) => ({
			name: s.name,
			process_name: s.name,
			enabled: true,
			config: { enabled: true },
			version: s.version,
			key: s.key,
			config_key: s.key,
			repo_url: 'https://example.invalid/' + s.key,
			supports_manual_update: false,
			update_status: null
		}))
	};
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
	const url = new URL(req.url, 'http://localhost');
	const respond = (code, payload) => {
		res.writeHead(code, { 'content-type': 'application/json' });
		res.end(JSON.stringify(payload));
	};
	const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
	const claims = verify(bearer);
	const tokenParam = url.searchParams.get('token');
	const wsAuth = verify(tokenParam ?? '');

	scenarioTick();

	if (url.pathname === '/api/health') {
		return respond(200, { status: 'healthy' });
	}
	if (url.pathname === '/api/auth/status') {
		return respond(200, {
			enabled: AUTH_ENABLED,
			has_users: AUTH_ENABLED,
			setup_skipped: false,
			mode: 'local',
			local_login_enabled: AUTH_ENABLED,
			oidc_login_enabled: false,
			oidc_provider_name: ''
		});
	}
	if (url.pathname === '/api/auth/login' && req.method === 'POST') {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			try {
				const { username, password } = JSON.parse(body);
				if (username === USERNAME && password === PASSWORD) {
					return respond(200, {
						access_token: sign({ sub: username, exp: Math.floor(now() / 1000) + 900 }),
						refresh_token: sign({
							sub: username,
							refresh: true,
							exp: Math.floor(now() / 1000) + 86400
						}),
						token_type: 'bearer'
					});
				}
				respond(401, { detail: 'Invalid credentials' });
			} catch {
				respond(400, { detail: 'Bad request' });
			}
		});
		return;
	}
	if (url.pathname === '/api/auth/refresh' && req.method === 'POST') {
		let body = '';
		req.on('data', (chunk) => (body += chunk));
		req.on('end', () => {
			try {
				const { refresh_token } = JSON.parse(body);
				const claims2 = verify(refresh_token);
				if (claims2?.refresh) {
					return respond(200, {
						access_token: sign({ sub: claims2.sub, exp: Math.floor(now() / 1000) + 900 }),
						refresh_token: refresh_token,
						token_type: 'bearer'
					});
				}
				respond(401, { detail: 'Invalid refresh token' });
			} catch {
				respond(400, { detail: 'Bad request' });
			}
		});
		return;
	}

	if (!AUTH_ENABLED || claims || wsAuth) {
		switch (url.pathname) {
			case '/api/process/processes':
				return respond(200, processesPayload());
			case '/api/process/capabilities':
				return respond(200, {
					manual_update_check: true,
					startup_lifecycle: true,
					database_health_metrics: true,
					metrics_filesystem_selection: true,
					notifications: true,
					postgres_migration_service_keys: ['sonarr', 'radarr', 'infinidysk', 'prowlarr']
				});
			case '/api/process/service-status': {
				const name = url.searchParams.get('process_name');
				const service = SERVICES.find((s) => s.name === name);
				return service
					? respond(200, serviceStatus(service))
					: respond(404, { detail: 'Not Found' });
			}
			case '/api/metrics':
				return respond(200, metricsSnapshot());
			case '/api/logs': {
				const chunk = Array.from({ length: 12 }, nextLogLine).join('\n') + '\n';
				return respond(200, {
					process_name: url.searchParams.get('process_name') ?? '',
					size: chunk.length,
					cursor: chunk.length,
					chunk,
					reset: true,
					log: chunk
				});
			}
			default:
				respond(404, { detail: 'Not Found' });
		}
	} else {
		respond(401, { detail: 'Authentication required' });
	}
});

// ---------------------------------------------------------------------------
// WebSocket upgrade (hand-rolled, server-side; enough for the mock)
// ---------------------------------------------------------------------------

const connections = new Set();

server.on('upgrade', (req, socket) => {
	const url = new URL(req.url, 'http://localhost');
	const token = url.searchParams.get('token');
	const claims = verify(token ?? '');
	if (AUTH_ENABLED && !claims) {
		socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
		socket.destroy();
		return;
	}
	const key = req.headers['sec-websocket-key'];
	if (!key) {
		socket.destroy();
		return;
	}
	const accept = crypto
		.createHash('sha1')
		.update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
		.digest('base64');
	socket.write(
		'HTTP/1.1 101 Switching Protocols\r\n' +
			'Upgrade: websocket\r\n' +
			'Connection: Upgrade\r\n' +
			`Sec-WebSocket-Accept: ${accept}\r\n\r\n`
	);

	const client = { socket, path: url.pathname, alive: true };
	connections.add(client);
	socket.on('data', (buffer) => {
		// Handle client close + ping frames minimally.
		const opcode = buffer[0] & 0x0f;
		if (opcode === 0x8) {
			connections.delete(client);
			socket.end();
		}
	});
	socket.on('close', () => connections.delete(client));
	socket.on('error', () => connections.delete(client));
});

function encodeFrame(text) {
	const payload = Buffer.from(text, 'utf8');
	const length = payload.length;
	let header;
	if (length < 126) {
		header = Buffer.from([0x81, length]);
	} else if (length < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x81;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x81;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([header, payload]);
}

function broadcast(pathFilter, text) {
	for (const client of connections) {
		if (pathFilter(client.path) && client.socket.writable) {
			try {
				client.socket.write(encodeFrame(text));
			} catch {
				connections.delete(client);
			}
		}
	}
}

const INTERVAL = Number(process.env.MOCK_INTERVAL || 1000);
setInterval(() => {
	scenarioTick();
	broadcast(
		(p) => p === '/ws/status',
		JSON.stringify({ type: 'status', processes: SERVICES.map(serviceStatus) })
	);
	broadcast(
		(p) => p === '/ws/metrics',
		JSON.stringify({ type: 'snapshot', data: metricsSnapshot() })
	);
	const lines =
		SCENARIO === 'log-burst' ? Array.from({ length: 6 }, nextLogLine).join('\n') : nextLogLine();
	broadcast((p) => p === '/ws/logs', lines + '\n');
}, INTERVAL);

server.listen(PORT, () => {
	console.log(
		`[mock-dumb] listening on http://127.0.0.1:${PORT} (scenario=${SCENARIO}, auth=${AUTH_ENABLED ? 'on' : 'off'})`
	);
});
