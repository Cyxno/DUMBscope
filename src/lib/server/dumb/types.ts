/**
 * Raw DUMB API response shapes (subset we consume).
 *
 * Derived from the official DUMB documentation bundled with the container
 * (docs/api/*.md) and kept tolerant: every field is optional so an older or
 * newer DUMB version cannot crash DUMBscope. Normalization happens in
 * `normalize.ts`.
 */

export interface DumbAuthStatus {
	enabled?: boolean;
	has_users?: boolean;
	setup_skipped?: boolean;
	mode?: 'local' | 'hybrid' | 'oidc' | string;
	local_login_enabled?: boolean;
	oidc_login_enabled?: boolean;
	oidc_provider_name?: string;
}

export interface DumbTokenResponse {
	access_token?: string;
	refresh_token?: string;
	token_type?: string;
	detail?: string;
}

export interface DumbProcessEntry {
	name?: string;
	process_name?: string;
	enabled?: boolean;
	config?: Record<string, unknown>;
	version?: string | null;
	key?: string;
	config_key?: string;
	repo_url?: string | null;
	sponsorship_url?: string | null;
	supports_manual_update?: boolean;
	update_status?: {
		status?: string;
		current_version?: string | null;
		available_version?: string | null;
	} | null;
}

export interface DumbProcessesResponse {
	processes?: DumbProcessEntry[];
	detail?: string;
}

export interface DumbRestartState {
	restart_attempts?: number;
	restart_successes?: number;
	restart_failures?: number;
	recent_restart_attempts?: number;
	pending?: boolean;
	next_restart_time?: number | string | null;
	disabled?: boolean;
	last_restart_time?: number | string | null;
	last_failure_reason?: string | null;
	last_exit_time?: number | string | null;
	last_exit_reason?: string | null;
	unhealthy_count?: number;
	unhealthy_threshold?: number;
}

export interface DumbServiceStatus {
	process_name?: string;
	status?: string;
	healthy?: boolean;
	health_status?: string;
	health_reason?: string | null;
	health_details?: Record<string, unknown> | null;
	restart?: DumbRestartState | Record<string, never>;
}

export interface DumbProcessMetric {
	pid?: number;
	name?: string;
	process_name?: string;
	cpu_percent?: number;
	rss?: number;
}

export interface DumbFilesystem {
	path?: string;
	total?: number;
	used?: number;
	free?: number;
	percent?: number;
	inode_percent?: number;
}

export interface DumbNetworkInterface {
	name?: string;
	sent_bytes?: number;
	recv_bytes?: number;
	sent_rate?: number;
	recv_rate?: number;
}

export interface DumbMetricsSnapshot {
	timestamp?: number;
	system?: {
		scope?: string;
		cpu_percent?: number;
		cpu_count?: number;
		load_avg?: number[];
		mem?: { total?: number; used?: number; percent?: number };
		disk?: { path?: string; total?: number; used?: number; free?: number; percent?: number };
		inode?: { path?: string; percent?: number };
		filesystems?: DumbFilesystem[];
		net_io?: { sent_bytes?: number; recv_bytes?: number };
		network_interfaces?: DumbNetworkInterface[];
	};
	dumb_managed?: DumbProcessMetric[];
	external?: DumbProcessMetric[];
	database_health?: Record<
		string,
		{ healthy?: boolean; reason?: string | null; timestamp?: number } | undefined
	>;
}

export type DumbWsMessage =
	| { type: 'status'; running?: string[]; processes?: DumbServiceStatus[] }
	| { type: 'snapshot'; data?: DumbMetricsSnapshot }
	| { type: 'history'; items?: unknown[] }
	| { type: 'bootstrap'; snapshot?: DumbMetricsSnapshot; items?: unknown[] }
	| { type: 'pong' }
	| { type: string };

export interface DumbLogsChunk {
	process_name?: string;
	size?: number;
	cursor?: number;
	chunk?: string;
	reset?: boolean;
	log?: string;
}
