import { expect, test } from '@playwright/test';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

test('Agents streams both providers, selects observed code, scopes searches and offers connection setup', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Agents' });
  await expect(panel.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  await expect(panel.getByText('Live activity', { exact: true })).toBeVisible();
  const setup = await (await request.get('/api/explanations/setup')).json();
  const send = async (provider: string, tool: string, input: unknown, phase = 'PreToolUse') => {
    const response = await request.post('/api/agents/events', { headers: { 'X-Codiluce-Request': 'activity' }, data: { provider, payload: { session_id: `e2e-${provider}`, cwd: setup.root, hook_event_name: phase, tool_name: tool, tool_use_id: `${provider}-${tool}`, tool_input: input, session_title: provider === 'codex' ? 'Investigate login' : 'Update login form' } } });
    expect(response.status()).toBe(202);
  };
  await send('codex', 'Bash', { command: "head -n 80 frontend/src/components/LoginForm.tsx && sed -n '1,40p' frontend/src/components/AccountPanel.tsx" });
  await send('claude-code', 'Edit', { file_path: 'frontend/src/components/LoginForm.tsx' });
  await send('codex', 'Bash', { command: 'rg -n login frontend/src/components' });
  await expect(panel.locator('.agent-session')).toHaveCount(2);
  await expect(panel.locator('.agent-session')).toContainText(['Investigate login', 'Update login form']);
  await expect(panel).not.toContainText('Filesystem:');
  await expect(panel.getByText('Observed actions from connected coding harnesses.', { exact: false })).not.toBeVisible();
  await panel.getByLabel('About agent activity').click();
  await expect(panel.getByText('Observed actions from connected coding harnesses.', { exact: false })).toBeVisible();
  await panel.getByLabel('About agent activity').press('Escape');
  await expect(page.getByRole('button', { name: 'Agents', exact: true }).locator('.badge')).toHaveText('2');
  await panel.getByRole('button', { name: /Investigate login/ }).click();
  await panel.getByText('Observed tool activity · 2', { exact: true }).click();
  await expect(panel.locator('.activity-feed')).toContainText('Read file');
  await expect(panel.locator('.activity-feed').getByRole('button', { name: 'frontend/src/components/AccountPanel.tsx', exact: true })).toBeVisible();
  await expect(panel.locator('.activity-feed')).not.toContainText('Edit file');
  await expect(panel.locator('.activity-query')).toContainText('login');
  await expect(panel.locator('.activity-feed').getByRole('button', { name: 'frontend/src/components/', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'frontend/src/components/LoginForm.tsx', exact: true }).first().click();
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: 'LoginForm.tsx', exact: true })).toBeVisible();
  // Each session wears its color in the list, as its character does on the map; a running session is not replayed.
  await expect(panel.locator('.agent-session .agent-swatch')).toHaveCount(2);
  await expect(panel.getByRole('button', { name: '▶ Replay on the map' })).toHaveCount(0);
  await panel.getByRole('checkbox', { name: 'Show agents on the map' }).uncheck();
  await expect(panel.getByRole('checkbox', { name: 'Show agents on the map' })).not.toBeChecked();
  await panel.getByRole('checkbox', { name: 'Show agents on the map' }).check();
  await panel.getByRole('button', { name: 'Agent connections' }).click();
  const dialog = page.getByRole('dialog', { name: 'Agent connections', exact: true });
  await expect(dialog).toContainText('Hook delivery confirmed');
  await dialog.getByText('View or update hook configuration', { exact: true }).click();
  await dialog.getByText('Activity hooks ·', { exact: false }).click();
  await expect(dialog.locator('.agents-config').last()).toContainText('PreToolUse');
  await expect(dialog.locator('.agents-config').last()).toContainText('hook-cli.ts');
  await dialog.getByRole('combobox', { name: 'Agent harness', exact: true }).selectOption('claude-code');
  await dialog.getByText('View or update hook configuration', { exact: true }).click();
  await dialog.getByText('Activity hooks ·', { exact: false }).click();
  await expect(dialog.locator('.agents-config').last()).toContainText('PostToolUseFailure');
  await dialog.getByRole('button', { name: 'Close agent connections' }).press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(panel.getByRole('button', { name: 'Agent connections' })).toBeFocused();
});

test('Agents and the other header tools remain reachable on smaller screens', async ({ page }) => {
  await page.goto('/');
  for (const width of [1280, 800, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole('button', { name: 'Agents', exact: true })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
});


test('an observed file added after indexing is revealed as a file instead of selecting its folder', async ({ page, request }) => {
  const setup = await (await request.get('/api/explanations/setup')).json();
  const relative = 'frontend/src/components/ObservedNewFile.tsx';
  await writeFile(path.join(setup.root, relative), 'export function ObservedNewFile() { return <div>New</div>; }');
  try {
    const response = await request.post('/api/agents/events', { headers: { 'X-Codiluce-Request': 'activity' }, data: { provider: 'codex', payload: { session_id: 'e2e-new-file', cwd: setup.root, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: relative } } } });
    expect(response.status()).toBe(202);
    await page.goto('/');
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Agents' });
    await panel.getByRole('button', { name: /Codex session/ }).click();
    await panel.getByText('Observed tool activity · 1', { exact: true }).click();
    await panel.getByRole('button', { name: relative + ' · reveal file', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: 'ObservedNewFile.tsx', exact: true })).toBeVisible({ timeout: 25000 });
    await expect(panel.locator('.activity-feed').getByRole('button', { name: relative, exact: true })).toBeVisible();
    const events = await (await request.get('/api/agents')).json();
    const observed = events.events.find((event: { sessionId: string }) => event.sessionId === 'e2e-new-file');
    expect(observed.paths[0].exact).toBe(true);
    expect(observed.paths[0].id).toMatch(/^file:/);
  } finally { await unlink(path.join(setup.root, relative)); }
});
