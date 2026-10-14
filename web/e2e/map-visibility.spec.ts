import { test, expect, type Page } from '@playwright/test';

async function select(page: Page, text: string) {
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill(text);
  await page.keyboard.press('Enter');
}
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });
test.afterEach(async ({ request }) => {
  await request.post('/api/projection/map-visibility', { headers: { 'X-Codiluce-Request': 'map-visibility' }, data: { action: 'restore-all' } });
});

test('hide a folder, persist across reload, reveal a hidden search result, and restore from the list', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await select(page, 'AuthService.php');
  await page.getByRole('navigation', { name: 'Canonical location of the selection' }).getByRole('button', { name: 'Services', exact: true }).click();
  await expect(inspector(page).getByRole('heading', { name: 'Services', exact: true })).toBeVisible();
  await inspector(page).getByRole('button', { name: 'Hide from map', exact: true }).click();
  await expect(page.getByRole('button', { name: '1 hidden', exact: true })).toBeVisible();
  await expect(inspector(page)).toContainText('Hidden from map.');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '1 hidden', exact: true })).toBeVisible();
  await select(page, 'AuthService.php');
  await expect(inspector(page).getByRole('heading', { name: 'AuthService.php', exact: true })).toBeVisible();
  await expect(inspector(page)).toContainText('Hidden from map.');
  await inspector(page).getByRole('button', { name: 'Reveal on map', exact: true }).click();
  await expect(inspector(page).getByRole('button', { name: 'Hide from map', exact: true })).toBeEnabled();
  await expect(inspector(page)).not.toContainText('Hidden from map.');
  await page.getByRole('button', { name: '1 hidden', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Hidden paths', exact: true });
  await expect(dialog).toContainText('backend/app/Services');
  await expect(dialog).toContainText('Visible exceptions');
  await page.screenshot({ path: '/tmp/codiluce-hidden-paths.png' });
  await dialog.getByRole('button', { name: 'Restore backend/app/Services', exact: true }).click();
  await expect(dialog).toContainText('No locally hidden paths.');
  await dialog.getByRole('button', { name: 'Close hidden paths', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hidden paths', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('right-click a map file to hide it and Undo restores its footprint', async ({ page }) => {
  await page.goto('/');
  await select(page, 'AuthService.php');
  await expect(inspector(page).getByRole('heading', { name: 'AuthService.php', exact: true })).toBeVisible();
  const id = await page.evaluate(async () => (await fetch('/api/projection/search?q=AuthService.php').then(response => response.json())).items[0].id as string);
  type Debug = { screenPositionOf(id: string): { x: number; y: number } | undefined; visibleIds(): string[] };
  const point = () => page.evaluate(target => (window as unknown as { __CODILUCE__: Debug }).__CODILUCE__.screenPositionOf(target), id);
  await expect.poll(point).toBeTruthy();
  const position = (await point())!;
  await page.mouse.click(position.x, position.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Map actions for AuthService.php' });
  await expect(menu).toBeVisible();
  await page.screenshot({ path: '/tmp/codiluce-map-context.png' });
  await menu.getByRole('menuitem', { name: 'Hide from map' }).click();
  await expect(inspector(page)).toContainText('Hidden from map.');
  await expect.poll(() => page.evaluate(target => (window as unknown as { __CODILUCE__: Debug }).__CODILUCE__.visibleIds().includes(target), id)).toBe(false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(inspector(page).getByRole('button', { name: 'Hide from map', exact: true })).toBeEnabled();
  await expect(inspector(page)).not.toContainText('Hidden from map.');
  await expect(page.getByRole('button', { name: 'Hidden paths', exact: true })).toBeVisible();
});
