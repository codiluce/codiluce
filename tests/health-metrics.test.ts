import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { createMeasurer, metricsDialect, type MetricsDialect, type MetricsMeasurer } from '../src/analysis/metrics/grammars.js';
import type { FunctionMetrics } from '../src/analysis/metrics/measure.js';
import { generatedReason } from '../src/analysis/metrics/generated.js';

let measurer: MetricsMeasurer;
before(async () => { measurer = await createMeasurer(); });
after(() => measurer.close());

const measure = (dialect: MetricsDialect, content: string) => measurer.measure(dialect, content);
const shape = ({ length, complexity, nesting, parameters }: FunctionMetrics) => ({ length, complexity, nesting, parameters });
const byName = (functions: FunctionMetrics[]) => Object.fromEntries(functions.map(item => [item.name, shape(item)]));

// One table for every language: the fixture writes the same functions in each.
const SHARED = {
  classify: { length: 7, complexity: 4, nesting: 1, parameters: 2 },
  total: { length: 8, complexity: 5, nesting: 3, parameters: 2 },
  parse: { length: 7, complexity: 3, nesting: 1, parameters: 1 },
  pick: { length: 8, complexity: 4, nesting: 1, parameters: 3 },
  'cart.add': { length: 2, complexity: 1, nesting: 0, parameters: 1 },
};
for (const [dialect, extension] of [['typescript', 'ts'], ['javascript', 'js'], ['python', 'py'], ['go', 'go'], ['php', 'php']] as const) {
  test(`the shared fixture measures the same in ${dialect}`, async () => {
    const content = await readFile(new URL(`./fixtures/health/sample.${extension}`, import.meta.url), 'utf8');
    const functions = measure(dialect, content).functions;
    assert.deepEqual(Object.fromEntries(functions.map(item => [item.name.toLowerCase(), shape(item)])), SHARED);
  });
}

test('dialects follow Codiluce languages', () => {
  assert.equal(metricsDialect('typescript', 'src/app.ts'), 'typescript');
  assert.equal(metricsDialect('typescript', 'src/Page.tsx'), 'tsx');
  assert.equal(metricsDialect('javascript', 'src/app.jsx'), 'javascript');
  assert.equal(metricsDialect('rust', 'src/main.rs'), undefined);
});

test('a named function inside another is measured on its own, with its lines', () => {
  const { functions } = measure('typescript', [
    'function outer(items: Item[]) {',
    '  const helper = (item: Item) => {',
    '    if (item.ok) {',
    '      return 1;',
    '    }',
    '    return 0;',
    '  };',
    '  return items.map(helper);',
    '}',
  ].join('\n'));
  assert.deepEqual(byName(functions), {
    // `const helper = …` holds code of both.
    outer: { length: 3, complexity: 1, nesting: 0, parameters: 1 },
    'outer.helper': { length: 4, complexity: 2, nesting: 1, parameters: 1 },
  });
});

test('an anonymous function is part of the function around it and adds a nesting level', () => {
  const { functions } = measure('typescript', [
    'function report(rows: Row[]) {',
    '  rows.forEach(row => {',
    '    if (row.total > 0) {',
    '      print(row);',
    '    }',
    '  });',
    '}',
  ].join('\n'));
  assert.deepEqual(byName(functions), { report: { length: 4, complexity: 2, nesting: 2, parameters: 1 } });
});

test('an anonymous function outside any function is its own unit, named by its call', () => {
  const { functions } = measure('javascript', "app.get('/health', (request, response) => {\n  response.send(request.ok ? 'ok' : 'down');\n});\n");
  assert.deepEqual(functions.map(item => [item.name, item.complexity, item.parameters]), [['app.get callback', 2, 2]]);
});

