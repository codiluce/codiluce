import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from 'php-parser';
import { conventionTable, extractSchema, pluralize } from '../src/analyzers/laravel-schema.js';
import type { Ast, ParsedFile } from '../src/analyzers/php-ast.js';

const parser = new Engine({ parser: { version: '8.4', suppressErrors: false }, ast: { withPositions: true } });
function migration(name: string, up: string, header = "use Illuminate\\Database\\Migrations\\Migration;\nuse Illuminate\\Database\\Schema\\Blueprint;\nuse Illuminate\\Support\\Facades\\Schema;"): ParsedFile {
  const content = `<?php\n${header}\nreturn new class extends Migration {\n    public function up(): void\n    {\n${up}\n    }\n    public function down(): void { Schema::dropIfExists('ignored'); }\n};\n`;
  const path = `app/database/migrations/${name}.php`;
  return { file: { path, absolutePath: `/repo/${path}`, id: `file:${name}`, analyzable: true }, ast: parser.parseCode(content, path) as unknown as Ast, content };
}
const columns = (table: { columns: { name: string }[] } | undefined) => table?.columns.map(column => column.name);

test('migrations replay in file-name order, reading up() only', () => {
  const { tables } = extractSchema([
    migration('2024_02_01_alter', "Schema::table('posts', function (Blueprint $table) { $table->string('title', 120)->change(); $table->dropColumn(['legacy', 'old']); $table->renameColumn('body', 'content'); });"),
    migration('2024_01_01_create', "Schema::create('posts', function (Blueprint $table) { $table->id(); $table->string('title'); $table->text('body'); $table->string('legacy'); $table->string('old')->nullable(); $table->morphs('commentable'); $table->softDeletes(); $table->timestamps(); });"),
    migration('2024_03_01_rename', "Schema::rename('posts', 'articles');\n Schema::create('tmp', function (Blueprint $t) { $t->id(); });\n Schema::drop('tmp');"),
  ], 'test');
  assert.deepEqual([...tables.keys()], ['articles']);
  const articles = tables.get('articles')!;
  assert.deepEqual(columns(articles), ['id', 'title', 'content', 'commentable_type', 'commentable_id', 'deleted_at', 'created_at', 'updated_at']);
  assert.deepEqual(articles.previousNames, ['posts']);
  assert.deepEqual(articles.operations.map(item => item.operation), ['create', 'alter', 'rename']);
  assert.equal(articles.created?.file, 'app/database/migrations/2024_01_01_create.php');
  assert.equal(articles.columns.find(column => column.name === 'deleted_at')?.nullable, true);
  assert.equal(articles.columns.find(column => column.name === 'id')?.primary, true);
});
test('foreign keys: constrained() guesses, foreign()->references()->on(), foreignIdFor and drops', () => {
  const { tables, diagnostics } = extractSchema([migration('2024_01_01_keys', `
        Schema::create('comments', function (Blueprint $table) {
            $table->foreignId('author_id')->constrained('users')->nullOnDelete();
            $table->foreignId('blog_post_id')->constrained();
            $table->unsignedBigInteger('editor');
            $table->foreign('editor')->references('id')->on('people')->onDelete('cascade');
            $table->foreignIdFor(\\App\\Models\\Category::class)->constrained();
            $table->foreignId('tag_id')->constrained();
            $table->dropForeign(['tag_id']);
            $table->unknownMacro('x');
        });
        Schema::connection('analytics')->create('events', fn (Blueprint $table) => $table->ulid('id'));
        Schema::create($name, function (Blueprint $table) {});`)], 'test');
  const comments = tables.get('comments')!;
  assert.deepEqual(comments.foreignKeys.map(({ evidence: _evidence, ...key }) => key), [
    { column: 'author_id', table: 'users', references: 'id', onDelete: 'set null' },
    { column: 'blog_post_id', table: 'blog_posts', references: 'id' },
    { column: 'editor', table: 'people', references: 'id', onDelete: 'cascade' },
    { column: 'category_id', table: 'categories', references: 'id' },
  ]);
  assert.equal(tables.get('events')?.connection, 'analytics');
  assert.deepEqual(diagnostics.map(item => item.code).sort(), ['dynamic-migration-table', 'unsupported-blueprint-call']);
});
test('a table only altered by migrations is declared, and said to be created elsewhere', () => {
  const { tables, diagnostics } = extractSchema([migration('2024_01_01_words', "if (!Schema::hasColumn('words', 'level')) {\n  Schema::table('words', function (Blueprint $table) { $table->integer('level')->default(1); });\n}")], 'test');
  const words = tables.get('words')!;
  assert.equal(words.created, undefined);
  assert.equal(words.conditional, true);
  assert.deepEqual(words.columns, [{ name: 'level', type: 'integer', default: '1' }]);
  assert.ok(diagnostics.some(item => item.code === 'table-created-elsewhere'));
});
test('the Schema facade must resolve; an unrelated Schema class is not read', () => {
  const { tables } = extractSchema([migration('2024_01_01_other', "Schema::create('nope', function ($table) { $table->id(); });", 'namespace App;\nuse App\\Support\\Schema;')], 'test');
  assert.equal(tables.size, 0);
});
test('model table conventions follow Laravel pluralization', () => {
  assert.equal(conventionTable('User'), 'users');
  assert.equal(conventionTable('UserCard'), 'user_cards');
  assert.equal(conventionTable('Category'), 'categories');
  assert.equal(conventionTable('Person'), 'people');
  assert.equal(conventionTable('News'), 'news');
  assert.equal(conventionTable('Address'), 'addresses');
  assert.equal(conventionTable('HTTPLog'), 'http_logs');
  assert.equal(pluralize('box'), 'boxes');
  assert.equal(pluralize('day'), 'days');
});
