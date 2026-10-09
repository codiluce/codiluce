import { expect, test, type Page } from '@playwright/test';

// Flows against the fixture repository served by web/e2e/server.ts: the
// Flows panel, a request shown on the map, its lanes, a step's details, and
// the inspector's way in.
const visibleIds = () => (window as unknown as { __CODILUCE__?: { visibleIds(): string[] } }).__CODILUCE__?.visibleIds() ?? [];
async function open(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => ((window as unknown as { __CODILUCE__?: { visibleIds(): string[] } }).__CODILUCE__?.visibleIds().length ?? 0) > 2);
}
async function idOf(page: Page, query: string, type: string): Promise<string> {
  return page.evaluate(async ([q, t]) => (await fetch(`/api/projection/search?q=${encodeURIComponent(q!)}&type=${t}`).then(response => response.json())).items[0].id as string, [query, type]);
}

for (const empty of [true, false]) {
  test(`${empty ? 'empty' : 'populated'} Flows stays responsive through coverage and history`, async ({ page }) => {
    if (empty) await page.route('**/api/projection/flows*', route => route.fulfill({ json: { items: [], counts: { page: 0, request: 0, command: 0, schedule: 0, unmatched: 0 } } }));
    await open(page);
    await page.getByRole('button', { name: 'Flows', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Flows' });
    if (!empty) await panel.getByRole('button', { name: 'Expand all', exact: true }).click();
    const loaded = empty ? panel.getByText('No flows were indexed.', { exact: true }) : panel.locator('.rf-row').first();
    await expect(loaded).toBeVisible();
    await page.getByRole('button', { name: 'Coverage', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Coverage lens' })).toBeVisible();
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.getByRole('region', { name: 'History' })).toContainText('No history indexed yet.');
    await page.getByRole('button', { name: 'Close history', exact: true }).click();
    await expect(page.getByRole('region', { name: 'History' })).toHaveCount(0);
    await expect(loaded).toBeVisible();
    // Reopening the panel reads the cached catalog, which must also settle.
    await page.getByRole('button', { name: 'Hide the flows panel', exact: true }).click();
    await page.getByRole('button', { name: 'Flows', exact: true }).click();
    await expect(loaded).toBeVisible();
    await page.getByRole('button', { name: 'Coverage', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Coverage lens' })).toHaveCount(0);
  });
}

test('one list holds every flow, filtered by kind and completeness; a request is shown on the map, then as lanes', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Flows' });
  await expect(panel.getByRole('tablist', { name: 'Kinds of flows' }).getByRole('tab')).toHaveText([/^All/, /^Pages/, /^Requests/, /^Console/]);
  await expect(panel.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('.rf-row')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Expand all', exact: true }).click();
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
  await panel.getByRole('group', { name: 'Filter by completeness' }).getByRole('button', { name: /Unmatched/ }).click();
  await expect(panel.locator('.rf-row', { hasText: '/nowhere/at/all' })).toBeVisible();
  await expect(panel.locator('.rf-row:not(.s-unmatched)')).toHaveCount(0);
  await panel.getByRole('group', { name: 'Filter by completeness' }).getByRole('button', { name: /Unmatched/ }).click();
  await panel.getByLabel('Filter flows').fill('AuthController::login');
  await panel.locator('.rf-row', { hasText: '/auth/login' }).first().click();
  // On the map, branch by branch: one per place the request is made from, grouped by where that is, each shown wave by wave down to the table.
  const player = page.getByRole('region', { name: 'Flow on the map: POST /auth/login' });
  const branches = player.getByRole('group', { name: 'Branches' });
  await expect(branches.locator('.flow-branch')).toHaveCount(4);
  await expect(branches.locator('.flow-branch-group-label')).toHaveText(['From /account', 'From /login', 'No indexed trigger']);
  await expect(branches.locator('.flow-branch.current')).toContainText('handleSave');
  const waves = player.getByRole('list', { name: 'This branch, wave by wave' });
  await expect(waves.locator('.flow-stop', { hasText: 'handleSave' })).toBeVisible();
  await expect(waves.locator('.flow-stop').filter({ hasText: /^login$/ })).toHaveCount(0);
  await expect(waves.locator('.flow-stop', { hasText: 'users' })).toBeVisible();
  await branches.getByRole('group', { name: 'Made on the page /login' }).locator('.flow-branch').click();
  await expect(branches.locator('.flow-branch.current')).toContainText('login');
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: 'login', exact: true })).toBeVisible();
  await expect(waves.locator('.flow-stop', { hasText: 'handleSave' })).toHaveCount(0);
  await branches.locator('.flow-branch', { hasText: 'handleSave' }).click();
  const users = await idOf(page, 'users', 'database_table');
  await expect.poll(() => page.evaluate(visibleIds), { timeout: 10000 }).toContain(users);
  await player.getByRole('button', { name: 'Pause' }).click();
  await player.locator('.flow-stop', { hasText: 'users' }).click();
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: 'users', exact: true })).toBeVisible();
  // The same flow as lanes, in the middle: one per layer the request passes, in order.
  await player.getByRole('button', { name: 'Lanes' }).click();
  const theater = page.getByRole('region', { name: 'Request flow POST /auth/login' });
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
  // The same flow as an outline of steps.
  await theater.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Outline' }).click();
  await expect(theater.getByRole('list', { name: 'Steps' }).locator('.step-card.kind-handler', { hasText: 'login' }).first()).toBeVisible();
  await theater.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Lanes' }).click();
  // Back on the map; the lanes stay a tab away.
  await theater.getByRole('button', { name: 'Show on map', exact: true }).click();
  await expect(theater).toHaveCount(0);
  await expect(player).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Flow · POST /auth/login' })).toBeVisible();
  await page.getByRole('button', { name: 'Close the flow tab' }).click();
  await expect(page.getByRole('tab', { name: 'Map' })).toHaveCount(0);
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
  const theater = page.getByRole('region', { name: 'Request flow PUT /profiles/{id}' });
  await expect(theater.locator('.rf-node.k-validation', { hasText: 'UpdateProfileRequest' })).toBeVisible();
  await expect(theater.locator('.rf-node.k-response')).toHaveCount(3);
  await expect(theater.locator('.rf-node.k-gap', { hasText: 'record()' })).toBeVisible();
  await theater.getByRole('button', { name: 'Close this flow', exact: true }).click();
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
test('search opens a result as its flow, its steps or its impact; a highlight lists its files', async ({ page }) => {
  await open(page);
  const box = page.getByRole('combobox', { name: 'Search the indexed graph' });
  await box.fill('POST /auth/login');
  const result = page.getByRole('option').filter({ hasText: 'POST /auth/login' }).first();
  await result.hover();
  await expect(result.getByRole('group', { name: /^Open .* as$/ }).getByRole('button')).toHaveText(['On map', 'Lanes', 'What happens', 'Impact']);
  await result.getByRole('button', { name: 'Lanes' }).click();
  const lanes = page.getByRole('region', { name: 'Request flow POST /auth/login' });
  await expect(lanes.locator('.rf-node.k-table', { hasText: 'users' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Flow · POST /auth/login' })).toHaveAttribute('aria-selected', 'true');
  // The keyboard reaches the actions too: Tab from the box, then Enter.
  await box.fill('AuthService::authenticate');
  await expect(page.getByRole('option').first()).toContainText('authenticate');
  await box.press('Tab');
  await expect(page.getByRole('option').first().getByRole('button', { name: 'What happens' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Blast radius' }).locator('h2')).toHaveText('Impact of authenticate');
  // Coverage lists the files of a category, to copy.
  await page.getByRole('tab', { name: 'Map', exact: true }).click();
  await page.getByRole('button', { name: 'Coverage', exact: true }).click();
  await page.getByRole('region', { name: 'Coverage lens' }).getByRole('button', { name: /^In flows/ }).click();
  const files = page.getByRole('region', { name: 'Files lit: Coverage: In flows' });
  await expect(files.locator('.files-file', { hasText: 'AuthService.php' })).toBeVisible();
  await files.getByPlaceholder('Filter by path…').fill('Services');
  await expect(files.getByRole('button', { name: /^Copy \d+ paths$/ })).toBeVisible();
  await files.getByRole('button', { name: 'Close the list of files' }).click();
  await expect(files).toHaveCount(0);
});
test('Dusk is the default theme, Dawn the other; Settings offers the rest', async ({ page }) => {
  await open(page);
  const themes = page.getByRole('combobox', { name: 'Theme' });
  await expect(themes).toHaveValue('codiluce-dusk');
  await expect(themes.locator('option')).toHaveText(['Codiluce Dusk', 'Codiluce Dawn']);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('dialog', { name: 'Settings' }).getByLabel('More themes').check();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Close' }).click();
  await expect(themes.locator('option')).toHaveCount(12);
  await expect(themes.locator('option').nth(2)).toHaveText('Midnight');
});
