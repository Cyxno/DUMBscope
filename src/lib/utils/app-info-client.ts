/** Client-side app info (version injected by vite define). */
export const appInfoClient = {
	version: __APP_VERSION__,
	buildSha: import.meta.env.VITE_BUILD_SHA ?? null,
	nodeVersion: ''
} as { version: string; buildSha: string | null; nodeVersion: string };

declare const __APP_VERSION__: string;
