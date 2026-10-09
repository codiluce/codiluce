import { expect, test, type Page } from '@playwright/test';

// Blast radius, Steps, effects and call sites, against the fixture repository
// served by web/e2e/server.ts.
async function open(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => ((window as unknown as { __CODILUCE__?: { visibleIds(): string[] } }).__CODILUCE__?.visibleIds().length ?? 0) > 2);
}
async function search(page: Page, query: string) {
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill(query);
  await page.keyboard.press('Enter');
}
const inspector = (page: Page) => page.getByRole('complementary', { name: 'Inspector' });
async function select(page: Page, query: string, heading: string) {
  await search(page, query);
  await expect(inspector(page).getByRole('heading', { name: heading, exact: true })).toBeVisible();
}

test('Python shows source, declarations and partial import/reference support', async ({ page }) => {
  await open(page);
  await select(page, 'StructurePython', 'StructurePython');
  const coverage = inspector(page).getByRole('region', { name: 'Analysis coverage' });
  await expect(coverage).toContainText('Declarations');
  await expect(coverage).toContainText('Available');
  await expect(coverage.locator('dt').filter({ hasText: /^Imports$/ }).locator('+ dd')).toHaveText('Partial');
  await expect(coverage.locator('dt').filter({ hasText: /^Code connections$/ }).locator('+ dd')).toHaveText('Partial');
  await expect(coverage).not.toContainText('Calls and flows are not measured for this file');
  await coverage.getByText('Limits and findings').click();
  await expect(coverage).toContainText('Lexical declarations, imported members');
  await inspector(page).getByRole('button', { name: 'Open source' }).click();
  const source = page.getByRole('region', { name: 'Source' });
  await expect(source).toContainText('class StructurePython');
  await expect(source).toContainText('é😀');
});

test('structural-only languages show their declarations and analysis limits', async ({ page }) => {
  await open(page);
  await select(page, 'StructureRuby', 'StructureRuby');
  const coverage = inspector(page).getByRole('region', { name: 'Analysis coverage' });
  await expect(coverage.locator('dt').filter({ hasText: /^Declarations$/ }).locator('+ dd')).toHaveText('Available');
  await expect(coverage).toContainText('Calls and flows are not measured for this file');
  await coverage.getByText('Limits and findings').click();
  await expect(coverage).toContainText('extracts declarations only');
});

