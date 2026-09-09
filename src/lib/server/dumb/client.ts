/**
 * HTTP + WebSocket client for the DUMB gateway (port 3005).
 *
 * DUMBscope never exposes DUMB credentials to the browser: this module is the
 * only place that talks to DUMB, holds tokens and applies retry/refresh logic.
 */
import type {
	DumbAuthStatus,
	DumbLogsChunk,
	DumbMetricsSnapshot,
	DumbProcessesResponse,
	DumbTokenResponse
} from './types';

export class DumbError extends Error {
	constructor(
		message: string,
		public readonly status: number | null = null,
		public readonly cause?: unknown
	) {
		super(message);
		this.name = 'DumbError';
	}
}

export class DumbAuthError extends DumbError {
	constructor(message = 'DUMB authentication failed', cause?: unknown) {
		super(message, 401, cause);
		this.name = 'DumbAuthError';
	}
}

export interface DumbClientOptions {
	baseUrl: string;
	wsBaseUrl?: string;
	getCredentials: () => { username: string; password: string } | null;
	/** Called whenever a fresh token pair has been obtained (persist hook). */
	onTokens?: (tokens: { accessToken: string; refreshToken: string | null }) => void;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

interface Tokens {
	accessToken: string;
	refreshToken: string | null;
	/** Epoch ms when the access token was obtained. */
	acquiredAt: number;
}

/** Conservative default: DUMB access tokens are short-lived JWTs. */
const TOKEN_REFRESH_MARGIN_MS = 30_000;

export class DumbClient {
	private tokens: Tokens | null = null;
	private refreshPromise: Promise<boolean> | null = null;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;

	constructor(private readonly options: DumbClientOptions) {
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.timeoutMs = options.timeoutMs ?? 10_000;
	}

	setTokens(tokens: { accessToken: string; refreshToken: string | null } | null): void {
		this.tokens = tokens ? { ...tokens, acquiredAt: Date.now() } : null;
	}

	get hasTokens(): boolean {
		return this.tokens !== null;
	}

	get baseUrl(): string {
		return this.options.baseUrl;
	}

	get wsBaseUrl(): string {
		return this.options.wsBaseUrl ?? this.options.baseUrl.replace(/^http/, 'ws');
	}

	/** URL for a WebSocket stream, embedding the token as DUMB requires. */
	wsUrl(path: string, params: Record<string, string> = {}): string {
		const url = new URL(this.wsBaseUrl + path);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
		const token = this.tokens?.accessToken;
		if (token) url.searchParams.set('token', token);
		return url.toString();
	}

	private async request(
		path: string,
		init: RequestInit & { auth?: boolean; retry?: boolean } = {}
	): Promise<Response> {
		const { auth = true, retry = true, ...rest } = init;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const headers = new Headers(rest.headers);
			if (auth && this.tokens?.accessToken) {
				headers.set('authorization', `Bearer ${this.tokens.accessToken}`);
			}
			const response = await this.fetchImpl(this.baseUrl + path, {
				...rest,
				headers,
				signal: controller.signal
			});
			if (response.status === 401 && auth && retry) {
				const refreshed = await this.refreshTokens();
				if (refreshed) {
					return this.request(path, { ...init, retry: false });
				}
				throw new DumbAuthError('DUMB rejected the stored credentials');
			}
			return response;
		} catch (err) {
			if (err instanceof DumbError) throw err;
			if (err instanceof Error && err.name === 'AbortError') {
				throw new DumbError('DUMB request timed out', null, err);
			}
			throw new DumbError('Could not reach DUMB', null, err);
		} finally {
			clearTimeout(timer);
		}
	}

	// -------------------------------------------------------------------------
	// Auth
	// -------------------------------------------------------------------------

	/** Login with the configured credentials and cache the token pair. */
	async login(): Promise<void> {
		const credentials = this.options.getCredentials();
		if (!credentials) throw new DumbAuthError('No DUMB credentials configured');
		await this.loginWith(credentials.username, credentials.password);
	}

