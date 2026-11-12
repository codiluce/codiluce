import { expect, test } from '@playwright/test';

const column = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'Explanations' });
const inspector = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'Inspector' });
const selected = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: 'Canonical location of the selection' }).locator('[aria-current="true"]');
const rail = (page: import('@playwright/test').Page, name: string) => page.locator('.rail').getByRole('button', { name, exact: true });

test('explanations recognizes configured agents before any explanation has been saved', async ({ page }) => {
  await page.route('**/api/explanations', route => route.fulfill({ json: { items: [], version: 'empty' } }));
  await page.route('**/api/explanations/agents', route => route.fulfill({ json: { items: [
    { id: 'claude', name: 'Claude Code', connected: true }, { id: 'codex', name: 'Codex', connected: true }, { id: 'cursor', name: 'Cursor', connected: true },
  ] } }));
  await page.goto('/#explain=list');
  await expect(column(page).getByRole('heading', { name: 'Your agents' })).toBeVisible();
  await expect(column(page).getByRole('status').filter({ hasText: 'Claude Code, Codex and Cursor are connected' })).toBeVisible();
  await expect(column(page).locator('.connect .command-row code')).toHaveCount(0);
  await expect(column(page).getByText('Cursor and other MCP clients (mcp.json)', { exact: true })).toHaveCount(0);
});

test('explanations retries failed connection detection without treating configured agents as disconnected', async ({ page }) => {
  let unavailable = true;
  await page.route('**/api/explanations', route => route.fulfill({ json: { items: [], version: 'empty' } }));
  await page.route('**/api/explanations/agents', route => unavailable ? route.abort('connectionrefused') : route.fulfill({ json: { items: [{ id: 'codex', name: 'Codex', connected: true }] } }));
  await page.goto('/#explain=list');
  await expect(column(page).getByText('Could not check agent connections.', { exact: false })).toBeVisible();
  await expect(column(page).locator('.connect .command-row code')).toHaveCount(0);
  unavailable = false;
  await column(page).getByRole('button', { name: 'Retry connection check' }).click();
  await expect(column(page).getByRole('status').filter({ hasText: 'Codex is connected' })).toBeVisible();
  await expect(column(page).getByText('Codex, in a terminal:', { exact: true })).toHaveCount(0);
});

