import { test, expect } from '@playwright/test';

test('the header holds search, Back and History; the rail picks the column\'s view, which a selection never moves', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const header = page.locator('.topbar');
  await expect(header.getByRole('button')).toHaveText(['←', '→', 'History']);
  await expect(header.getByRole('combobox', { name: 'Theme' })).toHaveCount(0);
  const rail = page.getByRole('navigation', { name: 'Views' });
  expect(await rail.locator('.rail-item').evaluateAll(items => items.map(item => item.getAttribute('aria-label')))).toEqual(['Selection', 'Code', 'Impact', 'Flows', 'Dependencies', 'People', 'PRs', 'Explain', 'Agents', 'Settings', 'Help']);
  await expect(rail.getByRole('button', { name: 'Selection', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Color by is on the map.
  await expect(page.locator('.map-color-by').getByRole('button', { name: /^Color/ })).toBeVisible();
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill('authenticate');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: 'authenticate', exact: true })).toBeVisible();
  const impactItem = rail.getByRole('button', { name: 'Impact', exact: true });
  await impactItem.click();
  const impact = page.getByRole('complementary', { name: 'Impact' }).getByRole('region', { name: 'Blast radius' });
  await expect(impact.getByRole('heading', { name: 'Impact of authenticate', exact: true })).toBeVisible();
  await expect(impact).toContainText('affected.');
  await expect(impact.getByRole('button', { name: 'The selection: authenticate', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // Another selection leaves the column where it is.
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill('LoginForm.tsx');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('navigation', { name: 'Canonical location of the selection' }).locator('[aria-current="true"]')).toHaveText('LoginForm.tsx');
  await expect(impactItem).toHaveAttribute('aria-pressed', 'true');
  await expect(impact.getByRole('heading', { name: 'Impact of authenticate', exact: true })).toBeVisible();
  // The item of the view shown hides the column; the view stays marked.
  await impactItem.click();
  await expect(page.locator('#column')).toHaveCount(0);
  await expect(impactItem).toHaveAttribute('data-current', 'true');
  await impactItem.click();
  await expect(impact).toBeVisible();
  // One width for every view, resized by the column's edge.
  const column = page.locator('#column');
  const before = (await column.boundingBox())!.width;
  await column.getByRole('separator', { name: 'Resize the column' }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await column.boundingBox())!.width).toBe(before + 48);
  await rail.getByRole('button', { name: 'People', exact: true }).click();
  await expect.poll(async () => (await column.boundingBox())!.width).toBe(before + 48);
  expect(errors).toEqual([]);
});