	async loginWith(username: string, password: string): Promise<void> {
		let response: Response;
		try {
			response = await this.request('/api/auth/login', {
				method: 'POST',
				auth: false,
				retry: false,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ username, password })
			});
		} catch (err) {
			if (err instanceof DumbError && err.status === null) throw err;
			throw new DumbAuthError('DUMB authentication failed', err);
		}
		if (response.status === 401 || response.status === 403) {
			throw new DumbAuthError('DUMB rejected the credentials');
		}
		if (!response.ok) {
			throw new DumbError(`DUMB login failed (HTTP ${response.status})`, response.status);
		}
		const data = (await response.json().catch(() => null)) as DumbTokenResponse | null;
		if (!data?.access_token) {
			throw new DumbAuthError('DUMB login response did not contain a token');
		}
		this.setTokens({ accessToken: data.access_token, refreshToken: data.refresh_token ?? null });
		this.options.onTokens?.({
			accessToken: data.access_token,
			refreshToken: data.refresh_token ?? null
		});
	}

	private async refreshTokens(): Promise<boolean> {
		// Coalesce concurrent refreshes.
		this.refreshPromise ??= this.doRefresh().finally(() => {
			this.refreshPromise = null;
		});
		return this.refreshPromise;
	}

	private async doRefresh(): Promise<boolean> {
		const refreshToken = this.tokens?.refreshToken;
		if (!refreshToken) {
			// Fall back to a fresh login when possible.
			if (this.options.getCredentials()) {
				try {
					await this.login();
					return true;
				} catch {
					return false;
				}
			}
			return false;
		}
		try {
			const response = await this.request('/api/auth/refresh', {
				method: 'POST',
				auth: false,
				retry: false,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ refresh_token: refreshToken })
			});
			if (!response.ok) return false;
			const data = (await response.json()) as DumbTokenResponse;
			if (!data.access_token) return false;
			this.setTokens({
				accessToken: data.access_token,
				refreshToken: data.refresh_token ?? refreshToken
			});
			this.options.onTokens?.({
				accessToken: data.access_token,
				refreshToken: data.refresh_token ?? refreshToken
			});
			return true;
		} catch {
			return false;
		}
	}

	/** Ensure we have a usable token, logging in if none exists or it is stale. */
	async ensureAuthenticated(): Promise<void> {
		if (!this.tokens) {
			await this.login();
			return;
		}
		if (Date.now() - this.tokens.acquiredAt > TOKEN_REFRESH_MARGIN_MS) {
			await this.refreshTokens();
		}
	}

	// -------------------------------------------------------------------------
	// REST endpoints (read-only surface used by DUMBscope)
	// -------------------------------------------------------------------------

	async health(): Promise<{ status: string }> {
		const response = await this.request('/api/health', { auth: false, retry: false });
		if (!response.ok)
			throw new DumbError(`DUMB health returned HTTP ${response.status}`, response.status);
		return (await response.json()) as { status: string };
	}

	async authStatus(): Promise<DumbAuthStatus> {
		const response = await this.request('/api/auth/status', { auth: false, retry: false });
		if (!response.ok)
			throw new DumbError(`auth/status returned HTTP ${response.status}`, response.status);
		return (await response.json()) as DumbAuthStatus;
	}

	async capabilities(): Promise<Record<string, unknown>> {
		const response = await this.request('/api/process/capabilities');
		if (!response.ok)
			throw new DumbError(`capabilities returned HTTP ${response.status}`, response.status);
		return (await response.json()) as Record<string, unknown>;
	}

	async processes(): Promise<DumbProcessesResponse> {
		const response = await this.request('/api/process/processes');
		if (!response.ok)
			throw new DumbError(`processes returned HTTP ${response.status}`, response.status);
		return (await response.json()) as DumbProcessesResponse;
	}

	async startupStatus(): Promise<Record<string, unknown> | null> {
		const response = await this.request('/api/process/startup-status');
		if (response.status === 404) return null;
		if (!response.ok)
			throw new DumbError(`startup-status returned HTTP ${response.status}`, response.status);
		return (await response.json()) as Record<string, unknown>;
	}

	async metrics(): Promise<DumbMetricsSnapshot> {
		const response = await this.request('/api/metrics');
		if (!response.ok)
			throw new DumbError(`metrics returned HTTP ${response.status}`, response.status);
		return (await response.json()) as DumbMetricsSnapshot;
	}

	async metricsHistorySeries(params: {
		since?: number;
		bucketSeconds?: number;
		maxPoints?: number;
	}): Promise<Record<string, unknown>> {
		const url = new URL('/api/metrics/history_series', this.baseUrl);
		if (params.since !== undefined) url.searchParams.set('since', String(Math.floor(params.since)));
		if (params.bucketSeconds !== undefined)
			url.searchParams.set('bucket_seconds', String(params.bucketSeconds));
		if (params.maxPoints !== undefined)
			url.searchParams.set('max_points', String(params.maxPoints));
		const path = url.pathname + url.search;
		const response = await this.request(path);
		if (!response.ok)
			throw new DumbError(`history_series returned HTTP ${response.status}`, response.status);
		return (await response.json()) as Record<string, unknown>;
	}

	async logsChunk(processName: string, cursor?: number): Promise<DumbLogsChunk> {
		const url = new URL('/api/logs', this.baseUrl);
		url.searchParams.set('process_name', processName);
		if (cursor !== undefined) url.searchParams.set('cursor', String(cursor));
		const response = await this.request(url.pathname + url.search);
		if (!response.ok) throw new DumbError(`logs returned HTTP ${response.status}`, response.status);
		return (await response.json()) as DumbLogsChunk;
	}

	/** Lightweight unauthenticated reachability probe used by setup. */
	async probe(): Promise<{
		reachable: boolean;
		status: string | null;
		authStatus: DumbAuthStatus | null;
	}> {
		const health = await this.health();
		let authStatus: DumbAuthStatus | null = null;
		try {
			authStatus = await this.authStatus();
		} catch {
			authStatus = null;
		}
		return { reachable: true, status: health.status, authStatus };
	}
}