test('explanations: the column lists what agents saved; links open code, missing ones say why', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Explain/ }).click();
  await expect(column(page).getByRole('button', { name: /How login works/ })).toBeVisible();
  await column(page).getByRole('button', { name: /How login works/ }).click();
  await expect(column(page).getByRole('heading', { name: 'How login works' })).toBeVisible();
  await expect(column(page)).toContainText('How does login work?');
  await expect(column(page).locator('.explain-answer .xlink.missing')).toHaveAttribute('title', /Not in the index/);
  await expect(page).toHaveURL(/#.*explain=2026-10-14-how-login-works-e2e0/);
  // Clicking a link selects what it names; the column stays on the explanation.
  await column(page).getByRole('link', { name: 'login', exact: true }).click();
  await expect(selected(page)).toHaveText('login');
  await expect(column(page).getByRole('heading', { name: 'How login works' })).toBeVisible();
  // Code follows it.
  await rail(page, 'Code').click();
  await expect(page.getByRole('region', { name: 'Code of login' })).toBeVisible();
  await rail(page, 'Selection').click();
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
test('explanations: a template fills the question, Tab moves between its placeholders, and the inspector offers them for the selection', async ({ page }) => {
  await page.goto('/#explain=list');
  const question = column(page).getByRole('textbox', { name: 'Question' });
  const button = column(page).getByRole('button', { name: 'Templates', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Start from a template' });
  const note = column(page).locator('.template-note');
  // While the box is empty, Templates is the primary action, and a few are offered above it.
  await expect(button).toHaveClass(/primary/);
  await column(page).getByRole('group', { name: 'Start from a template' }).getByRole('button', { name: 'Security review' }).click();
  await expect(question).toHaveValue(/^Review \[file, folder or flow\] for security issues/);
  await expect(button).not.toHaveClass(/primary/);
  // The dialog: categories, then a card per template.
  await button.click();
  await dialog.getByRole('button', { name: /^Risks/ }).click();
  await expect(dialog.locator('.template-card')).toHaveCount(5);
  await dialog.getByRole('button', { name: /Track down a bug/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(question).toHaveValue(/^Something goes wrong: \[symptom, e\.g\. the order total is wrong after a refund\]\. Where/);
  await expect(note).toContainText('[symptom, e.g. the order total is wrong after a refund]');
  // The placeholder is selected: typing replaces it.
  await page.keyboard.type('logins fail');
  await expect(question).toHaveValue(/^Something goes wrong: logins fail\. Where/);
  await expect(note).toHaveCount(0);
  // "/" in an empty box opens them; Enter takes the first match.
  await question.fill('');
  await question.press('/');
  await expect(dialog).toBeVisible();
  await page.keyboard.type('two parts');
  await expect(dialog.locator('.template-card')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(question).toHaveValue(/^How is \[first part\] connected to \[second part\]\?/);
  await expect(note).toContainText('[first part] and 1 more');
  await page.keyboard.type('the login form');
  await question.press('Tab');
  // @ fills a placeholder with code from the index, and attaches it.
  await page.keyboard.type('@AuthCon');
  await column(page).getByRole('listbox', { name: 'Attach' }).getByRole('option').first().click();
  await expect(question).toHaveValue(/^How is the login form connected to AuthController\S*\?/);
  await expect(column(page).locator('.context-chip')).toHaveCount(1);
  await expect(note).toHaveCount(0);
  // The inspector's ⋯ asks the templates that suit the selection about it.
  await page.goto('/#explain=2026-10-14-how-login-works-e2e0');
  await page.reload();
  await column(page).getByRole('link', { name: 'login', exact: true }).click();
  await rail(page, 'Selection').click();
  await inspector(page).getByRole('button', { name: '⋯' }).click();
  await inspector(page).getByRole('menuitem', { name: 'Look for bugs in it' }).click();
  await expect(question).toHaveValue(/^Look for likely bugs in login: unhandled errors/);
  await expect(column(page).locator('.context-chip')).toHaveText(/login/);
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
  // Showing Agents in the column must leave this tour on stage; Explain brings the explanation back.
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(bar).toBeVisible();
  await rail(page, 'Explain').click();
  // Explain puts the cursor in its question box, where the arrows move the cursor: out of it, they step the tour.
  await column(page).getByRole('textbox', { name: 'Question' }).blur();
  // The diagram scene stays on the map by default, its files numbered where they are and its arrows drawn between them.
  await page.keyboard.press('ArrowRight');
  await expect(bar).toContainText('2 / 2');
  await expect(page).toHaveURL(/scene=2/);
  const diagram = page.getByRole('figure', { name: 'How the form reaches the server' });
  const asDiagram = bar.getByRole('button', { name: 'Diagram', exact: true });
  await expect(asDiagram).toHaveAttribute('aria-pressed', 'false');
  await expect(diagram).toHaveCount(0);
  // As a diagram: boxes rise off the map, the method sits in its file's box, and the evidenced arrow carries its chip.
  await asDiagram.click();
  await expect(asDiagram).toHaveAttribute('aria-pressed', 'true');
  await expect(diagram.locator('.cd-box')).toHaveCount(3);
  await expect(diagram.locator('.cd-part')).toContainText('login');
  await expect(diagram.locator('.cd-arrow-label', { hasText: 'asks' }).locator('.cd-chip').first()).toContainText('calls');
  await expect(column(page).locator('.scene-section.current')).toContainText('How the form reaches the server');
  // A box selects what it names while the tour stays on stage; a section's title puts its scene back.
  await diagram.getByRole('button', { name: /AuthService/ }).click();
  await expect(selected(page)).toHaveText('AuthService.php');
  await expect(bar).toBeVisible();
  await column(page).getByRole('button', { name: /Where login lives/ }).click();
  await expect(bar).toContainText('1 / 2');
  await expect(diagram).toHaveCount(0);
  await bar.getByRole('button', { name: 'Stop the tour' }).click();
  await expect(bar).toHaveCount(0);
  await expect(column(page).getByRole('button', { name: /Play the tour/ })).toBeVisible();
});
