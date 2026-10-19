import { test, expect } from '@playwright/test';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';

test('Agents reads searchable history beside the map, expands in place, and reveals tool paths', async ({ page, request }) => {
  expect((await request.get('/api/decisions')).status()).toBe(404);
  expect((await request.post('/api/decisions', { data: {} })).status()).toBe(405);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Decisions', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Conversations', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Agents', exact: true });
  const history = panel.getByRole('region', { name: 'Agent sessions' });
  await history.getByRole('button', { name: 'Import / refresh history' }).click();
  await expect(history.getByText('2 agent sessions', { exact: true })).toBeVisible();
  await history.getByRole('textbox', { name: 'Filter agent sessions by file or folder' }).fill('frontend/src/components/');
  await expect(history.getByRole('combobox', { name: 'File action' })).toHaveCount(0);
  await history.getByRole('combobox', { name: 'Agents filter' }).selectOption('codex');
  await expect(history.getByText('1 agent session', { exact: true })).toBeVisible();
  await history.getByLabel('Search agent sessions', { exact: true }).fill('Markdown');
  await history.getByRole('button', { name: /Preserve readable session history/ }).click();
  const conversation = history.locator('[aria-label="Agent session reader"]');
  await expect(conversation.getByText('Keep session history readable as Markdown, with original messages and tool activity.')).toBeVisible();
  await expect(conversation.getByText('Always show this injected setup marker.', { exact: false })).toHaveCount(0);
  await expect(page.locator('.map-canvas').first()).toBeVisible();
  await expect(conversation.getByRole('checkbox')).toHaveCount(0);
  await expect(conversation.getByText('Login form code.', { exact: true })).not.toBeVisible();
  await panel.getByRole('button', { name: 'Expand Agents', exact: true }).click();
  await expect(history.getByLabel('Search agent sessions', { exact: true })).toHaveValue('Markdown');
  await expect(conversation.getByText('Keep session history readable as Markdown, with original messages and tool activity.')).toBeVisible();
  await expect(page.locator('.map-canvas').first()).not.toBeVisible();
  await conversation.getByText('Files and folders · 1 associations').click();
  await conversation.getByRole('button', { name: 'Show call', exact: true }).click();
  await expect(conversation.getByText('Login form code.', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Dock Agents beside the map' }).click();
  await expect(history.getByLabel('Search agent sessions', { exact: true })).toHaveValue('Markdown');
  await expect(conversation.getByText('Login form code.', { exact: true })).toBeVisible();
  await expect(page.locator('.map-canvas').first()).toBeVisible();
  await conversation.getByRole('button', { name: 'frontend/src/components/LoginForm.tsx', exact: true }).first().click();
  await expect(page.getByRole('complementary', { name: 'Inspector' }).getByRole('heading', { name: 'LoginForm.tsx', exact: true })).toBeVisible();
  await page.getByRole('group', { name: 'Additional columns' }).getByRole('button', { name: 'Code', exact: true }).click();
  const url = page.url();
  await page.goto(url);
  await expect(page.getByRole('complementary', { name: 'Agents', exact: true }).getByLabel('Agent session reader', { exact: true }).getByText('Keep session history readable as Markdown, with original messages and tool activity.')).toBeVisible();
});

test('observed sessions merge with history and live refresh adds messages without moving the reader', async ({ page, request }) => {
  const setup = await (await request.get('/api/explanations/setup')).json();
  await appendFile(path.join(setup.root, '.codiluce/agent-fixtures/codex/sessions/codex-e2e.jsonl'), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Context for the live reader.\n\n'.repeat(100) }] } }) + '\n');
  await request.post('/api/conversations/sync', { headers: { 'X-Codiluce-Request': 'journal' } });
  await request.post('/api/agents/events', { headers: { 'X-Codiluce-Request': 'activity' }, data: { provider: 'codex', payload: { session_id: 'codex-e2e', cwd: setup.root, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'live-read', tool_input: { file_path: 'frontend/src/components/LoginForm.tsx' } } } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Agents', exact: true });
  await expect(panel.getByRole('button', { name: /Preserve readable session history/ })).toHaveCount(1);
  await panel.getByRole('button', { name: /Preserve readable session history/ }).click();
  const reader = panel.locator('[aria-label="Agent session reader"]');
  await expect(reader.getByText('Keep session history readable as Markdown, with original messages and tool activity.')).toBeVisible();
  await expect(reader.getByText('Observed tool activity · 1', { exact: true })).toBeVisible();
  await expect(reader.locator('.activity-feed')).not.toBeVisible();
  await reader.evaluate(element => { element.scrollTop = 40; });
  const position = await reader.evaluate(element => element.scrollTop);
  expect(position).toBeGreaterThan(0);
  await appendFile(path.join(setup.root, '.codiluce/agent-fixtures/codex/sessions/codex-e2e.jsonl'), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'This answer arrived during live refresh.' }] } }) + '\n');
  await expect(reader.getByText('This answer arrived during live refresh.', { exact: true })).toBeVisible({ timeout: 20000 });
  expect(await reader.evaluate(element => element.scrollTop)).toBe(position);
  await panel.getByRole('button', { name: 'Expand Agents', exact: true }).click();
  await expect(panel.getByRole('button', { name: /Preserve readable session history/ })).toHaveCount(1);
});

