// Archetypes (projection/archetypes.ts): the map shape of each entity and
// file, from the index first and conventions after, each with its reason.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectionIndex, type EntityRow } from '../src/projection/hierarchy.js';
import { computeArchetypeCounts, computeArchetypes } from '../src/projection/archetypes.js';

/** A Laravel API and a Next.js frontend, with the entities their analyzers index. */
function repository() {
  const rows: EntityRow[] = [{ id: 'r', type: 'repository', name: 'r' }, { id: 'api', type: 'application', name: 'api', parentId: 'r' }, { id: 'web', type: 'application', name: 'web', parentId: 'r' }];
  const file = (path: string, language: string, app = path.startsWith('web/') ? 'web' : 'api') => { rows.push({ id: path, type: 'file', name: path.split('/').at(-1)!, path, language, parentId: app }); return path; };
  const symbol = (file: string, type: string, name: string, extra: Partial<EntityRow> = {}) => rows.push({ id: `${file}#${name}`, type, name, parentId: file, ...extra });
  const declared = (type: string, name: string, path: string, app = 'api') => rows.push({ id: `${type}:${name}`, type, name, path, parentId: app });
  declared('api_endpoint', 'GET /orders', file('api/routes/api.php', 'php'));
  declared('api_endpoint', 'POST /orders', 'api/routes/api.php');
  declared('api_endpoint', 'POST /login', file('api/config/fortify.php', 'php'));
  declared('scheduled_task', 'stock:sync daily', file('api/routes/console.php', 'php'));
  declared('command', 'stock:sync', 'api/routes/console.php');
  declared('command', 'search:rebuild', file('api/app/Console/Commands/RebuildSearch.php', 'php'));
  declared('database_table', 'orders', file('api/database/migrations/2024_create_orders_table.php', 'php'));
  rows.push({ id: 'database_table:invoices', type: 'database_table', name: 'invoices', path: 'api/database/migrations/2024_create_invoices_table.php', parentId: 'api', migrations: ['api/database/migrations/2025_add_total_to_invoices.php'] });
  file('api/database/migrations/2025_add_total_to_invoices.php', 'php');
  file('api/public/index.php', 'php'); file('api/artisan', 'php');
  symbol(file('api/app/Http/Controllers/OrderController.php', 'php'), 'controller', 'OrderController');
  symbol(file('api/app/Http/Middleware/Authenticate.php', 'php'), 'class', 'Authenticate');
  symbol(file('api/app/Models/Order.php', 'php'), 'model', 'Order');
  symbol(file('api/app/Services/PaymentService.php', 'php'), 'class', 'PaymentService');
  symbol(file('api/app/Jobs/SendInvoiceMail.php', 'php'), 'class', 'SendInvoiceMail');
  file('api/app/Support/helpers.php', 'php');
  file('api/app/Providers/AppServiceProvider.php', 'php');
  file('api/tests/Feature/OrderTest.php', 'php');
  declared('route', '/orders', file('web/app/orders/page.tsx', 'typescript'), 'web');
  symbol('web/app/orders/page.tsx', 'component', 'OrdersPage');
  symbol(file('web/app/layout.tsx', 'typescript'), 'component', 'RootLayout');
  declared('api_endpoint', 'GET /api/health', file('web/app/api/health/route.ts', 'typescript'), 'web');
  symbol(file('web/components/OrderTable.tsx', 'typescript'), 'component', 'OrderTable');
  symbol(file('web/hooks/useOrders.ts', 'typescript'), 'function', 'useOrders', { role: 'hook' });
  symbol(file('web/lib/useMediaQuery.ts', 'typescript'), 'function', 'useMediaQuery', { role: 'hook' });
  file('web/middleware.ts', 'typescript');
  file('web/next.config.ts', 'typescript');
  file('web/styles/globals.scss', 'scss');
  file('web/lib/api.ts', 'typescript');
  file('web/package.json', 'json');
  file('web/public/logo.svg', '');
  file('web/e2e/orders.spec.ts', 'typescript');
  file('web/src/widgets/Card.vue', 'vue');
  file('web/src/state/cart.ts', 'typescript');
  file('api/bin/console', '');
  symbol(file('api/app/Entities/Repos/PageRepo.php', 'php'), 'class', 'PageRepo');
  symbol(file('api/app/Entities/Models/Page.php', 'php'), 'class', 'Page');
  return new ProjectionIndex('run', rows, [], []);
}

