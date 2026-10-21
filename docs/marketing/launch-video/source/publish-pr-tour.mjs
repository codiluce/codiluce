// Publishes the storefront's explanation of pull request #2841 through Codiluce's MCP server, as Claude Code would.
import { spawn } from 'node:child_process';
const S = process.env.S;
const child = spawn('node', ['--experimental-sqlite', '--import', 'tsx', 'src/cli.ts', 'mcp', '--repo', `${S}/demo/storefront`, '--state-dir', `${S}/state/storefront`], { cwd: '/var/www/html/codiluce', stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '', id = 0; const waiting = new Map();
child.stdout.on('data', d => { buffer += d; let i; while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { const m = JSON.parse(line); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch {} } });
const call = (method, params) => new Promise(r => { const n = ++id; waiting.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
const tool = async (name, args) => { const r = await call('tools/call', { name, arguments: args }); console.log(name, JSON.stringify(r.result ?? r.error).slice(0, 1400)); return r; };
await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
const question = 'Explain pull request #2841: what it changes, in the order a reviewer should read it.';
await tool('start_explanation', { title: 'Pull request #2841', question });
const F = 'web/src/components/checkout/CheckoutForm.tsx', O = 'web/src/lib/api/orders.ts', K = 'api/app/Http/Controllers/OrderController.php',
  C = 'api/app/Services/Checkout/CheckoutService.php', P = 'api/app/Services/Checkout/PricingService.php', M = 'api/app/Models/Order.php',
  R = 'api/routes/api.php', T = 'api/app/Services/Checkout/TaxCalculator.php';
await tool('publish_explanation', {
  title: 'What pull request #2841 changes', question,
  markdown: `#2841 adds coupons and gift cards to checkout. Read it in the order an order is placed: the form sends a code, the checkout prices it, the order stores it. The new pieces (CouponService, GiftCardService, three tables) are in folders the map already has.`,
  scenes: [
    { title: 'What it touches', view: 'map',
      markdown: `The heart of it is [CheckoutService](${C}) and [PricingService](${P}): the discount comes off before tax. [the API routes](${R}) gain two endpoints, [CheckoutForm](${F}) gains the two fields, [Order](${M}) three columns.` },
    { title: 'How a coupon reaches the total', view: 'diagram', start: `${F}#CheckoutForm`,
      markdown: `[CheckoutForm](${F}#CheckoutForm) now sends the coupon with [placeOrder](${O}#placeOrder) to [store](${K}#store). [placeOrder](${C}#placeOrder) asks the new CouponService for the discount, [totals](${P}#totals) takes it off before tax, and the [Order](${M}) keeps discount_cents.`,
      arrows: [
        { from: `${F}#CheckoutForm`, to: `${O}#placeOrder`, label: 'sends the coupon' },
        { from: `${O}#placeOrder`, to: `${K}#store`, label: 'POST /api/orders' },
        { from: `${K}#store`, to: `${C}#placeOrder`, label: 'hands it to' },
        { from: `${C}#placeOrder`, to: `${P}#totals`, label: 'discount before tax' },
        { from: `${C}#placeOrder`, to: M, label: 'stores discount_cents' },
      ] },
  ],
});
child.kill();
