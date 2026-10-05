import { expect, test, type Page } from '@playwright/test';

// Flows against the fixture repository served by web/e2e/server.ts: the
// Flows panel, a request shown on the map, its lanes, a step's details, and
// the inspector's way in.
const visibleIds = () => (window as unknown as { __ARCHIPELAGO__?: { visibleIds(): string[] } }).__ARCHIPELAGO__?.visibleIds() ?? [];
async function open(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => ((window as unknown as { __ARCHIPELAGO__?: { visibleIds(): string[] } }).__ARCHIPELAGO__?.visibleIds().length ?? 0) > 2);
}
async function idOf(page: Page, query: string, type: string): Promise<string> {
  return page.evaluate(async ([q, t]) => (await fetch(`/api/projection/search?q=${encodeURIComponent(q!)}&type=${t}`).then(response => response.json())).items[0].id as string, [query, type]);
}

test('one list holds every flow, filtered by kind and completeness; a request is shown on the map, then as lanes', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Flows' });
  await expect(panel.getByRole('tab')).toHaveText([/^All/, /^Pages/, /^Requests/, /^Console/]);
  await expect(panel.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
  // Pages, requests and the console in one list.
  await expect(panel.locator('.rf-row.k-page', { hasText: '/account' }).first()).toBeVisible();
  await expect(panel.locator('.rf-row.k-request', { hasText: '/auth/login' }).first()).toBeVisible();
  await expect(panel.locator('.rf-row.k-command', { hasText: 'reports:send' })).toBeVisible();
  // The kind filters narrow it; completeness is only offered where there are HTTP flows.
  await panel.getByRole('tab', { name: /^Console/ }).click();
  await expect(panel.locator('.rf-row', { hasText: 'daily at 02:00' })).toBeVisible();
  await expect(panel.locator('.rf-row:not(.k-command):not(.k-schedule)')).toHaveCount(0);
  await expect(panel.getByRole('group', { name: 'Filter by completeness' })).toHaveCount(0);
  await panel.getByRole('tab', { name: /^Pages/ }).click();
  await expect(panel.locator('.rf-row:not(.k-page)')).toHaveCount(0);
  await panel.getByRole('tab', { name: /^All/ }).click();
  // Completeness filters.
  await panel.getByRole('button', { name: /Unmatched/ }).click();
  await expect(panel.locator('.rf-row', { hasText: '/nowhere/at/all' })).toBeVisible();
  await expect(panel.locator('.rf-row:not(.s-unmatched)')).toHaveCount(0);
  await panel.getByRole('button', { name: /Unmatched/ }).click();
  await panel.getByLabel('Filter flows').fill('AuthController::login');
  await panel.locator('.rf-row', { hasText: '/auth/login' }).first().click();
  // On the map, branch by branch: one per place the request starts from, each shown wave by wave down to the table.
  const player = page.getByRole('region', { name: 'Flow on the map: POST /auth/login' });
  const branches = player.getByRole('group', { name: 'Branches' });
  await expect(branches.locator('.flow-branch')).toHaveCount(3);
  await expect(branches.locator('.flow-branch.current')).toContainText('/account');
  const waves = player.getByRole('list', { name: 'This branch, wave by wave' });
  await expect(waves.locator('.flow-wave', { hasText: 'handleSave' })).toContainText('login', { useInnerText: true });
  await expect(waves.locator('.flow-stop', { hasText: 'users' })).toBeVisible();
  await branches.locator('.flow-branch', { hasText: '/login' }).click();
  await expect(branches.locator('.flow-branch.current')).toContainText('/login');
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: '/login', exact: true })).toBeVisible();
  await expect(waves.locator('.flow-stop', { hasText: 'handleSave' })).toHaveCount(0);
  await branches.locator('.flow-branch', { hasText: '/account' }).click();
  const users = await idOf(page, 'users', 'database_table');
  await expect.poll(() => page.evaluate(visibleIds), { timeout: 10000 }).toContain(users);
  await player.getByRole('button', { name: 'Pause' }).click();
  await player.locator('.flow-stop', { hasText: 'users' }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: 'users', exact: true })).toBeVisible();
  // The same flow as lanes: one per layer the request passes, in order.
  await player.getByRole('button', { name: 'Lanes' }).click();
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
  // Back on the map.
  await theater.getByRole('button', { name: 'Show on map', exact: true }).click();
  await expect(theater).toHaveCount(0);
  await expect(player).toBeVisible();
  await player.getByRole('button', { name: 'Stop showing this flow on the map' }).click();
  await expect(player).toHaveCount(0);
});
test('the inspector shows an endpoint\'s flow on the map, and lists the flows through a table', async ({ page }) => {
  await open(page);
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill('PUT /profiles');
  await page.keyboard.press('Enter');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('button', { name: 'Show flow on map', exact: true }).click();
  const player = page.getByRole('region', { name: 'Flow on the map: PUT /profiles/{id}' });
  await expect(player.locator('.flow-stop', { hasText: 'ProfileController::update' })).toBeVisible();
  await player.getByRole('button', { name: 'Lanes' }).click();
  const theater = page.getByRole('dialog', { name: 'Request flow PUT /profiles/{id}' });
  await expect(theater.locator('.rf-node.k-validation', { hasText: 'UpdateProfileRequest' })).toBeVisible();
  await expect(theater.locator('.rf-node.k-response')).toHaveCount(3);
  await expect(theater.locator('.rf-node.k-gap', { hasText: 'record()' })).toBeVisible();
  await theater.getByRole('button', { name: 'Close request flow', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill('users');
  await page.keyboard.press('Enter');
  await expect(inspector.getByRole('heading', { name: 'users', exact: true })).toBeVisible();
  await expect(inspector.locator('.flows-section')).toContainText('/account');
  await inspector.getByRole('button', { name: /in the Flows panel/ }).click();
  const panel = page.getByRole('complementary', { name: 'Flows' });
  await expect(panel.locator('.rf-through')).toContainText('users');
  await expect(panel.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('.rf-row.k-page', { hasText: '/account' }).first()).toBeVisible();
  await expect(panel.locator('.rf-row', { hasText: '/profiles/{id}' }).first()).toBeVisible();
  await expect(panel.locator('.rf-row', { hasText: '/api/ping' })).toHaveCount(0);
});
test('a file says whether flows touch it and why; the coverage lens colors the map', async ({ page }) => {
  await open(page);
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill('PruneReports.php');
  await page.keyboard.press('Enter');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.locator('.coverage-reason')).toContainText('Entry point: command reports:prune');
  await expect(inspector.locator('.relation-phrase', { hasText: 'writes' })).toBeVisible();
  await expect(inspector).toContainText('through handle in this file');
  await page.getByRole('button', { name: 'Coverage', exact: true }).click();
  const legend = page.getByRole('region', { name: 'Coverage lens' });
  await expect(legend).toContainText('% of');
  await expect(legend).toContainText('Entry point');
  await legend.getByRole('button', { name: 'Hide coverage' }).click();
  await expect(legend).toHaveCount(0);
});
