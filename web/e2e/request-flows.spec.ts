import { expect, test, type Page } from '@playwright/test';

// Request flows against the fixture repository served by web/e2e/server.ts:
// the list, the theater, a step's details, the map trace and the inspector's
// way in.
async function open(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => ((window as unknown as { __ARCHIPELAGO__?: { visibleIds(): string[] } }).__ARCHIPELAGO__?.visibleIds().length ?? 0) > 2);
}

test('request flows are listed by completeness and open as lanes from the page to the response', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Requests', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Request flows' });
  await expect(panel.locator('.rf-row').first()).toBeVisible();
  // Completeness filters.
  await panel.getByRole('button', { name: /Unmatched/ }).click();
  await expect(panel.locator('.rf-row', { hasText: '/nowhere/at/all' })).toBeVisible();
  await expect(panel.locator('.rf-row:not(.s-unmatched)')).toHaveCount(0);
  await panel.getByRole('button', { name: /Unmatched/ }).click();
  await panel.getByLabel('Filter request flows').fill('AuthController::login');
  await panel.locator('.rf-row', { hasText: '/auth/login' }).first().click();
  // The theater: one lane per layer the request passes, in order.
  const theater = page.getByRole('dialog', { name: 'Request flow POST /auth/login' });
  await expect(theater).toBeVisible();
  await expect(theater.locator('.rf-lane-title')).toHaveText(['▦ Client', '↗ HTTP call', '⇥ Route', '◈ Middleware', '⚙ Controller', 'ƒ Services', '⛁ Models & data', '↩ Response', '↘ Back on the client']);
  await expect(theater.locator('.rf-node.k-page', { hasText: '/account' })).toBeVisible();
  await expect(theater.locator('.rf-node.k-table', { hasText: 'users' })).toBeVisible();
  await expect(theater.locator('.rf-node.k-gap')).toHaveCount(1);
  // A step's details: its links, with the conditions read from the source and the evidence behind each hop.
  await theater.locator('.rf-node.k-receive', { hasText: 'signIn()' }).click();
  const detail = theater.getByRole('complementary', { name: 'Step AccountService.signIn' });
  await expect(detail).toContainText('when response.ok');
  await expect(detail).toContainText('in handleSave');
  await detail.getByRole('button', { name: 'Close step details' }).click();
  // Traced on the map, then back.
  await theater.getByRole('button', { name: 'Trace on map' }).click();
  const ribbon = page.getByRole('status', { name: 'Request flow on the map' });
  await expect(ribbon).toContainText('/auth/login');
  await ribbon.getByRole('button', { name: 'Diagram' }).click();
  await expect(theater).toBeVisible();
  await theater.getByRole('button', { name: 'Close request flow', exact: true }).click();
  await expect(theater).toHaveCount(0);
});
test('the inspector opens an endpoint\'s flow, and lists the flows through a table', async ({ page }) => {
  await open(page);
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill('PUT /profiles');
  await page.keyboard.press('Enter');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('button', { name: 'Request flow', exact: true }).click();
  const theater = page.getByRole('dialog', { name: 'Request flow PUT /profiles/{id}' });
  await expect(theater.locator('.rf-node.k-validation', { hasText: 'UpdateProfileRequest' })).toBeVisible();
  await expect(theater.locator('.rf-node.k-response')).toHaveCount(3);
  await expect(theater.locator('.rf-node.k-gap', { hasText: 'record()' })).toBeVisible();
  await theater.getByRole('button', { name: 'Close request flow', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill('users');
  await page.keyboard.press('Enter');
  await inspector.getByRole('button', { name: 'Request flows', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Request flows' });
  await expect(panel.locator('.rf-through')).toContainText('users');
  await expect(panel.locator('.rf-row', { hasText: '/profiles/{id}' }).first()).toBeVisible();
  await expect(panel.locator('.rf-row', { hasText: '/api/ping' })).toHaveCount(0);
});
