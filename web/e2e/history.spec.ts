import { expect, test, type Page } from '@playwright/test';

declare global { interface Window { __ARCHIPELAGO__?: { screenPositionOf(id: string): { x: number; y: number } | undefined; camera(): { x: number; y: number; scale: number }; visibleIds(): string[]; rectOf(id: string): { x: number; y: number; w: number; h: number } | undefined } } }
const base = `http://127.0.0.1:${process.env.E2E_HISTORY_PORT ?? 4398}`;
async function open(page: Page) {
  await page.goto(`${base}/`);
  await page.waitForFunction(() => (window.__ARCHIPELAGO__?.visibleIds().length ?? 0) > 2);
}
const timeline = (page: Page) => page.getByRole('region', { name: 'History' });
/** World-space origins of what is on screen: containers resize with their content, but nothing moves. */
const positions = (page: Page) => page.evaluate(() => Object.fromEntries(window.__ARCHIPELAGO__!.visibleIds().map(id => [id, window.__ARCHIPELAGO__!.rectOf(id)])));

test('the timeline steps through commits without moving the map, and shows what changed', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'History' }).click();
  await expect(timeline(page)).toContainText('4 commits, 4 indexed');
  await expect(timeline(page)).toContainText('Working tree');
  const slider = page.getByRole('slider', { name: /Commit timeline/ });
  await slider.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(timeline(page)).toContainText('Move the backend to server/');
  await expect(page.getByRole('button', { name: /moved/ }).first()).toBeEnabled();
  await page.waitForTimeout(400);
  const before = await positions(page);
  await page.keyboard.press('ArrowLeft');
  await expect(timeline(page)).toContainText('Move LoginForm, change user signature, drop users route');
  await page.waitForFunction(() => !document.querySelector('.switching'));
  await page.waitForTimeout(400);
  const after = await positions(page);
  const shared = Object.keys(before).filter(id => after[id]);
  expect(shared.length).toBeGreaterThan(3);
  for (const id of shared) expect([after[id]!.x, after[id]!.y]).toEqual([before[id]!.x, before[id]!.y]);
  const camera = await page.evaluate(() => window.__ARCHIPELAGO__!.camera());
  expect(camera.scale).toBeGreaterThan(0);
  // The overview lists the removed endpoint; selecting it shows its architectural diff.
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector).toContainText('Changed entities');
  await inspector.getByRole('button', { name: 'Go to GET /users/{id}' }).click();
  await expect(inspector.getByRole('region', { name: 'Changes versus the baseline' })).toContainText('removed');
  await expect(page).toHaveURL(/at=[0-9a-f]{12}&vs=[0-9a-f]{12}/);
});
test('a modified symbol opens a line diff between the two commits', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'History' }).click();
  const slider = page.getByRole('slider', { name: /Commit timeline/ });
  await slider.focus();
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  await expect(timeline(page)).toContainText('Edit login, add signup');
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill('login');
  await page.getByRole('option').filter({ hasText: 'modified' }).filter({ hasText: /^.*login/ }).first().click();
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByRole('region', { name: 'Changes versus the baseline' })).toContainText('source text changed');
  await inspector.getByRole('button', { name: 'Source diff' }).click();
  const diff = page.getByRole('region', { name: 'Source diff' });
  await expect(diff).toContainText('const body = email.trim();');
  await expect(diff.locator('tr.diff-added')).toHaveCount(2);
  await expect(diff.locator('tr.diff-removed')).toHaveCount(1);
  await diff.getByRole('button', { name: 'Side by side' }).click();
  await expect(diff.locator('table.split')).toBeVisible();
});
test('dragging the timeline shows each commit at once, and play runs through the history', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.locator('.play-button')).not.toHaveClass(/preparing/);
  const slider = page.getByRole('slider', { name: /Commit timeline/ });
  const box = (await slider.boundingBox())!;
  // Ticks sit on the axis (14 px padding, 46 px down): four commits, then the working tree.
  const at = (index: number) => [box.x + 14 + (index / 4) * (box.width - 28), box.y + 46] as const;
  await page.mouse.move(...at(0));
  await page.mouse.down();
  await expect(timeline(page)).toContainText('Initial import');
  await page.mouse.move(...at(1), { steps: 4 });
  await expect(timeline(page)).toContainText('Edit login, add signup');
  await expect(timeline(page)).toContainText('commit 2 of 4');
  await expect(page.locator('.switching')).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByRole('button', { name: /added/ }).first()).toBeEnabled();
  await page.getByRole('button', { name: 'Play the history as a time-lapse' }).click();
  await expect(timeline(page)).toContainText('playing');
  await expect(page.getByRole('button', { name: 'Play the history as a time-lapse' })).toBeVisible({ timeout: 10_000 });
  await expect(timeline(page)).toContainText('Move the backend to server/');
  await expect(page).toHaveURL(new RegExp(`at=[0-9a-f]{12}`));
});