test('impact shows what depends on a method across the stack, by hops or by application, and survives in the link', async ({ page }) => {
  await open(page);
  await select(page, 'AuthService::authenticate', 'authenticate');
  await inspector(page).getByRole('button', { name: 'Impact', exact: true }).click();
  // In the middle of the screen, with the map as an overview in a corner.
  const section = page.getByRole('region', { name: 'Blast radius' });
  await expect(page.getByRole('tab', { name: 'Impact · authenticate' })).toHaveAttribute('aria-selected', 'true');
  await expect(section.locator('.impact-bars')).toBeVisible();
  await expect(section).toContainText(/Reaches \d+ endpoints\. Affected: \d+ in (backend|frontend), \d+ in (backend|frontend)\./);
  await expect(section).toContainText('Lower bound');
  // Hop counts grow down the list; the frontend method requesting the endpoint is three hops away.
  const row = (name: string) => section.locator('.impact-row').filter({ has: page.locator('.row-title .label', { hasText: new RegExp(`^${name.replace(/[/$]/g, '\\$&')}$`) }) });
  const signIn = row('signIn');
  await expect(signIn.locator('.impact-distance')).toHaveText('3');
  await signIn.getByRole('button', { name: 'Chain' }).click();
  await expect(signIn.locator('.impact-chain li')).toHaveCount(3);
  await signIn.getByRole('button', { name: /^Why does/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Why is this connected?' })).toBeVisible();
  await page.getByRole('button', { name: 'Close evidence' }).click();
  // Selecting what it lists leaves the radius on its origin.
  await signIn.locator('.row-title').click();
  await expect(inspector(page).getByRole('heading', { name: 'signIn', exact: true })).toBeVisible();
  await expect(section.locator('h2')).toHaveText('Impact of authenticate');
  // By application: the frontend lists only its own.
  await section.getByRole('group', { name: 'List by' }).getByRole('button', { name: 'Application' }).click();
  const groups = section.locator('.impact-groups');
  await expect(groups.locator('.tree-label', { hasText: 'frontend' })).toBeVisible();
  await expect(groups.locator('.tree-label', { hasText: 'backend' })).toBeVisible();
  await groups.locator('.tree-label', { hasText: 'frontend' }).click();
  await expect(groups.locator('.impact-row .row-title .label', { hasText: /^signIn$/ })).toBeVisible();
  await expect(groups.locator('.impact-row .row-title .label', { hasText: /AuthController/ })).toHaveCount(0);
  await section.getByRole('group', { name: 'List by' }).getByRole('button', { name: 'Hops' }).click();
  await select(page, 'AuthService::authenticate', 'authenticate');
  await page.getByRole('tab', { name: 'Impact · authenticate' }).click();
  // Deeper walks reach the pages.
  await section.getByLabel('Hops').selectOption('6');
  await expect(row('/account').locator('.impact-distance')).toHaveText('6');
  await expect(section).toContainText(/Reaches \d+ endpoints and 3 pages\./);
  await expect.poll(() => page.url()).toContain('impact=6');
  // The link reopens it.
  await page.reload();
  await expect(row('/account')).toBeVisible();
  await inspector(page).getByRole('button', { name: 'Hide impact' }).click();
  await expect(page.getByRole('region', { name: 'Blast radius' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /^Impact/ })).toHaveCount(0);
  await expect.poll(() => page.url()).not.toContain('impact=');
});
test('impact reports name-only possible callers instead of linking them', async ({ page }) => {
  await open(page);
  await select(page, 'AuditLog::record', 'record');
  await inspector(page).getByRole('button', { name: 'Impact', exact: true }).click();
  const section = page.getByRole('region', { name: 'Blast radius' });
  await expect(section).toContainText('Nothing indexed depends on this');
  await expect(section).toContainText('1 unresolved call site in 1 entity call something named record');
});
test('steps draw what happens from a page, with events, conditions, endpoints and effects', async ({ page }) => {
  await open(page);
  await select(page, '/account', '/account');
  await inspector(page).getByRole('button', { name: 'What happens from here' }).click();
  // In the middle of the screen, as an outline.
  const panel = page.getByRole('region', { name: 'What happens from /account' });
  const outline = panel.getByRole('list', { name: 'Steps' });
  await expect(outline).toBeVisible();
  await expect(outline.locator('.step-card.kind-trigger', { hasText: 'handleSave' })).toBeVisible();
  await expect(outline).toContainText('on onClick');
  await expect(outline).toContainText('when email');
  await expect(outline.locator('.step-card.kind-endpoint', { hasText: 'POST /auth/login' }).first()).toContainText('backend');
  await expect(outline.locator('.step-card.kind-effect', { hasText: 'response · abort · 404' })).toContainText('when $id < 1');
  await expect(outline.locator('.step-card.kind-effect', { hasText: 'database · read' }).first()).toBeVisible();
  // Each link is a chain of indexed relationships with evidence.
  const link = outline.locator('.steps-link', { hasText: 'when email' }).filter({ has: page.getByRole('button', { name: /hop/ }) }).first();
  await link.getByRole('button', { name: /hop/ }).click();
  // Expanded, its hops each have Why?
  await outline.locator('.steps-link', { hasText: 'when email' }).getByRole('button', { name: 'Why?' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Why is this connected?' })).toContainText('frontend/src/components/AccountPanel.tsx');
  await page.getByRole('button', { name: 'Close evidence' }).click();
  // Clicking a step selects it on the map.
  await outline.locator('.step-card', { hasText: 'signIn' }).first().getByRole('button').first().click();
  await expect(inspector(page).getByRole('heading', { name: 'signIn', exact: true })).toBeVisible();
  // The diagram lays out the same steps.
  await panel.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Diagram' }).click();
  await expect(panel.locator('.steps-box').first()).toBeVisible();
  expect(await panel.locator('.steps-box').count()).toBeGreaterThan(8);
  await panel.getByRole('button', { name: 'Close this flow' }).click();
  await expect(page.getByRole('region', { name: 'What happens from /account' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Map' })).toHaveCount(0);
});
test('effects and call sites explain what a symbol does and what could not be resolved', async ({ page }) => {
  await open(page);
  await select(page, 'ProfileController::update', 'update');
  for (const text of ['response · validation · 422', 'database · read', 'response · not found · 404', 'database · write', 'response · redirect · 302']) await expect(inspector(page).locator('.effect-row', { hasText: text }).first()).toBeVisible();
  await select(page, 'ProfileController::audit', 'audit');
  await expect(inspector(page)).toContainText('Call sites');
  await expect(inspector(page)).toContainText('record');
  // Source markers jump to what a line calls.
  await select(page, 'handleSave', 'handleSave');
  await expect(inspector(page).locator('.relation-phrase', { hasText: 'calls' }).first()).toBeVisible();
  await inspector(page).getByRole('button', { name: 'Open source' }).click();
  const source = page.getByRole('region', { name: 'Source' });
  await expect(source.locator('.call-mark').first()).toBeVisible();
  await source.locator('tr[data-line="9"] .call-mark').click();
  await expect(inspector(page).getByRole('heading', { name: /^(getInstance|signIn)$/ })).toBeVisible();
});
