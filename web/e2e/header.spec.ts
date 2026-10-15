import { test, expect } from '@playwright/test';

test('header groups its layouts and opens Impact on the selection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const header = page.locator('.topbar');
  const sidebar = header.getByRole('group', { name: 'Sidebar panels', exact: true });
  await expect(sidebar.getByRole('button')).toHaveText(['Flows', 'People', 'PRs']);
  await expect(header.getByRole('group', { name: 'Center tools' }).getByRole('button')).toHaveText(['Impact']);
  await expect(header.getByRole('group', { name: 'Additional columns' }).getByRole('button')).toHaveText(['Explain', 'Code']);
  await expect(header.getByRole('combobox', { name: 'Theme' })).toHaveCount(0);
  await expect(header.getByRole('button', { name: /hidden/i })).toHaveCount(0);
  await expect(sidebar.getByRole('button', { name: 'Flows' })).not.toHaveClass(/rf-top/);
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill('authenticate');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: 'authenticate', exact: true })).toBeVisible();
  await header.getByRole('button', { name: 'Impact', exact: true }).click();
  const impact = page.getByRole('region', { name: 'Blast radius' });
  await expect(impact.getByRole('heading', { name: 'Impact of authenticate', exact: true })).toBeVisible();
  await expect(impact).toContainText('affected.');
  await expect(impact.getByRole('button', { name: 'The selection: authenticate', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(impact.getByRole('button', { name: 'Show on map', exact: true })).toBeEnabled();
  expect(errors).toEqual([]);
});
