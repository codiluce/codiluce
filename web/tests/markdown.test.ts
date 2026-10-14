import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inline, parseMarkdown, plainText } from '../lib/markdown';

test('markdown: the blocks models write, nested lists and tables included', () => {
  const blocks = parseMarkdown('## Login\n\nThe [form](a.ts) posts.\n\n1. One\n2. Two:\n   - [api](b.ts)\n   - c\n\n| File | Role |\n|---|:-:|\n| [a](a.ts) | x \\| y |\n\n```ts\n[no](link.ts)\n```\n> quoted\n\n---');
  assert.deepEqual(blocks.map(block => block.kind), ['heading', 'paragraph', 'list', 'table', 'code', 'quote', 'rule']);
  const list = blocks[2] as Extract<typeof blocks[number], { kind: 'list' }>;
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 2);
  assert.equal(list.items[1]![1]!.kind, 'list', 'the nested list sits in its item');
  const table = blocks[3] as Extract<typeof blocks[number], { kind: 'table' }>;
  assert.deepEqual(table.align, [undefined, 'center']);
  assert.equal(plainText(table.rows[0]![1]!), 'x | y');
  assert.equal((blocks[4] as { text: string }).text, '[no](link.ts)', 'code is never linked');
});
test('markdown: inline marks, links with spaces and parentheses, snake_case and line breaks', () => {
  const nodes = inline('**[the request](flow:POST /api/x)** calls `a_b` in snake_case_name, *see* [f(x)](a.ts#f(x)) and ~~old~~  \nnext');
  assert.deepEqual(nodes.map(node => node.kind), ['strong', 'text', 'code', 'text', 'em', 'text', 'link', 'text', 'del', 'break', 'text']);
  const strong = nodes[0] as { children: { kind: string; href?: string }[] };
  assert.equal(strong.children[0]!.href, 'flow:POST /api/x');
  assert.equal((nodes[6] as { href: string }).href, 'a.ts#f(x)');
  assert.equal((nodes[3] as { text: string }).text, ' in snake_case_name, ');
  assert.deepEqual(inline('<https://example.com> and \\*not em\\*').map(node => node.kind), ['link', 'text']);
  assert.ok(!JSON.stringify(parseMarkdown('<script>alert(1)</script>')).includes('"html"'), 'raw HTML stays text');
});
