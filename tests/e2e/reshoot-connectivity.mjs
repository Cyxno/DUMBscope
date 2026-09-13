import { chromium } from '@playwright/test';
const BASE = 'http://127.0.0.1:4173';
const MOCK = 'http://127.0.0.1:3105';
const OUT = '/root/dumbscope-qa/pw/shots/reliability';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.locator('input[autocomplete=username]').fill('admin2');
await page.locator('input[type=password]').first().fill('admin2-password-123');
await page.getByRole('button', { name: /sign in|log ?in/i }).click();
await page.waitForTimeout(9000);
await page.waitForTimeout(6000);

// 1. Overview connected (desktop)
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/overview-connected-1440.png` });

// 2. Indicator popover (connected)
await page.getByRole('button', { name: /Connection status/i }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/indicator-connected-1440.png` });
await page.keyboard.press('Escape');
await page.mouse.click(720, 850);

// 3. System page diagnostics card
await page.goto(`${BASE}/system`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/system-connection-1440.png`, fullPage: false });

// 4. Amber reconnect journey: gateway down → banner + popover
await fetch(`${MOCK}/__control/down`, { method: 'POST' });
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/overview-reconnecting-1440.png` });
await page.getByRole('button', { name: /Connection status/i }).click();
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/indicator-reconnecting-1440.png` });
await fetch(`${MOCK}/__control/up`, { method: 'POST' });
await page.waitForTimeout(15000);
await page.screenshot({ path: `${OUT}/overview-recovered-1440.png` });

// 5. Mobile overview during reconnect
await fetch(`${MOCK}/__control/down`, { method: 'POST' });
const mob = await browser.newPage({ viewport: { width: 390, height: 844 } });
await mob.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await mob.locator('input[autocomplete=username]').fill('admin2');
await mob.locator('input[type=password]').first().fill('admin2-password-123');
await mob.getByRole('button', { name: /sign in|log ?in/i }).click();
await mob.waitForTimeout(9000);
await mob.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await mob.waitForTimeout(5000);
await mob.screenshot({ path: `${OUT}/overview-reconnecting-390.png` });
await fetch(`${MOCK}/__control/up`, { method: 'POST' });
await browser.close();
console.log('connectivity shots done');
