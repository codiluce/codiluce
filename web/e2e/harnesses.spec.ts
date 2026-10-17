import { expect, test } from '@playwright/test';
import { HARNESSES } from '../../src/harnesses/registry';
import { nativeActivityFixture } from '../../tests/harness-fixtures';

test('twelve harnesses expose distinct sessions, characters and runtime-specific connection files', async ({ page, request }) => {
  test.setTimeout(60000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const setup = await (await request.get('/api/explanations/setup')).json();
  for (const item of HARNESSES) {
    const payload = nativeActivityFixture(item.id, setup.root);
    payload.session_title = `Harness fixture ${item.label}`; payload.title = `Harness fixture ${item.label}`;
    const response = await request.post('/api/agents/events', { headers: { 'X-Codiluce-Request': 'activity' }, data: { provider: item.id, payload } });
    expect(response.status(), item.id).toBe(202);
  }
  await page.goto('/');
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Agents' });
  const filter = panel.getByRole('combobox', { name: 'Agents filter' });
  for (const item of HARNESSES) {
    await filter.selectOption(item.id);
    const row = panel.locator('.agent-session').filter({ hasText: `Harness fixture ${item.label}` });
    await expect(row).toBeVisible(); await row.click();
    await expect(panel.getByText('Observed tool activity · 1', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '← All agent sessions', exact: true }).click();
  }
  await filter.selectOption('');
  await panel.getByRole('button', { name: 'Agent connections' }).click();
  const dialog = page.getByRole('dialog', { name: 'Agent connections', exact: true });
  const chooser = dialog.getByRole('combobox', { name: 'Agent harness', exact: true });
  await expect(chooser.locator('option')).toHaveCount(12);
  for (const item of HARNESSES) {
    await chooser.selectOption(item.id);
    await expect(dialog.getByRole('combobox', { name: 'Harness runtime' }).locator('option')).toHaveCount(item.profiles.length);
    const files = dialog.locator('.agents-setup').first();
    await files.locator('summary').first().click();
    await expect(files).toContainText(`--agent ${item.id}`);
    await expect(files).toContainText('MCP configuration');
  }
  await chooser.selectOption('github-copilot');
  await dialog.getByRole('combobox', { name: 'Harness runtime' }).selectOption('copilot-vscode');
  const details = dialog.locator('.agents-setup').first();
  await details.locator('summary').first().click();
  await expect(details).toContainText('.vscode/mcp.json');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await panel.getByRole('button', { name: 'Watch them at work' }).click();
  await expect(page.getByRole('button', { name: 'Close the agents at work tab' })).toBeVisible();
  expect(errors).toEqual([]);
});