test('session filters fit one row and live progress replaces the current update with observed files', async ({ page, request }) => {
  const setup = await (await request.get('/api/explanations/setup')).json();
  const file = path.join(setup.root, '.codiluce/agent-fixtures/codex/sessions/codex-e2e.jsonl');
  const progress = (text: string) => JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'assistant', channel: 'commentary', content: [{ type: 'output_text', text }] } }) + '\n';
  await appendFile(file, progress('Checking README and session history.'));
  await request.post('/api/agents/events', { headers: { 'X-Codiluce-Request': 'activity' }, data: { provider: 'codex', payload: { session_id: 'codex-e2e', cwd: setup.root, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'current-files', tool_input: { file_path: 'frontend/src/components/LoginForm.tsx' } } } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Agents', exact: true });
  const active = panel.locator('.agent-session-block.agent-work').filter({ hasText: 'Preserve readable session history' });
  const update = active.getByRole('status', { name: 'Current agent update' });
  await expect(update).toHaveText('Checking README and session history.');
  await expect(update.locator('.agent-dots i')).toHaveCount(6);
  await expect(update.locator('.rf-spark')).toHaveCount(0);
  const menu = page.getByRole('button', { name: 'Agents', exact: true });
  await expect(menu.locator('.agent-dots i')).toHaveCount(6);
  await expect(menu.getByLabel(/agents? running/)).toBeVisible();
  const title = await active.locator('.agent-conversation-title strong').boundingBox();
  const heading = await active.locator('.agent-conversation-title').boundingBox();
  expect(title!.x - heading!.x).toBeLessThanOrEqual(16);
  await expect(active.getByLabel('Current agent files').getByRole('button', { name: 'frontend/src/components/LoginForm.tsx', exact: true })).toBeVisible();
  await appendFile(file, progress('Reviewing the latest agent sessions now.'));
  await expect(update).toHaveText('Reviewing the latest agent sessions now.', { timeout: 8000 });
  await expect(active.getByRole('status', { name: 'Current agent update' })).toHaveCount(1);
  await expect(update).not.toContainText('Checking README');
  const controls = [panel.getByRole('textbox', { name: 'Search agent sessions', exact: true }), panel.getByRole('combobox', { name: 'Agents filter' }), panel.getByRole('textbox', { name: 'Filter agent sessions by file or folder' })];
  for (const width of [1400, 375]) {
    await page.setViewportSize({ width, height: 900 });
    const boxes = await Promise.all(controls.map(control => control.boundingBox()));
    expect(boxes.every(box => box && Math.abs(box.y - boxes[0]!.y) < 2)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await page.getByRole('button', { name: 'Explain', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Explanations' }).locator('.agent-work')).toHaveCount(0);
});

test('cached sessions appear during slow refreshes, survive reloads, and remain usable after a refresh failure', async ({ page, request }) => {
  await request.post('/api/conversations/sync', { headers: { 'X-Codiluce-Request': 'journal' } });
  await page.goto('/#sessions=list');
  const panel = page.getByRole('complementary', { name: 'Agents', exact: true });
  const saved = panel.getByRole('button', { name: /Preserve readable session history/ });
  await expect(saved).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('codiluce:agent-sessions:v1:')))).toBe(true);
  let release!: () => void, failed = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const list = (url: URL) => url.pathname === '/api/conversations';
  await page.route(list, async route => {
    await gate;
    if (failed) { await route.fulfill({ status: 503, json: { error: 'Temporary archive refresh failure' } }); return; }
    const result = await request.get('/api/conversations');
    const value = await result.json();
    value.items.find((item: { id: string }) => item.id === 'codex:codex-e2e').title = 'Updated in the background';
    await route.fulfill({ json: value, headers: { ETag: '"browser-updated"' } });
  });
  await panel.getByRole('button', { name: 'Hide the agents panel' }).click();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(saved).toBeVisible({ timeout: 1000 });
  await expect(panel.getByText('Loading history…')).toHaveCount(0);
  await page.reload();
  await expect(saved).toBeVisible({ timeout: 2000 });
  await expect(panel.getByText('Loading history…')).toHaveCount(0);
  await expect(panel.getByRole('status', { name: '', exact: true }).filter({ hasText: 'Checking for updates…' })).toBeVisible();
  release();
  await expect(panel.getByRole('button', { name: /Updated in the background/ })).toBeVisible();
  failed = true;
  await panel.getByRole('button', { name: 'Hide the agents panel' }).click();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('Temporary archive refresh failure');
  await expect(panel.getByRole('button', { name: /Updated in the background/ })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#sessions=list');
});

test('hidden tabs release their live stream and reconnect with the latest activity when visible', async ({ page }) => {
  await page.addInitScript(() => {
    const Native = window.EventSource, streams: EventSource[] = [];
    (window as unknown as { testStreams: EventSource[] }).testStreams = streams;
    window.EventSource = class extends Native {
      constructor(url: string | URL, options?: EventSourceInit) { super(url, options); streams.push(this); }
    };
  });
  await page.goto('/#conversation=list');
  const panel = page.getByRole('complementary', { name: 'Agents', exact: true });
  await expect(panel.getByText('Live activity', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#sessions=list$/);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await page.evaluate(() => (window as unknown as { testStreams: EventSource[] }).testStreams.every(stream => stream.readyState === EventSource.CLOSED))).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(panel.getByText('Live activity', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { testStreams: EventSource[] }).testStreams.filter(stream => stream.readyState !== EventSource.CLOSED).length)).toBe(1);
});

test('a finished session replays on the map step by step: it pauses, steps back and forth, speeds up and says what the agent does', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  const history = page.getByRole('complementary', { name: 'Agents', exact: true }).getByRole('region', { name: 'Agent sessions' });
  await history.getByRole('button', { name: 'Import / refresh history' }).click();
  // Other tests here keep the Codex session live; the Claude one is finished.
  await history.getByRole('button', { name: /Add a human-readable session viewer/ }).click();
  await history.getByRole('button', { name: '▶ Replay on the map' }).click();
  const bar = page.getByRole('toolbar', { name: 'Session replay' });
  await expect(bar).toContainText('Add a human-readable session viewer');
  await bar.getByRole('button', { name: 'Pause', exact: true }).click();
  await bar.getByRole('slider', { name: 'Replay step' }).fill('0');
  const count = bar.locator('.replay-count'), text = bar.locator('.replay-text');
  // The prompt, the edit, the end.
  await expect(count).toHaveText('1 / 3');
  await expect(text).toHaveText('Thinking');
  await bar.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(count).toHaveText('2 / 3');
  await expect(text).toHaveText(/^Editing frontend\/src\/components\/LoginForm\.tsx/);
  // Paused, it stays on that step.
  const step = await count.innerText();
  await page.waitForTimeout(1500);
  await expect(count).toHaveText(step);
  await bar.getByRole('button', { name: 'Previous step', exact: true }).click();
  await expect(count).toHaveText('1 / 3');
  await bar.getByRole('combobox', { name: 'Replay speed' }).selectOption('8');
  await bar.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(text).toHaveText('Replay over', { timeout: 15_000 });
  await expect(bar.getByRole('button', { name: 'Play again', exact: true })).toBeVisible();
  await bar.getByRole('button', { name: 'Close the replay' }).click();
  await expect(bar).toHaveCount(0);
  await expect(history.getByRole('button', { name: '▶ Replay on the map' })).toBeVisible();
});
