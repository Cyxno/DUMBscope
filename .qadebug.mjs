import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => console.log('console:', m.text().slice(0, 150)));
page.on('request', (r) => { if (r.url().includes('/api/library/movies?')) console.log('REQ:', r.url().slice(-60)); });
await page.goto('http://127.0.0.1:8111/login');
await page.locator('input[autocomplete=username]').fill('qaadmin');
await page.locator('input[type=password]').first().fill('qa-password-123');
await page.getByRole('button', { name: /sign in|log ?in/i }).click();
await page.waitForTimeout(4000);
await page.goto('http://127.0.0.1:8111/library?view=movies');
await page.waitForTimeout(4000);
await expectGrid(page);
async function expectGrid(page) {
	await page.locator('ul.grid button').first().waitFor({ state: 'visible', timeout: 15000 });
}
console.log('grid visible, typing zzzz...');
await page.getByPlaceholder('Search movies…').click();
await page.getByPlaceholder('Search movies…').fill('zzzz');
await page.waitForTimeout(1500);
const value = await page.getByPlaceholder('Search movies…').evaluate((el) => el.value);
console.log('input value now:', JSON.stringify(value));
const url = page.url();
console.log('url now:', url);
const bodyText = await page.locator('main').innerText();
console.log('has no-match text:', bodyText.includes('No movies match'));
await browser.close();