test('files take an archetype from the index, then from conventions, each with a reason', () => {
  const archetypes = computeArchetypes(repository());
  const kind = (id: string) => archetypes.get(id)?.kind;
  const expected: Record<string, string | undefined> = {
    'api/routes/api.php': 'routes', 'api/routes/console.php': 'schedule', 'api/app/Console/Commands/RebuildSearch.php': 'command',
    'api/database/migrations/2024_create_orders_table.php': 'table', 'api/database/migrations/2025_add_total_to_invoices.php': 'table',
    'api/public/index.php': 'entry', 'api/artisan': 'entry', 'api/config/fortify.php': 'config', 'api/app/Providers/AppServiceProvider.php': 'config',
    'api/app/Http/Controllers/OrderController.php': 'controller', 'api/app/Http/Middleware/Authenticate.php': 'middleware', 'api/app/Models/Order.php': 'model',
    'api/app/Services/PaymentService.php': 'service', 'api/app/Jobs/SendInvoiceMail.php': 'job', 'api/app/Support/helpers.php': 'helper', 'api/tests/Feature/OrderTest.php': 'test',
    'web/app/orders/page.tsx': 'page', 'web/app/layout.tsx': 'layout', 'web/app/api/health/route.ts': 'routes', 'web/components/OrderTable.tsx': 'component',
    'web/hooks/useOrders.ts': 'hook', 'web/lib/useMediaQuery.ts': 'hook', 'web/middleware.ts': 'middleware', 'web/next.config.ts': 'config',
    'web/styles/globals.scss': 'style', 'web/package.json': 'config', 'web/e2e/orders.spec.ts': 'test', 'web/src/widgets/Card.vue': 'component',
    'web/src/state/cart.ts': 'hook', 'api/bin/console': 'entry', 'api/app/Entities/Repos/PageRepo.php': undefined, 'api/app/Entities/Models/Page.php': 'model', 'web/lib/api.ts': undefined, 'web/public/logo.svg': undefined,
  };
  for (const [path, archetype] of Object.entries(expected)) assert.equal(kind(path), archetype, path);
  assert.deepEqual(archetypes.get('api/routes/api.php'), { kind: 'routes', basis: 'indexed', reason: 'Declares 2 endpoints' });
  assert.deepEqual(archetypes.get('api/app/Services/PaymentService.php'), { kind: 'service', basis: 'convention', reason: 'A service, by path: api/app/Services/' });
  assert.equal(archetypes.get('api/app/Http/Controllers/OrderController.php')?.reason, 'Holds controller OrderController');
  assert.equal(archetypes.get('web/styles/globals.scss')?.basis, 'language');
});

test('entities take the archetype of their type; plain symbols have none', () => {
  const archetypes = computeArchetypes(repository());
  assert.equal(archetypes.get('api_endpoint:GET /orders')?.kind, 'routes');
  assert.equal(archetypes.get('route:/orders')?.kind, 'routes');
  assert.equal(archetypes.get('database_table:orders')?.kind, 'table');
  assert.equal(archetypes.get('scheduled_task:stock:sync daily')?.kind, 'schedule');
  assert.equal(archetypes.get('command:stock:sync')?.kind, 'command');
  assert.equal(archetypes.get('api/app/Http/Controllers/OrderController.php#OrderController')?.kind, 'controller');
  assert.equal(archetypes.get('web/hooks/useOrders.ts#useOrders')?.kind, 'hook');
  assert.equal(archetypes.get('api/app/Services/PaymentService.php#PaymentService'), undefined);
  for (const id of ['r', 'api', 'web']) assert.equal(archetypes.get(id), undefined);
});

test('areas count the blocks they hold by archetype, most first; what is inside a block counts through it', () => {
  const index = repository(), archetypes = computeArchetypes(index);
  const counts = computeArchetypeCounts(index, archetypes);
  const of = (id: string) => Object.fromEntries((counts.get(id) ?? []).map(entry => [entry.kind, entry.count]));
  const web = of('web');
  // Hooks: useOrders.ts, useMediaQuery.ts, state/cart.ts; the hook functions inside them do not count again.
  assert.equal(web.hook, 3);
  assert.equal(web.page, 1); assert.equal(web.layout, 1); assert.equal(web.component, 2); assert.equal(web.style, 1);
  // The page route and the health endpoint sit in districts of their own and count as routes, beside the file declaring the endpoint.
  assert.equal(web.routes, 3);
  // The controller class inside its file is not a second controller.
  assert.equal(of('api').controller, 1);
  assert.deepEqual(counts.get('r')?.slice(0, 1), [{ kind: 'routes', count: 7 }]);
  const total = (id: string) => (counts.get(id) ?? []).reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(total('r'), total('api') + total('web'));
  // Files have shapes of their own, never a summary.
  assert.equal(counts.get('web/app/orders/page.tsx'), undefined);
});
