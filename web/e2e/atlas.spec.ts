import { expect, test, type Page } from '@playwright/test';

declare global { interface Window { __ARCHIPELAGO__?: { screenPositionOf(id: string): { x: number; y: number } | undefined; camera(): { x: number; y: number; scale: number }; visibleIds(): string[]; rectOf(id: string): { x: number; y: number; w: number; h: number } | undefined } } }

async function open(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => (window.__ARCHIPELAGO__?.visibleIds().length ?? 0) > 2);
}
/** Type and press Enter immediately, as a fast user would. */
async function search(page: Page, query: string) {
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill(query);
  await page.keyboard.press('Enter');
}
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });

test('map renders application areas at device pixel ratio and selects by clicking the canvas', async ({ page }) => {
  await open(page);
  const canvas = page.locator('canvas.map-canvas');
  const size = await canvas.evaluate((element: HTMLCanvasElement) => ({ width: element.width, css: element.getBoundingClientRect().width }));
  expect(size.width).toBe(Math.round(size.css * 2));
  const visible = await page.evaluate(() => window.__ARCHIPELAGO__!.visibleIds());
  const apps = await page.evaluate(async ids => {
    const response = await fetch(`/api/projection/nodes?ids=${ids.map(encodeURIComponent).join(',')}`).then(r => r.json());
    return response.items.filter((item: { type: string }) => item.type === 'application').map((item: { id: string; name: string }) => item);
  }, visible);
  expect(apps.map((app: { name: string }) => app.name).sort()).toEqual(['backend', 'frontend']);
  const backend = apps.find((app: { name: string }) => app.name === 'backend');
  const point = await page.evaluate(id => window.__ARCHIPELAGO__!.screenPositionOf(id), backend.id);
  expect(point).toBeTruthy();
  // The center of an open application may be covered by a child; any hit inside backend selects backend or a descendant.
  await page.mouse.click(point!.x, point!.y);
  await expect(page.getByRole('navigation', { name: 'Canonical location of the selection' })).toContainText('backend');
});
test('search reveals a deeply nested method and navigates the map to it', async ({ page }) => {
  await open(page);
  const before = await page.evaluate(() => window.__ARCHIPELAGO__!.camera().scale);
  await search(page, 'AuthController::login');
  await expect(inspector(page).getByRole('heading', { name: 'login' })).toBeVisible();
  await expect(inspector(page)).toContainText('App\\Http\\Controllers\\AuthController::login');
  const crumbs = page.getByRole('navigation', { name: 'Canonical location of the selection' });
  for (const part of ['fixture', 'backend', 'Controllers', 'AuthController.php', 'AuthController', 'login']) await expect(crumbs).toContainText(part);
  await expect.poll(() => page.evaluate(() => window.__ARCHIPELAGO__!.camera().scale)).toBeGreaterThan(before * 4);
  const id = await page.evaluate(async () => (await fetch('/api/projection/search?q=AuthController::login').then(r => r.json())).items[0].id);
  await expect.poll(() => page.evaluate(target => window.__ARCHIPELAGO__!.visibleIds().includes(target), id)).toBe(true);
  // Back returns to the previous location.
  await search(page, 'LoginForm');
  await expect(inspector(page).getByRole('heading', { name: 'LoginForm' }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Back to previous selection' }).click();
  await expect(inspector(page).getByRole('heading', { name: 'login' })).toBeVisible();
});
test('relationship evidence opens highlighted supporting source', async ({ page }) => {
  await open(page);
  await search(page, 'POST /auth/login');
  await expect(inspector(page).getByRole('heading', { name: 'POST /auth/login' })).toBeVisible();
  const handled = inspector(page).locator('li.row', { hasText: 'handled by' });
  await expect(handled).toContainText('login');
  await handled.getByRole('button', { name: /^Why is/ }).click();
  const evidence = page.getByRole('dialog', { name: 'Why is this connected?' });
  await expect(evidence).toContainText('Laravel Route facade declaration');
  const card = evidence.locator('.evidence-card', { hasText: 'backend/routes/api.php:6' });
  await expect(card).toContainText('100% confidence');
  await card.getByRole('button', { name: 'Open source' }).click();
  const source = page.getByRole('region', { name: 'Source' });
  await expect(source.locator('tr.focus')).toHaveCount(1);
  await expect(source.locator('tr.focus')).toHaveAttribute('data-line', '6');
  await expect(source.locator('tr.focus')).toContainText("Route::post('login'");
  await expect(source.locator('tr.focus .hljs-string').first()).toBeVisible();
});
test('dynamic requests are shown as unresolved, not linked', async ({ page }) => {
  await open(page);
  // A relative template URL from Next: its pattern matches Laravel, but nothing proves the boundary.
  await search(page, 'dynamicUrl');
  await expect(inspector(page).getByRole('heading', { name: 'dynamicUrl' })).toBeVisible();
  await expect(inspector(page)).toContainText('Unresolved findings');
  await expect(inspector(page)).toContainText('unverified-relative-api-boundary');
  await expect(inspector(page)).toContainText('Relative URL with dynamic segments');
  await expect(inspector(page).locator('.relation-phrase', { hasText: 'requests' })).toHaveCount(0);
  // Options the analyzer cannot read leave the URL unresolved.
  await search(page, 'dynamicOptions');
  await expect(inspector(page).getByRole('heading', { name: 'dynamicOptions' })).toBeVisible();
  await expect(inspector(page)).toContainText('unresolved-http-call');
  await expect(inspector(page)).toContainText('Unresolved: the request could not be proven');
  await expect(inspector(page).locator('.relation-phrase', { hasText: 'requests' })).toHaveCount(0);
});
test('keyboard: slash focuses search, escape clears selection, arrow keys pan the focused map', async ({ page }) => {
  await open(page);
  await page.locator('body').press('/');
  await expect(page.getByRole('combobox', { name: 'Search the indexed graph' })).toBeFocused();
  await search(page, 'LoginForm');
  await expect(inspector(page).getByRole('heading', { name: 'LoginForm' }).first()).toBeVisible();
  const canvas = page.locator('canvas.map-canvas');
  await canvas.focus();
  const before = await page.evaluate(() => window.__ARCHIPELAGO__!.camera());
  await page.keyboard.press('ArrowRight');
  const after = await page.evaluate(() => window.__ARCHIPELAGO__!.camera());
  expect(after.x).toBeGreaterThan(before.x);
  await page.keyboard.press('Escape');
  await expect(inspector(page)).toContainText('Search with');
});
