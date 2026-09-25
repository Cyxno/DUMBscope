/** App version single source of truth (package.json via vite define). */
export const APP_VERSION: string = __APP_VERSION__;

/**
 * Build provenance, injected by the production image build (Dockerfile
 * ARG BUILD_SHA / BUILD_DATE, wired from CI's checkout commit). Local/dev
 * builds pass nothing: empty and placeholder values normalize to null so the
 * UI and API degrade to version-only instead of printing garbage.
 *
 * BUILD_TIME is the pre-0.9.2 env name, still accepted as a fallback.
 */
function normalizeBuild(value: string | undefined): string | null {
	return value && value !== 'unknown' && value !== 'dev' ? value : null;
}

export const BUILD_SHA: string | null = normalizeBuild(process.env.BUILD_SHA);
export const BUILD_DATE: string | null = normalizeBuild(
	process.env.BUILD_DATE ?? process.env.BUILD_TIME
);

export const nodeVersion = process.version;

export function appInfo() {
	return {
		version: APP_VERSION,
		buildSha: BUILD_SHA,
		buildDate: BUILD_DATE,
		buildTime: BUILD_DATE, // legacy alias (AppInfo.buildTime consumers)
		nodeVersion
	};
}

declare const __APP_VERSION__: string;
