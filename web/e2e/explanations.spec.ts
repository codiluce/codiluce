import { expect, test } from '@playwright/test';

const column = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'Explanations' });
const inspector = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'Inspector' });

test('explanations: the column lists what agents saved; links open code, missing ones say why', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Explain/ }).click();
  await expect(column(page).getByRole('button', { name: /How login works/ })).toBeVisible();
  await column(page).getByRole('button', { name: /How login works/ }).click();
  await expect(column(page).getByRole('heading', { name: 'How login works' })).toBeVisible();
  await expect(column(page)).toContainText('How does login work?');
  await expect(column(page).locator('.explain-answer .xlink.missing')).toHaveAttribute('title', /Not in the index/);
  await expect(page).toHaveURL(/#.*explain=2026-10-14-how-login-works-e2e0/);
  // Clicking a link selects what it names and opens its code.
  await column(page).getByRole('link', { name: 'login', exact: true }).click();
  await expect(inspector(page).getByRole('heading', { name: 'login' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Code' })).toBeVisible();
  // The inspector lists the explanations that link the selection, and offers to explain it.
  await expect(inspector(page)).toContainText('Explained in');
  await expect(inspector(page).getByRole('button', { name: /Explain this method/ })).toBeVisible();
  await expect(inspector(page).getByRole('button', { name: 'Copy prompt' }).first()).toBeVisible();
});
test('explanations: asking without a key says where the key goes, and the question can be copied for an agent', async ({ page }) => {
  await page.goto('/#explain=list');
  await expect(column(page)).toContainText(/ANTHROPIC_API_KEY or OPENAI_API_KEY/);
  await column(page).getByRole('textbox', { name: 'Question' }).fill('What calls @Login');
  await expect(column(page).getByRole('listbox', { name: 'Attach' })).toBeVisible();
  await column(page).getByRole('option').first().click();
  await expect(column(page).locator('.context-chip')).toHaveCount(1);
  await expect(column(page).getByRole('button', { name: 'Copy for agent' })).toBeVisible();
});
