import { expect, test, type Page } from '@playwright/test';

// Flows against the fixture repository served by web/e2e/server.ts: the
// Flows panel, a request shown on the map, its lanes, a step's details, and
// the inspector's way in.
const visibleIds = () => (window as unknown as { __CODILUCE__?: { visibleIds(): string[] } }).__CODILUCE__?.visibleIds() ?? [];
async function open(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => ((window as unknown as { __CODILUCE__?: { visibleIds(): string[] } }).__CODILUCE__?.visibleIds().length ?? 0) > 2);
}
/** Color the map's files by one thing, from the top bar's Color by menu. */
async function colorBy(page: Page, label: string) {
  await page.getByRole('button', { name: /^Color by:/ }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click();
}
async function idOf(page: Page, query: string, type: string): Promise<string> {
  return page.evaluate(async ([q, t]) => (await fetch(`/api/projection/search?q=${encodeURIComponent(q!)}&type=${t}`).then(response => response.json())).items[0].id as string, [query, type]);
}

test('page diagrams group initialization and interactions, then expand only one branch and its effects', async ({ page }) => {
  await open(page);
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill('/account');
  await page.keyboard.press('Enter');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByRole('heading', { name: '/account', exact: true })).toBeVisible();
  await inspector.getByRole('button', { name: 'What happens from here', exact: true }).click();
  const panes = page.getByRole('group', { name: 'Views', exact: true });
  await panes.getByRole('button', { name: 'Diagram', exact: true }).click();
  let flow = page.getByRole('region', { name: 'Diagram of /account', exact: true });
  await expect(flow.getByRole('region', { name: 'Page initialization' })).toBeVisible();
  const interactions = flow.getByRole('region', { name: 'User interactions' });
  await expect(interactions.locator('.page-step-group > summary')).toContainText(['AccountPanel', 'LoginForm']);
  await flow.getByRole('searchbox', { name: 'Filter page branches' }).fill('handleSave');
  await expect(interactions.locator('.page-step-group > summary')).toHaveCount(1);
  await flow.getByRole('searchbox', { name: 'Filter page branches' }).fill('');

  await expect(flow.locator('.steps-box')).toHaveCount(0);
  await interactions.locator('.page-step-group', { hasText: 'AccountPanel' }).locator('summary').click();
  await interactions.getByRole('button', { name: /handleSave/ }).click();
  await expect(flow.locator('.page-step-context')).toContainText('AccountPanel');
  await expect(flow.locator('.page-step-path')).toContainText('/account → AccountPage → AccountPanel → handleSave');
  await expect(flow.locator('.steps-box.kind-trigger')).toHaveCount(1);
  await expect(flow.locator('.steps-box.kind-trigger')).toContainText('handleSave');
  await expect(flow.locator('.steps-box.kind-effect')).toHaveCount(0);
  await flow.getByRole('button', { name: /^Show effects/ }).click();
  await expect(flow.locator('.steps-box.kind-effect').first()).toBeVisible();
  await panes.getByRole('button', { name: 'Outline', exact: true }).click();
  flow = page.getByRole('region', { name: 'Outline of /account', exact: true });
  await expect(flow.locator('.page-step-context')).toContainText('handleSave');
  await expect(flow.locator('.step-card.kind-effect').first()).toBeVisible();
  await flow.getByRole('button', { name: /^Hide effects/ }).click();
  await expect(flow.locator('.step-card.kind-effect')).toHaveCount(0);
  await flow.getByRole('button', { name: '← Page overview', exact: true }).click();
  await expect(flow.getByRole('region', { name: 'User interactions' })).toBeVisible();
});

