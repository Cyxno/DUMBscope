import { expect, test } from '@playwright/test';

test('library overview: completion cards, attention and queue intelligence', async ({ page }) => {
	await page.goto('/library');
	await expect(page.getByRole('heading', { name: 'Media library' })).toBeVisible();

	// Completion cards (§30): TV ~97%, Movies ~92%, Subtitles present.
	await expect(page.getByText('14 episodes missing')).toBeVisible();
	await expect(page.getByText('21 upgrades available')).toBeVisible();
	await expect(page.getByText('3 movies missing')).toBeVisible();
	await expect(page.getByText('subtitle gaps').first()).toBeVisible();

	// Attention (§31/§39): the failed import is an issue, not the backlog.
	await expect(page.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
	await expect(page.getByText(/1 import issue/)).toBeVisible();
	await expect(
		page
			.getByText(/2 missing items older than 30 days/)
			.or(page.getByText(/items older than 30 days/))
	).toBeVisible();
});

test('TV tab: ranked missing list with full titles and backlog ages', async ({ page }) => {
	await page.goto('/library?view=tv');
	await expect(page.getByText('Missing episodes — 14')).toBeVisible();

	// Most-missing series ranked first (Foxglove: 4), full friendly names.
	const list = page.getByRole('list');
	await expect(list.getByText('Foxglove').first()).toBeVisible();
	await expect(list.getByText('Dark Meadow').first()).toBeVisible();

	// Backlog age summary line (§13): buckets present, 30d+ bucket dominant.
	await expect(page.getByText(/Backlog ages/)).toBeVisible();
	await expect(page.getByText('30d+: 7')).toBeVisible();
});

test('movies tab: missing movies with release dates', async ({ page }) => {
	await page.goto('/library?view=movies');
	await expect(page.getByText('Missing movies — 3')).toBeVisible();
	await expect(page.getByText('Distant Shores')).toBeVisible();
	await expect(page.getByText('Electric Sky')).toBeVisible();
	await expect(page.getByText('Falling Stars')).toBeVisible();
});

test('subtitles tab: per-language coverage table (§22)', async ({ page }) => {
	await page.goto('/library?view=subtitles');
	await expect(page.getByRole('columnheader', { name: 'Coverage' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'Dutch' })).toBeVisible();
	await expect(page.getByRole('cell', { name: 'English' })).toBeVisible();
});

test('queue tab: combined queue with the failed import flagged (§26–§28)', async ({ page }) => {
	await page.goto('/library?view=queue');
	await expect(page.getByText('Queue — 1 items')).toBeVisible();
	await expect(page.getByText('Queue issues')).toBeVisible();
	await expect(page.getByText('Import failed — sonarr')).toBeVisible();
});