test('callbacks inside a top-level callback are units of their own: tests, route groups', () => {
  const tests = measure('typescript', [
    "describe('cart', () => {",
    '  const cart = new Cart();',
    "  it('adds', () => {",
    '    expect(cart.add(item) ? 1 : 0).toBe(1);',
    '  });',
    "  it('empties', () => {",
    '    expect(cart.empty()).toBe(true);',
    '  });',
    '});',
  ].join('\n'));
  assert.deepEqual(tests.functions.map(item => [item.name, item.length, item.complexity]), [['describe callback', 4, 1], ['describe callback.it callback', 2, 2], ['describe callback.it callback', 2, 1]]);
  const routes = measure('php', "<?php\nRoute::group(['prefix' => 'admin'], function () {\n    Route::get('/', fn () => view('admin'));\n    Route::post('/save', function (Request $request) {\n        return $request->ok ? 'saved' : 'failed';\n    });\n});\n");
  assert.deepEqual(routes.functions.map(item => [item.name, item.complexity, item.parameters]), [['group callback', 1, 0], ['group callback.get callback', 1, 0], ['group callback.post callback', 2, 1]]);
});

test('a function wrapped by a call takes the name of its variable', () => {
  const { functions } = measure('tsx', 'export const Button = forwardRef((props: Props, ref) => {\n  return <button ref={ref} {...props} />;\n});\n');
  assert.deepEqual(functions.map(item => [item.name, item.parameters]), [['Button', 2]]);
});

test('else-if chains stay flat', () => {
  const chain = (dialect: MetricsDialect, content: string) => shape(measure(dialect, content).functions[0]!);
  assert.deepEqual(chain('go', 'package p\nfunc grade(n int) string {\n\tif n > 3 {\n\t\treturn "a"\n\t} else if n > 2 {\n\t\treturn "b"\n\t} else if n > 1 {\n\t\treturn "c"\n\t} else if n > 0 {\n\t\treturn "d"\n\t}\n\treturn "e"\n}\n'),
    { length: 10, complexity: 5, nesting: 1, parameters: 1 });
  assert.deepEqual(chain('php', '<?php\nfunction grade($n) {\n    if ($n > 2) { return "a"; } else if ($n > 1) { return "b"; } elseif ($n > 0) { return "c"; }\n    return "d";\n}\n'),
    { length: 3, complexity: 4, nesting: 1, parameters: 1 });
});

test('docstrings and comments are not length; Python receivers and Go receivers are not parameters', () => {
  const python = measure('python', 'class Store:\n    def get(self, key, default=None):\n        """Return the value.\n\n        Or the default."""\n        # Look it up.\n        return self.items.get(key, default)\n');
  assert.deepEqual(byName(python.functions), { 'Store.get': { length: 2, complexity: 1, nesting: 0, parameters: 2 } });
  const go = measure('go', 'package p\nfunc (s *Stack[T]) Push(a, b T, _ int, rest ...T) {}\nfunc Handler(http.ResponseWriter, *http.Request) {}\n');
  assert.deepEqual(go.functions.map(item => [item.name, item.parameters]), [['Stack.Push', 4], ['Handler', 2]]);
});

test('lines with only brackets do not count, whatever the brace style', () => {
  const kr = measure('php', '<?php\nfunction run($job) {\n    return $job->handle();\n}\n').functions[0]!;
  const allman = measure('php', '<?php\nfunction run($job)\n{\n    return $job->handle();\n}\n').functions[0]!;
  assert.equal(kr.length, 2);
  assert.equal(allman.length, 2);
});

test('deep expressions do not exhaust the stack', () => {
  const content = `const total = ${Array.from({ length: 20_000 }, (_, index) => `v${index}`).join(' + ')};\n`;
  assert.equal(measure('javascript', content).lines, 1);
});

test('generated and minified files are recognized', () => {
  assert.ok(generatedReason('api/v1/user.pb.gw.go', 'package v1\n'));
  assert.ok(generatedReason('client/schema.go', '// Code generated by ent, DO NOT EDIT.\n\npackage client\n'));
  assert.ok(generatedReason('static/app.js', `var a=${'1,'.repeat(5000)}1;`));
  assert.equal(generatedReason('server/routes.go', 'package server\n\nfunc main() {}\n'), undefined);
});