for (const empty of [true, false]) {
  test(`${empty ? 'empty' : 'populated'} Flows stays responsive through coverage and history`, async ({ page }) => {
    if (empty) await page.route('**/api/projection/flows*', route => route.fulfill({ json: { items: [], counts: { page: 0, request: 0, command: 0, schedule: 0, unmatched: 0 } } }));
    await open(page);
    await page.getByRole('button', { name: 'Flows', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Flows' });
    if (!empty) await panel.getByRole('button', { name: 'Expand all', exact: true }).click();
    const loaded = empty ? panel.getByText('No flows in this scope match these filters.', { exact: true }) : panel.locator('.rf-row').first();
    await expect(loaded).toBeVisible();
    await colorBy(page, 'Flow coverage');
    await expect(page.getByRole('region', { name: 'Coverage lens' })).toBeVisible();
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect(page.getByRole('region', { name: 'History' })).toContainText('History unavailable.');
    await page.getByRole('button', { name: 'Close history', exact: true }).click();
    await expect(page.getByRole('region', { name: 'History' })).toHaveCount(0);
    await expect(loaded).toBeVisible();
    // Reopening the panel reads the cached catalog, which must also settle.
    await page.getByRole('button', { name: 'Hide the flows panel', exact: true }).click();
    await page.getByRole('button', { name: 'Flows', exact: true }).click();
    await expect(loaded).toBeVisible();
    await colorBy(page, 'Type');
    await expect(page.getByRole('region', { name: 'Coverage lens' })).toHaveCount(0);
  });
}

test('one list holds every flow, filtered by channel and evidence; a request is shown on the map, then as lanes', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Flows' });
  await expect(panel.getByRole('tablist', { name: 'Kinds of flows' }).getByRole('tab')).toHaveText([/^All/, /^CLI/, /^HTTP/, /^UI/, /^MCP/, /^Worker/, /^Functions/]);
  await expect(panel.getByRole('tab', { name: /^All/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.locator('.rf-row')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Expand all', exact: true }).click();
  // Pages, requests and the console in one list.
  await expect(panel.locator('.rf-row.k-page', { hasText: '/account' }).first()).toBeVisible();
  await expect(panel.locator('.rf-row.k-request', { hasText: '/auth/login' }).first()).toBeVisible();
  await expect(panel.locator('.rf-row.k-command', { hasText: 'reports:send' })).toBeVisible();
  // Channel and evidence filters are independent, including CLI flows.
  await panel.getByRole('tab', { name: /^CLI/ }).click();
  await expect(panel.locator('.rf-row', { hasText: 'daily at 02:00' })).toBeVisible();
  await expect(panel.locator('.rf-row:not(.k-command):not(.k-schedule)')).toHaveCount(0);
  await expect(panel.getByRole('group', { name: 'Filter by evidence coverage' })).toBeVisible();
  await panel.getByRole('tab', { name: /^UI/ }).click();
  await expect(panel.locator('.rf-row:not(.k-page)')).toHaveCount(0);
  await panel.getByRole('tab', { name: /^All/ }).click();
  // Evidence filters also include unmatched requests.
  await panel.getByRole('group', { name: 'Filter by evidence coverage' }).getByRole('button', { name: /Known gaps/ }).click();
  await expect(panel.locator('.rf-row', { hasText: '/nowhere/at/all' })).toBeVisible();
  await expect(panel.locator('.rf-row', { hasText: 'No known gaps' })).toHaveCount(0);
  await panel.getByRole('group', { name: 'Filter by evidence coverage' }).getByRole('button', { name: /Known gaps/ }).click();
  await panel.getByLabel('Filter flows').fill('AuthController::login');
  await panel.locator('.rf-row', { hasText: '/auth/login' }).first().click();
  // In the middle, side by side: the flow on the map, its lanes and its outline.
  await expect(page.getByRole('tab', { name: 'Flow · POST /auth/login' })).toHaveAttribute('aria-selected', 'true');
  const player = page.getByRole('region', { name: 'Flow on the map: POST /auth/login' });
  const theater = page.getByRole('region', { name: 'Request flow POST /auth/login' });
  const outline = page.getByRole('region', { name: 'Outline of /auth/login' });
  await expect(player).toBeVisible();
  await expect(theater).toBeVisible();
  await expect(outline.getByRole('list', { name: 'Steps' }).locator('.step-card.kind-handler', { hasText: 'login' }).first()).toBeVisible();
  // On the map, every branch at once, or one on its own: one per place the request is made from, grouped by where that is.
  const branches = player.getByRole('group', { name: 'Branches' });
  await expect(branches.locator('.flow-branch:not(.all)')).toHaveCount(4);
  await expect(branches.locator('.flow-branch-group-label')).toHaveText(['From /account', 'From /login', 'No indexed trigger']);
  await expect(branches.getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const users = await idOf(page, 'users', 'database_table');
  await expect.poll(() => page.evaluate(visibleIds), { timeout: 10000 }).toContain(users);
  await branches.getByRole('group', { name: 'Made on the page /login' }).locator('.flow-branch').click();
  await expect(branches.locator('.flow-branch.current')).toContainText('login');
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: 'login', exact: true })).toBeVisible();
  await branches.getByRole('button', { name: 'All', exact: true }).click();
  await expect(branches.locator('.flow-branch.current')).toHaveText('All');
  // No player: nothing to play or pause, the links stream all the time.
  await expect(page.getByRole('button', { name: /^(Play|Pause)/ })).toHaveCount(0);
  // The lanes: one per layer the request passes, in order.
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
  // A step shown on the map from the lanes: selected there.
  await theater.locator('.rf-node.k-table', { hasText: 'users' }).dblclick();
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: 'users', exact: true })).toBeVisible();
  // One view with the whole middle at a time, and back side by side.
  const views = page.getByRole('group', { name: 'Views' });
  await views.getByRole('button', { name: 'Lanes' }).click();
  await expect(player).toBeHidden();
  await expect(outline).toBeHidden();
  await expect(theater.locator('.rf-node.k-table', { hasText: 'users' })).toBeVisible();
  await views.getByRole('button', { name: 'Outline' }).click();
  await expect(outline).toBeVisible();
  await expect(theater).toBeHidden();
  await outline.getByRole('button', { name: 'Put the outline back beside the other views' }).click();
  await expect(player).toBeVisible();
  await expect(theater).toBeVisible();
  // The bar between the map and the lanes moves with the keyboard too.
  const bar = page.getByRole('separator', { name: 'Resize the lanes below the map' });
  const before = Number(await bar.getAttribute('aria-valuenow'));
  await bar.focus();
  await page.keyboard.press('ArrowUp');
  await expect(bar).toHaveAttribute('aria-valuenow', String(before + 3));
  // Closing the tab takes the flow off the map too.
  await page.getByRole('button', { name: 'Close the flow tab' }).click();
  await expect(page.getByRole('tab', { name: 'Map' })).toHaveCount(0);
  await expect(player).toHaveCount(0);
  await expect(theater).toHaveCount(0);
});
test('the inspector shows an endpoint\'s flow on the map, and lists the flows through a table', async ({ page }) => {
  await open(page);
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill('PUT /profiles');
  await page.keyboard.press('Enter');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await inspector.getByRole('button', { name: 'Flow', exact: true }).click();
  const player = page.getByRole('region', { name: 'Flow on the map: PUT /profiles/{id}' });
  await expect(player).toContainText('stops');
  const theater = page.getByRole('region', { name: 'Request flow PUT /profiles/{id}' });
  await expect(theater.locator('.rf-node.k-validation', { hasText: 'UpdateProfileRequest' })).toBeVisible();
  await expect(theater.locator('.rf-node.k-response')).toHaveCount(3);
  await expect(theater.locator('.rf-node.k-gap', { hasText: 'record()' })).toBeVisible();
  await page.getByRole('button', { name: 'Close this flow', exact: true }).click();
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
  await colorBy(page, 'Flow coverage');
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
  await expect(result.getByRole('group', { name: /^Open .* as$/ }).getByRole('button')).toHaveText(['Flow', 'Impact']);
  await result.getByRole('button', { name: 'Flow' }).click();
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
  await colorBy(page, 'Flow coverage');
  await page.getByRole('region', { name: 'Coverage lens' }).getByRole('button', { name: /^In flows/ }).click();
  const files = page.getByRole('region', { name: 'Files lit: Coverage: In flows' });
  await expect(files.locator('.files-file', { hasText: 'AuthService.php' })).toBeVisible();
  await files.getByPlaceholder('Filter by path…').fill('Services');
  await expect(files.getByRole('button', { name: /^Copy \d+ paths$/ })).toBeVisible();
  await files.getByRole('button', { name: 'Close the list of files' }).click();
  await expect(files).toHaveCount(0);
});
test('Settings previews every theme with its palette and typeface, and remembers a choice', async ({ page }) => {
  await open(page);
  await expect(page.locator('.topbar').getByRole('combobox', { name: 'Theme' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const themes = settings.getByRole('radio');
  const dusk = settings.getByRole('radio', { name: 'Codiluce Dusk', exact: true });
  const dawn = settings.getByRole('radio', { name: 'Codiluce Dawn', exact: true });
  await expect(themes).toHaveCount(8);
  await expect(settings.locator('.theme-name')).toHaveText([
    'Codiluce DuskDark · Space Grotesk', 'Codiluce DawnLight · Space Grotesk', 'PhosphorDark · JetBrains Mono',
    'MidnightDark · System', 'PaperLight · System', 'GazetteLight · Fraunces', 'BrutalLight · Archivo', 'NeonDark · Space Grotesk',
  ]);
  await expect(dusk).toBeChecked();
  await expect(settings.getByRole('combobox')).toHaveCount(0);
  await expect(settings.getByLabel('More themes')).toHaveCount(0);
  await expect(settings.locator('.theme-type')).toHaveText(Array(8).fill('A'));
  await expect(settings.locator('.theme-swatch')).toHaveCount(48);
  await expect(settings.locator('.theme-option', { has: page.getByRole('radio', { name: 'Gazette', exact: true }) }).locator('.theme-type')).toHaveCSS('font-family', /Fraunces/);
  await dawn.check();
  await expect(page.locator('.codiluce')).toHaveAttribute('data-theme', 'codiluce-dawn');
  await dawn.press('ArrowDown');
  await expect(settings.getByRole('radio', { name: 'Phosphor', exact: true })).toBeChecked();
  await settings.getByRole('radio', { name: 'Phosphor', exact: true }).press('ArrowDown');
  await expect(settings.getByRole('radio', { name: 'Midnight', exact: true })).toBeChecked();
  await expect(page.locator('.codiluce')).toHaveAttribute('data-theme', 'midnight');
  await settings.getByRole('tab', { name: 'Map', exact: true }).click();
  await expect(settings.getByLabel('Building shapes')).toBeVisible();
  await expect(themes).toHaveCount(0);
  await settings.getByRole('tab', { name: 'Map', exact: true }).press('ArrowLeft');
  await expect(settings.getByRole('tab', { name: 'Appearance', exact: true })).toBeFocused();
  await expect(settings.getByRole('radio', { name: 'Midnight', exact: true })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings.getByRole('radio', { name: 'Midnight', exact: true })).toBeChecked();
  await page.reload();
  await expect(page.locator('.codiluce')).toHaveAttribute('data-theme', 'midnight');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings.getByRole('radio', { name: 'Midnight', exact: true })).toBeChecked();
});
