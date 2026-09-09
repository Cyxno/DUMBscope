/** App version single source of truth (package.json via vite define). */
export const APP_VERSION: string = __APP_VERSION__;

export const BUILD_SHA: string | null = process.env.BUILD_SHA ?? null;
export const BUILD_TIME: string | null = process.env.BUILD_TIME ?? null;

export const nodeVersion = process.version;

export function appInfo() {
	return {
		version: APP_VERSION,
		buildSha: BUILD_SHA,
		buildTime: BUILD_TIME,
		nodeVersion
	};
}

declare const __APP_VERSION__: string;
