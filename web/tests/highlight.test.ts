import assert from 'node:assert/strict';
import { test } from 'node:test';
import { highlightLines, splitHighlighted } from '../lib/highlight';

test('syntax highlighting escapes HTML and keeps one balanced fragment per source line', () => {
  const lines = ['/* a comment that', '   spans lines <b>not html</b> */', 'const x = "<script>";'];
  const html = highlightLines(lines, 'typescript');
  assert.equal(html.length, 3);
  for (const line of html) {
    assert.equal((line.match(/<span/g) ?? []).length, (line.match(/<\/span>/g) ?? []).length, line);
    assert.ok(!line.includes('<b>') && !line.includes('<script>'));
  }
  assert.ok(html[1]!.includes('hljs-comment'), 'multi-line comment continues on the next line');
  assert.deepEqual(splitHighlighted('<span class="a">x\ny</span>'), ['<span class="a">x</span>', '<span class="a">y</span>']);
  assert.deepEqual(highlightLines(['<?php echo 1;'], 'unknown-language'), ['&lt;?php echo 1;']);
});
