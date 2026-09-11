import { defineConfig } from '@playwright/test';

/**
 * E2E interaction tests. The test environment (mock DUMB gateway + app
 * instance + automated setup + authenticated session) is managed by
 * `tests/e2e/harness.mjs` — run everything with `pnpm e2e`.
 */
export default defineConfig({
	testDir: 'tests/e2e',
	timeout: 30_000,
	retries: 0,
	workers: 1,
	reporter: [['list']],
	use: {
		baseURL: 'http://127.0.0.1:4173',
		storageState: 'tests/e2e/.auth/state.json',
		viewport: { width: 1440, height: 900 },
		headless: true
	},
	expect: { timeout: 7_000 },
	projects: [{ name: 'chromium', use: { browserName: 'chromium' } }]
});
