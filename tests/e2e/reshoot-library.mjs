import { chromium } from '@playwright/test';
const BASE = 'http://127.0.0.1:8092';
const OUT = '/root/dumbscope-qa/pw/shots/library';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[autocomplete=username]').fill('betalib');
await page.locator('input[type=password]').first().fill('BetaLib-2026-Library');
await page.getByRole('button', { name: /sign in|log ?in/i }).click();
await page.waitForTimeout(8000);
async function expand() {
	await page.evaluate(() => {
		const root = document.querySelector('div.flex.h-dvh');
		if (root) {
			root.style.height = 'auto';
			root.style.overflow = 'visible';
		}
		const main = document.querySelector('main');
		if (main) main.style.overflow = 'visible';
	});
}
await page.goto(`${BASE}/library`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(10000);
await expand();
await page.screenshot({ path: `${OUT}/1440x900-library-overview.png`, fullPage: true });
console.log('overview reshot');
await browser.close();
