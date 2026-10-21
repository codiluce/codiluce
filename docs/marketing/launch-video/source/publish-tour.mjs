// Publishes the BookStack tour through Codiluce's MCP server, as Claude Code would.
import { spawn } from 'node:child_process';
const S = process.env.S;
const child = spawn('node', ['--experimental-sqlite', '--import', 'tsx', 'src/cli.ts', 'mcp', '--repo', 'examples/bookstack', '--state-dir', `${S}/state/bookstack`], { cwd: '/var/www/html/codiluce', stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '', id = 0; const waiting = new Map();
child.stdout.on('data', d => { buffer += d; let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { const m = JSON.parse(line); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch {} } });
const call = (method, params) => new Promise(r => { const n = ++id; waiting.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
const tool = async (name, args) => { const r = await call('tools/call', { name, arguments: args }); console.log(name, JSON.stringify(r.result ?? r.error).slice(0, 900)); return r; };
await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const question = 'What happens when someone saves a page?';
await tool('start_explanation', { title: 'Saving a page', question });
const C = 'app/Entities/Controllers/PageController.php', R = 'app/Entities/Repos/PageRepo.php', B = 'app/Entities/Repos/BaseRepo.php', V = 'app/Entities/Repos/RevisionRepo.php', P = 'app/Entities/Tools/PageContent.php', A = 'app/Activity/Tools/ActivityLogger.php';
await tool('publish_explanation', {
  title: 'What happens when someone saves a page', question,
  markdown: 'Saving a page goes through one controller action and one repository method, which does the work: content, fields, a revision and the activity log.',
  scenes: [
    { title: 'Where saving lives', view: 'map',
      markdown: `The request lands in [PageController](${C}). The work happens in [PageRepo](${R}), with [BaseRepo](${B}), [RevisionRepo](${V}), [PageContent](${P}) and [ActivityLogger](${A}).` },
    { title: 'From the request to a revision', view: 'diagram', start: `${C}#update`,
      markdown: `[update](${C}#update) checks the permission and hands the input to [PageRepo.update](${R}#update). It sets the new content through [setNewHTML](${P}#setNewHTML), saves the fields with [BaseRepo.update](${B}#update), stores a revision with [storeNewForPage](${V}#storeNewForPage) and logs it with [add](${A}#add).`,
      arrows: [
        { from: `${C}#update`, to: `${R}#update`, label: 'hands the input to' },
        { from: `${R}#update`, to: `${P}#setNewHTML`, label: 'sets the content' },
        { from: `${R}#update`, to: `${B}#update`, label: 'saves the fields' },
        { from: `${R}#update`, to: `${V}#storeNewForPage`, label: 'stores a revision' },
        { from: `${R}#update`, to: `${A}#add`, label: 'logs PAGE_UPDATE' },
      ] },
  ],
});
child.kill();
