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
test('explanations: an agent at work shows on the button and in the column before it saves anything', async ({ page }) => {
  const now = new Date().toISOString();
  const work = { startedAt: now, updatedAt: now, title: 'How login works', question: 'How does login work?', steps: [{ text: 'flow flow:POST /auth/login', at: now }], count: 1 };
  let items: unknown[] = [{ session: '1-abc', agent: 'claude-code', state: 'working', connectedAt: now, updatedAt: now, work }];
  await page.route('**/api/explanations/activity', route => route.fulfill({ json: { items } }));
  await page.goto('/');
  const button = page.getByRole('button', { name: /^Explain/ });
  await expect(button).toHaveClass(/working/);
  await expect(button).toHaveAttribute('title', /^Claude Code is working on an explanation/);
  await button.click();
  const card = column(page).getByRole('region', { name: 'Claude Code is working' });
  await expect(card).toContainText('Claude Code is explaining');
  await expect(card).toContainText('How does login work?');
  await expect(card).toContainText('flow flow:POST /auth/login');
  // Reading another explanation, a line says it is still working.
  await column(page).getByRole('button', { name: /How login works/ }).click();
  await expect(column(page).getByRole('status').filter({ hasText: 'Claude Code is explaining: How login works' })).toBeVisible();
  await column(page).getByRole('button', { name: 'Show' }).click();
  await card.getByRole('button', { name: 'Hide' }).click();
  await expect(card).toHaveCount(0);
  // Its work ended (it published, or stopped): the button stops pulsing.
  items = [{ session: '1-abc', agent: 'claude-code', state: 'connected', connectedAt: now, updatedAt: now }];
  await expect(button).not.toHaveClass(/working/);
});

test('explanations: a tour plays in the middle, scene by scene, with the column in step', async ({ page }) => {
  await page.goto('/#explain=2026-10-16-login-in-scenes-e2e1');
  const bar = page.getByRole('toolbar', { name: 'Tour' });
  await expect(bar).toContainText('1 / 2');
  await expect(bar).toContainText('Where login lives');
  await expect(page.getByRole('tab', { name: /Tour · Login in scenes/ })).toBeVisible();
  await expect(column(page).locator('.scene-section.current')).toContainText('Where login lives');
  // The diagram scene: boxes rise off the map, the method sits in its file's box, and the evidenced arrow carries its chip.
  await page.keyboard.press('ArrowRight');
  await expect(bar).toContainText('2 / 2');
  await expect(page).toHaveURL(/scene=2/);
  const diagram = page.getByRole('figure', { name: 'How the form reaches the server' });
  await expect(diagram.locator('.cd-box')).toHaveCount(3);
  await expect(diagram.locator('.cd-part')).toContainText('login');
  await expect(diagram.locator('.cd-arrow-label', { hasText: 'asks' }).locator('.cd-chip').first()).toContainText('calls');
  await expect(column(page).locator('.scene-section.current')).toContainText('How the form reaches the server');
  // A box opens its code while the tour stays on stage; a section's title puts its scene back.
  await diagram.getByRole('button', { name: /AuthService/ }).click();
  await expect(inspector(page).getByRole('heading', { name: 'AuthService.php' })).toBeVisible();
  await expect(bar).toBeVisible();
  await column(page).getByRole('button', { name: /Where login lives/ }).click();
  await expect(bar).toContainText('1 / 2');
  await expect(diagram).toHaveCount(0);
  await bar.getByRole('button', { name: 'Stop the tour' }).click();
  await expect(bar).toHaveCount(0);
  await expect(column(page).getByRole('button', { name: /Play the tour/ })).toBeVisible();
});
