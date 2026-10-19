import { expect, test, type Page } from '@playwright/test';

// A first visit: nothing remembered in this browser.
test.use({ storageState: { cookies: [], origins: [] } });
const card = (page: Page) => page.getByRole('dialog', { name: /./ }).filter({ has: page.getByRole('button', { name: 'End the tour' }) });
const next = (page: Page) => card(page).getByRole('button', { name: 'Next', exact: true });

test('a first visit offers the tour, which follows one file through the map with the lit controls, and puts everything back', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const { counts, thread } = await (await page.request.get('/api/projection/onboarding')).json();
  const file = thread.file.name, flow = thread.flow.name;
  const welcome = page.getByRole('dialog', { name: 'Codiluce lit up fixture' });
  await expect(welcome).toContainText(`${counts.files} files and ${counts.flows} flows.`);
  await welcome.getByRole('button', { name: 'Take the 2-minute tour' }).click();
  await expect(welcome).toHaveCount(0);
  // The map: Next steps into the thread's folder.
  await expect(card(page)).toContainText('1 of 6');
  await expect(card(page)).toContainText('This is fixture');
  await next(page).click();
  await expect(card(page)).toContainText(`${thread.folder.name} holds ${thread.folder.files} files of the ${counts.files}`);
  await next(page).click();
  // Search: pressing / is what it asks; the box then shows the file.
  await expect(card(page)).toContainText('Press /');
  await page.keyboard.press('/');
  await expect(page.getByRole('combobox', { name: 'Search the indexed graph' })).toHaveValue(file);
  await expect(card(page)).toContainText(`There is ${file}`);
  await next(page).click();
  // Code: the file is selected; clicking the lit Code button opens it, as Next would.
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: file, exact: true })).toBeVisible();
  await expect(page.locator('.onboarding-ring')).toBeVisible();
  await page.locator('.topbar').getByRole('button', { name: 'Code', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Code' })).toBeVisible();
  await expect(card(page)).toContainText('follows what you select');
  await next(page).click();
  // Flows: its flow opens in the middle.
  await page.locator('.topbar').getByRole('button', { name: 'Flows', exact: true }).click();
  await expect(card(page)).toContainText(`It is part of ${flow}`);
  await expect(page.getByRole('tab', { name: `Flow · ${flow}` })).toBeVisible();
  // Impact, with the arrow keys.
  await page.keyboard.press('ArrowRight');
  await expect(card(page)).toContainText(`What would a change to ${file} affect?`);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('region', { name: 'Blast radius' })).toBeVisible();
  await expect(card(page)).toContainText('Uncommitted changes');
  await page.keyboard.press('ArrowRight');
  // No Git history in this fixture: the stop says why.
  await expect(card(page)).toContainText('6 of 6');
  await expect(card(page)).toContainText('History reads the repository');
  await next(page).click();
  await expect(card(page)).toContainText('That was the tour');
  await expect(card(page).getByRole('button', { name: 'Show me Agents' })).toBeVisible();
  await card(page).getByRole('button', { name: 'How to turn it on' }).first().click();
  await expect(card(page)).toContainText('Git history');
  await card(page).getByRole('button', { name: 'Done', exact: true }).click();
  // Everything as before the tour.
  await expect(card(page)).toHaveCount(0);
  await expect(page.locator('.onboarding-ring')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Code' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /Flow ·/ })).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Flows' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Search the indexed graph' })).toHaveValue('');
  // Not offered again.
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Search the indexed graph' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Codiluce lit up fixture' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('Not now answers the welcome card; Help takes the tour again, and Esc ends it where it is', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('dialog', { name: 'Codiluce lit up fixture' }).getByRole('button', { name: 'Not now' }).click();
  await page.getByRole('combobox', { name: 'Search the indexed graph' }).fill('authenticate');
  await page.keyboard.press('Enter');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector.getByRole('heading', { name: 'authenticate', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Help' }).getByRole('menuitem')).toHaveText([/^Take the tour/, /^People & PRs/, /^Agents/, /^Explain/, /^Features/, /^Color by/, /^Settings/, /^Keyboard and pointer/]);
  await page.getByRole('menuitem', { name: /^Take the tour/ }).click();
  await next(page).click(); await next(page).click(); await next(page).click(); await next(page).click();
  const { thread } = await (await page.request.get('/api/projection/onboarding')).json();
  await expect(inspector.getByRole('heading', { name: thread.file.name, exact: true })).toBeVisible();
  await page.locator('.onboarding-card').getByRole('button', { name: 'Back' }).focus();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  await expect(inspector.getByRole('heading', { name: 'authenticate', exact: true })).toBeVisible();
  // The keyboard dialog is still there.
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Keyboard and pointer/ }).click();
  await expect(page.getByRole('dialog', { name: 'Keyboard and pointer' })).toBeVisible();
});

test('?tour=settings starts a chapter: the lit ⚙ opens Settings, whose Esc comes first', async ({ page }) => {
  await page.goto('/?tour=settings');
  await expect(card(page)).toContainText('Click ⚙');
  await expect(page).toHaveURL(/\/$|\/#/);
  await expect(page.getByRole('dialog', { name: 'Codiluce lit up fixture' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await expect(card(page)).toHaveAccessibleName('Tour: Settings');
  await expect(card(page)).toContainText('Themes (Dusk and Dawn first');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
  await expect(card(page)).toBeVisible();
  await next(page).click();
  await expect(card(page)).toContainText('Settings: done');
  await card(page).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(card(page)).toHaveCount(0);
});

test('with Git history the History stop opens the timeline on the file', async ({ page }) => {
  const base = `http://127.0.0.1:${process.env.E2E_HISTORY_PORT ?? 4398}`;
  await page.goto(`${base}/?tour`);
  await expect(card(page)).toContainText('1 of 6');
  // Next, beat after beat (a stop with nothing to show here has one), up to the last stop.
  while (!(await card(page).textContent())?.includes('6 of 6')) {
    await expect(next(page)).toBeEnabled();
    await next(page).click();
  }
  await expect(card(page)).toContainText('How did it get here?');
  await next(page).click();
  await expect(page.getByRole('region', { name: 'History' })).toContainText('Git file evolution');
  await expect(card(page)).toContainText(/changed in \d+ commits?/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'History' })).toHaveCount(0);
});
