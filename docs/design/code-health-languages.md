# Code health in more languages: implementation plan

Written 2026-10-15, for an agent taking over the work.

Code health measures four numbers per function: **length**, **cyclomatic
complexity**, **nesting** and **parameters**. It works today in TypeScript
(with TSX), JavaScript, PHP, Python and Go. This plan adds, in this order:

1. Vue, Svelte and Astro (their `<script>` blocks)
2. Java and Kotlin
3. C#
4. Ruby (Rails)
5. Rust
6. C and C++
7. Swift, Scala and Groovy
8. F# and VB.NET
9. Objective-C

Phase 0 comes first: engine and pipeline changes every language needs.

## Decisions already made (do not reopen)

- **Few metrics, shared by every language.** The user prefers four numbers
  that mean the same thing everywhere over deep analysis of one or two
  languages. Do not add metrics. Do not add per-language scoring.
- **One engine.** `src/analysis/metrics/measure.ts` applies the rules. Each
  language only describes its syntax in
  `grammars/queries/<language>/metrics.scm`. When a language needs something
  the captures can't express, add a small, general capability to the engine
  (Phase 0 lists the ones already known). Don't write per-language code paths.
- **No new grammars.** Every language here already has a pinned grammar in
  `grammars/manifest.json`, shipped for structure. Vue, Svelte and Astro reuse
  the TypeScript, TSX and JavaScript grammars from `grammars/metrics.json`.
- **Lizard is only a development check**, to compare numbers on real code. It
  is never a dependency and never runs in the product.

## Where to work, and ground rules

- **Work in a new worktree**, unless the user says otherwise. For example:
  `git worktree add /var/www/html/codiluce-health-languages -b code-health/languages main`.
  The main checkout `/var/www/html/codiluce` is shared by several concurrent
  sessions; don't develop there.
- The old `/var/www/html/codiluce-health` worktree (branch `code-health`) is
  already merged into main. Don't reuse it, and don't delete it without asking.
- **Merge into main only when the user asks.** Commit once per phase on your
  branch. When the user asks to merge, other sessions may have uncommitted
  edits in main's working tree: preserve them. Never stash, reset or check out
  over files someone else changed.
- **Don't touch structural analysis.** Leave alone `declarations.scm`,
  `grammars/manifest.json`, `src/analysis/tree-sitter/*` and the language
  analyzers. Changing them invalidates structural caches and history
  identities, and another session (`/var/www/html/codiluce-multilingual`, branch
  `framework/multilingual-support`) is actively changing framework analysis for
  these same languages. If a symbol's range is wrong for matching, adapt the
  matching or write the problem down. Don't change the extractor.
- **Never rebuild main's `web/out`** and never run `npm run build:web` or
  `npm run test:e2e` in the main checkout: the live server on port 4300 serves
  it. This plan barely touches the UI (labels and text); typecheck and the web
  unit tests are enough. If you do run e2e, run it only inside your worktree.
- **Real repositories** for checks: clone them shallow (`--depth 1`) into a
  scratch directory, never into `examples/`. That folder is a curated set
  documented in `examples/readme.md`. Its local clones are fine to read: rust
  (`ripgrep`, `axum`, `ruff`), C (`jq`, `curl`, `git`), and Vue/Svelte/Astro
  (`tanstack-query`).

## How code health works today

| Piece | File |
| --- | --- |
| Rules and captures (the header is the spec) | `src/analysis/metrics/measure.ts` |
| Dialects, grammar loading, fingerprints | `src/analysis/metrics/grammars.ts` |
| Indexing: measure, cache, match to symbols, file and repository data | `src/analysis/metrics/analyzer.ts` (`codeHealthAnalyzer`, `matchSymbols`, `TEST_FILE`) |
| Generated and minified files | `src/analysis/metrics/generated.ts` |
| Stored shapes, spread ranks | `src/analysis/metrics/health.ts` |
| Syntax per language | `grammars/queries/{typescript,javascript,php,python,go}/metrics.scm` |
| Same functions in every language | `tests/fixtures/health/sample.*`, `tests/health-metrics.test.ts` |
| Indexing, matching, cache, history parity | `tests/code-health.test.ts` |
| Metrics over a folder, worst functions | `scripts/health-report.ts` (`--json` writes every function) |
| Inspector section | `web/components/CodeHealth.tsx` |
| Complexity and Hotspots lenses (Color by) | `src/projection/lenses.ts`, `src/projection/service.ts` (`metricLens`), `web/lib/lenses.ts` |
| User documentation | `docs/reference.md` ("Code health" and "Color by" bullets), `grammars/README.md` |

Facts that matter for this work:

- `codeHealthAnalyzer` runs last in the analyzer list
  (`src/pipeline/index.ts`). It also runs on history snapshots, so it must
  depend only on file contents: a commit has to measure the same as the working
  tree.
- A file is measured again only when its content, grammar or query changes.
  The cache key includes `metricsFingerprint(dialect)`, a hash of
  `METRICS_VERSION`, the grammar's SHA-256 and the query text.
- Each measured function is attached to a symbol by `matchSymbols`: the
  function ending on the symbol's last line, preferably with its name.
  Symbols come from the structural extractors. A tree-sitter `property`
  declaration becomes an entity of type `method` with
  `metadata.declarationKind: 'property'`.
- Both `CODE_HEALTH_VERSION` and every analyzer version are part of the
  history snapshot identity (`historyIdentity` in `src/history/indexer.ts`).
  Changing a version means old snapshots must be indexed again.
- `createMeasurer()` currently loads **every** dialect's grammar up front.
  The structural grammars total about 45 MB of WASM (F# alone is 11 MB). This
  must become lazy (Phase 0).

How well the five current languages agree with Lizard (matched by file and
start line):

| Language | Complexity equal | Within ±1 | Parameters equal |
| --- | --- | --- | --- |
| Go | 94% | 97% | 97% |
| JavaScript | 88% | 94% | 94% |
| PHP | 96% | 99% | 83% |
| Python | 97% | 100% | 74% |
| TypeScript | 90% | 95% | 91% |

Most differences are deliberate. For example, we count an anonymous function
inside a named function as part of it, while Lizard often doesn't.

## Rules every language follows

These extend the rules in the `measure.ts` header. Write each new rule into
that header (and into `docs/reference.md`) when you implement it, so the
header stays the spec.

**Functions**
- A function is anything with a body bound to a name: declarations, methods,
  constructors, destructors, initializer blocks, and function values assigned to
  a variable, field or property.
  - Constructor names: Java and C# use the class name. Kotlin uses
    `constructor` and `init` for init blocks. Swift uses `init` and `deinit`.
    VB.NET uses `New`, and Java static blocks are `static`.
- Methods are qualified by their class-like container: `Cart.add`. Out-of-line
  definitions use their receiver: C++ `Cart::add`, Rust
  `impl Cart { fn add }` and Go receivers all become `Cart.add`.
- **A property with code is one function**, named by the property. That covers
  C# and VB.NET accessors with bodies or `=>` bodies, Kotlin custom
  `get()`/`set()`, and Swift computed properties and `willSet`/`didSet`.
  Auto-properties (`{ get; set; }`) are not functions. This keeps one function
  per property symbol, which is what the matcher can attach to.
- Declarations without a body are not functions: abstract and interface
  methods, C prototypes, protocol requirements, F# `.fsi` signatures.
- A named function inside another is its own unit, as TypeScript and Python
  already do: C# local functions, Kotlin, Swift, Scala and Rust nested
  functions, and F# inner `let` with arguments.
- Anonymous functions follow the current rule. Inside a named function, they
  are part of it and add a nesting level. Anywhere else, each is its own unit,
  named by the call it is passed to. Examples: Ruby `do … end` blocks, Kotlin
  trailing lambdas, Swift trailing closures, Groovy closures, Rails
  `scope :x, -> { }`, RSpec `describe … do`.

**Complexity: 1 + decision points**
- `if` and each else-if, each loop, each non-default arm, each catch, each
  ternary, and each short-circuit `&&`/`||`.
  - Loops: `for`, `foreach`, `while`, `do … while`, `repeat … while`,
    `until`, and Rust `loop`. Every loop statement counts, as Go's bare
    `for {}` already does.
  - Arms: `case`, `when`, `match` arms, Ruby `in`.
  - Catches: `catch`, `rescue`, `except`, F# `with` rules.
  - Short-circuit operators per language: Ruby also `and`/`or`; VB.NET
    `AndAlso`/`OrElse`, but not the eager `And`/`Or`.
- **Unless and guards count** like `if`: Ruby `unless` and the modifiers
  `x if y` / `x unless y` / `while` / `until`, Swift `guard`, and `if let`,
  `guard let`, `while let`.
- **Default arms never count**: `default:`, `else ->` in a Kotlin `when`,
  `_ =>` (Rust, C# switch expressions, Scala), `case _`, `| _ ->` (F#),
  `Case Else`, and a Ruby `case … else`.
- **Guards on an arm add nothing** (`case x if …`, `when`, Rust match guards):
  the arm counts once. Python already works this way. `&&`/`||` inside a
  guard still count.
- **Never counts**:
  - null-coalescing and safe calls: `??`, `?.`, Elvis `?:`, Rust's `?`,
    Swift `try?`
  - `else` and `finally`/`ensure`
  - preprocessor conditionals (`#if`, `#ifdef`, C# `#if`): they choose a
    build, not a path
  - comprehension clauses (Python, as today)
- Rust `let … else` counts once (it is a guard).

**Nesting**
- Count structures whose body is indented: `if` (and `unless`/`guard`), loops,
  `switch`/`when`/`match`/`case`, `try`/`begin … rescue`, and resource blocks.
  Resource blocks are Python `with` (as today), Java `synchronized` and
  try-with-resources, C# `using`/`lock`/`fixed` blocks, VB.NET
  `Using`/`SyncLock`/`With`, and Objective-C `@synchronized`.
- Else-if chains stay flat.
- One-line modifiers (`x if y`) don't nest.
- Preprocessor blocks don't nest.

**Parameters**
- Count every declared parameter, including defaults, variadic or rest
  parameters (each counts as 1), `out`/`ref`/`params`, and Ruby `&block`.
  Destructured parameters count as 1. In F#, tuple elements count one each,
  so `member x.Add(a, b)` has 2.
- **A receiver is never a parameter.** That covers Python `self`/`cls` and Go
  receivers (as today), Rust `self`, the self identifier of an F#
  `member this.X`, and the `this` parameter of a C# extension method. A Kotlin
  extension receiver isn't syntactically a parameter anyway.
- C `f(void)` has no parameters.
- Objective-C: each `:(Type)name` keyword part counts as one parameter.

**Length: lines holding code**
- Comments and doc comments never count: Javadoc, KDoc, XML `///`, Rust
  `///` and `//!`, Ruby `=begin`, F# `(* *)`, VB `'` and `REM`.
- **Lines with only a closing keyword don't count**, like a line with only
  `}`. Examples: Ruby `end`, Scala 3 `end` markers (`end_marker`). VB.NET's
  `End If` / `Next` / `Loop` are hidden tokens in its grammar, so they already
  don't count.
- **Annotation, attribute and decorator lines don't count.** Python decorators
  already don't count, because they sit outside the function node. Apply the
  same rule to Java/Kotlin annotations, C# and VB attributes, Swift
  attributes, Rust `#[…]` and PHP `#[…]`. See Phase 0: PHP and TypeScript may
  change.

**Files**
- A file's `codeLines` follows the same rule.
- For a Vue, Svelte or Astro component, only script blocks are measured:
  `codeLines` counts script lines, and template expressions are not measured
  (see Out of scope).
- Gradle and Ruby build scripts are skipped with a reason (Phase 0).

## Phase 0: groundwork (one commit, before any language)

Each item lists what to change and how to know it's done.

1. **Load grammars lazily.**
   - Change: `createMeasurer(dialects)` loads only the dialects the analyzer
     will use. The analyzer computes the set from the files it is about to
     measure, then creates the measurer. `scripts/health-report.ts` does the
     same.
   - Done when: indexing a TypeScript-only repository loads no other grammar,
     and a test proves it, for example through a loaded-dialects accessor on
     the measurer.

2. **One table describes every dialect.**
   - Change: replace `DIALECTS`, `QUERY` and the `if` chain in
     `metricsDialect` with one record per dialect. Each record holds:
     - the grammar key in `metrics.json` or `manifest.json`
     - the query folder
     - the Codiluce languages and extensions it measures
     - a display label
   - Export `MEASURED_LANGUAGES` (labels, in order) from it.
   - Done when: adding a language means adding one record and one query file.

3. **Measure a file through inputs, not a single dialect.**
   - Change: add `metricsInputs(file, content)`, which returns
     `{ dialect, text }[]`.
     - A plain file gives one input: the whole content.
     - A component gives one input per supported script region (Phase 1).
   - The analyzer and `health-report.ts` both use it.
   - The cache key combines the fingerprints of the dialects used. For
     components it also includes `EMBEDDED_VERSION`.
   - Done when: the existing tests pass unchanged.

4. **Terminal newline for every dialect.**
   - Change: the Go-only fix in `createMeasurer().measure` (appending `\n`
     when the content lacks one) applies to all dialects. Several grammars
     with automatic semicolons (Kotlin, Swift, Scala) misparse a last line
     without one.
   - Done when: the existing tests pass, and one test measures a file without
     a final newline in each new dialect.

5. **New capture `@closing`.**
   - Change: in `leaf()`, skip visible keyword tokens captured as
     `@closing`. A line holding only them is not code, like `}`.
   - Done when: there is a Ruby unit test, `def … end` length 2, written once
     Ruby lands. Until then, add an engine unit test with a hand-made query
     on an existing grammar if possible.

6. **New capture `@line`.**
   - Change: the first line of a captured node holds code even when the
     grammar hides its keyword. VB.NET hides `Else`, `Try`, `Finally`,
     `Case Else`, `Do` and a bare `Catch`; without this, a line with only
     `Else` wouldn't count, though `} else {` counts in TypeScript and
     `else:` in Python.
   - Done when: the VB.NET fixture matches the shared table (Phase 8).

7. **Operators the grammar hides.**
   - VB.NET's `binary_expression` has no visible operator token for `AndAlso`
     / `OrElse` (checked: the tree shows only `left` and `right`).
   - Change: support a custom predicate the engine evaluates, for example
     `(#operator? @branch "AndAlso" "OrElse")`. It means: the source text
     between the node's `left` and `right` children, trimmed and compared
     without case, is one of these.
   - In web-tree-sitter 0.27, user-defined predicates are in
     `query.predicates[match.patternIndex]`; the engine must drop matches
     whose predicate fails.
   - Done when: a VB.NET test where `a AndAlso b` adds 1 and `a And b` adds 0.

8. **Annotations are not length.**
   - Change: annotation, attribute and decorator nodes don't count as code,
     and the engine's "first line always counts" rule uses the first line
     that holds a token outside them. Otherwise `@Override` on its own line
     adds one line to every Java method.
   - Check PHP (`attribute_list` is inside `method_declaration`) and TS
     decorators. Their numbers may change, which is intended.
   - Done when: a PHP method with `#[Route(...)]` on its own line has the
     same length as without it.

9. **Count syntax errors.**
   - Change: `FileMetrics` gains `syntaxErrors`, the number of `ERROR` and
     missing nodes. The analyzer stores it in `metadata.health` when it is
     non-zero, and the Inspector's file section says "Parsed with N syntax
     errors: numbers may be off". C and C++ with macros, Objective-C++ and
     malformed components need this.
   - Done when: there's a test and the Inspector shows the note.

10. **Bound parse time.**
    - Change: pass `progressCallback` to `parser.parse` and return `true`
      after a time budget (start with 2 s). That cancels the parse, and the
      file is skipped with "took too long to parse". Large C, C++ and
      Objective-C files make this matter.
    - Done when: a test with a tiny budget skips the file with that reason.

11. **Test and generated paths.**
    - Extend `TEST_FILE` (`analyzer.ts`) for:
      - `*Test(s).{java,kt,cs,swift,scala,groovy,vb,fs}` and
        `*Spec.{groovy,scala,kt}`
      - `*_spec.rb` and `*_test.rb`
      - `*.Tests/` and `*.Test/` folders (.NET), and `benches/`
      - Swift `Tests/` already matches, because the regex ignores case.
    - Extend `GENERATED_PATH` and the banners (`generated.ts`) for:
      - C#: `*.g.cs`, `*.g.i.cs`, `*.Designer.cs`/`.vb`, `*.AssemblyInfo.cs`
      - Protocol Buffers: `*.pb.cc`, `*.pb.h`, `*.pb.swift`, `*.pbobjc.[hm]`,
        `*_pb.rb`
      - parser generators: `*.tab.[ch]`, `lex.yy.c`, and the banner
        `made by GNU Bison`
    - Rails `db/schema.rb` is already caught by its "auto-generated" banner;
      test it.
    - Done when: `tests/health-metrics.test.ts` covers each pattern.

12. **Skip build scripts.**
    - Change: skip, with the reason "a build script: configuration, not
      application code":
      - Gradle: `build.gradle(.kts)`, `settings.gradle(.kts)`
      - `Jenkinsfile`
      - Ruby: `Gemfile`, `*.gemspec`, `Podfile`, `Fastfile`, `Appfile`,
        `Brewfile`, `Guardfile`, `Vagrantfile`
    - Their DSL blocks would otherwise become dozens of callback units.
      `Rakefile` and `*.rake` hold real tasks: keep measuring them.
    - Done when: a test covers it.

13. **The lens says the right thing.**
    - Change: in `src/projection/service.ts` (`metricLens`), build the
      language list from `MEASURED_LANGUAGES` instead of the hard-coded
      "(TypeScript, JavaScript, PHP, Python and Go)". When an index or
      snapshot recorded an older `code-health` version than the current one,
      and nothing in it is measured, say to index again (the current text
      for that case).
    - Done when: `tests/lenses.test.ts` covers both messages.

14. **Development tools**, committed under `scripts/`:
    - `scripts/syntax-tree.ts <grammar> <file>` prints a file's tree with
      field names and line ranges, so you can see node shapes before writing
      a query.
    - `scripts/health-compare.ts <report.json> <lizard.csv>` compares
      `health-report.ts --json` with Lizard's CSV.
      - Lizard's columns are nloc, ccn, token, param, length, location,
        file, function, long_name, start, end.
      - Match functions by file and **end line** first, then start line:
        annotations move start lines.
      - Print, per language: matched share, complexity equal and within ±1,
        parameters equal, length/NLOC median ratio, and the 10 worst
        disagreements.
    - `scripts/health-matching.ts <repo>` indexes a repository and prints,
      per language:
      - how many function/method symbols received metrics
      - how many measured functions have no symbol
      - 10 samples of each, with file and lines
    - To install Lizard (development only):
      `python3 -m pip install --target <scratch>/lizard-lib lizard`, then
      `PYTHONPATH=<scratch>/lizard-lib python3 -m lizard --csv -l <lang> <dir>`.
      A venv did not work on this machine. Lizard 1.24.1 supports Java,
      Kotlin, C#, Ruby, Rust, C/C++, Objective-C, Swift, Scala, TypeScript
      and Vue. It does not support Svelte, Astro, Groovy, F# or VB.NET.

15. **Generalize the shared fixture test.**
    - The loop in `tests/health-metrics.test.ts` becomes a table:
      `[dialect, file, overrides]`.
    - `overrides` patches `SHARED` for a language that can't write a
      function the same way. Example: C has no methods, so `cart_add(cart,
      item)` has 2 parameters.
    - Every override needs a comment saying why, and the fixture's header
      says it too (as `sample.go` does for exceptions).

Versions:
- Phase 0 changes measuring rules (annotations, newline), so bump
  `METRICS_VERSION` to 2.
- Leave `CODE_HEALTH_VERSION` for the end (see Final phase).

## Per-language recipe (definition of done)

Repeat for every language:

1. **Look at the syntax.** Run `scripts/syntax-tree.ts` on real files: a
   class with methods, constructors, properties, lambdas, every branch kind,
   comments, annotations and a file without a final newline. Node names in
   this plan exist in the shipped grammars (checked), but fields and shapes
   must be read from trees.
2. **Write `grammars/queries/<language>/metrics.scm`** with the header line
   `; Code health metrics for <Language>: see src/analysis/metrics/measure.ts.`
   and short comments for every non-obvious choice. Then add the dialect
   record (Phase 0, item 2).
3. **Write the shared fixture** `tests/fixtures/health/sample.<ext>`.
   - It holds the same five functions (`classify`, `total`, `parse`, `pick`,
     `Cart.add`), written idiomatically, with the same numbers.
   - Where a construct is missing, use the closest one with the same count,
     and say so in the header. Go's `parse` uses `if err != nil` instead of
     try/catch.
   - Add the language to the table test.
4. **Write unit tests** in `tests/health-metrics.test.ts` for that language's
   special cases, as listed in its section below. At least:
   - default arms don't count
   - else-if stays flat
   - receivers aren't parameters
   - comments and closing keywords aren't length
   - a property with code is one function
   - a lambda inside a function folds in, and one outside is its own unit
   - a nested named function is its own unit
5. **Check matching** in `tests/code-health.test.ts`. Index a small
   repository in the language and assert that methods, constructors and
   properties get metrics on their symbols, and that bodiless declarations
   get none. Use the language's real structural extractor, through the
   pipeline.
6. **Compare with Lizard** on two real repositories (listed per language)
   with `scripts/health-compare.ts`.
   - Target: complexity equal for ≥ 85% of matched functions and within ±1
     for ≥ 93%.
   - Read the 10 worst disagreements. Fix the ones that are bugs. For the
     ones that come from our rules, note the class of difference in the
     results log.
   - Languages Lizard can't read: hand-check 20 functions from a real
     repository against the rules, and note it.
7. **Check matching on real code** with `scripts/health-matching.ts`.
   - Target: ≥ 95% of function/method symbols that have a body get metrics.
   - Unmatched symbols must be bodiless (abstract members, prototypes,
     auto-properties) or explained in the results log.
8. **Check speed** with `scripts/health-report.ts`: ms per 1,000 code lines,
   and the grammar's load time. Write both down. Code health should stay
   around 10–15% of a first index.
9. **Run everything:** `npm run typecheck`, then `npm test`. Fix any test
   that compared whole `metrics` objects of symbols in that language. Those
   symbols now carry `codeLines`, `complexity`, `nesting` and `parameters`
   next to `loc`.
10. **Fill in the results log** at the end of this file.

## Phase 1: Vue, Svelte, Astro

The script blocks are TypeScript or JavaScript, so this phase needs no new
query: it reuses the `typescript`, `tsx` and `javascript` dialects.

- **Regions.** `extractEmbedded(text, language)` in
  `src/analysis/embedded/source.ts` returns `regions` with:
  - `start` and `end` (UTF-16 offsets)
  - `language` and `extension` (`js`, `jsx`, `ts` or `tsx`)
  - `role` (`module`, `instance`, `setup`, `frontmatter` or `client`)
  - `supported`

  It is pure and cheap. Call it in `metricsInputs`. The cache key covers it
  through the file content and `EMBEDDED_VERSION`.
- **One input per supported region.**
  - Mask everything outside the region with spaces, keeping line breaks, as
    `embeddedText()` does. That way line numbers are the original file's.
    Don't use `embeddedText` itself: it appends `\nexport {};\n`, which would
    add a code line. Export a masking helper without the suffix from
    `source.ts` and use it in both places.
  - Dialect: `ts` → `typescript`, `tsx` → `tsx`, `js`/`jsx` → `javascript`.
  - Unsupported regions (`lang="coffee"`, `src="…"`) are not measured. If no
    region is supported, skip the file with a reason.
  - If the facts carry a fatal issue, skip the file with that issue's reason.
- **Combine.**
  - The file's functions are the concatenation of each region's functions.
  - `lines` is the sum: regions never share lines in practice.
  - `syntaxErrors` is also summed.
- **Symbols.** Checked on a small sample: the TypeScript analyzer already
  creates function symbols in `.vue`, `.svelte` and `.astro` files, with
  original line numbers (`add` in `Cart.vue` 7–11, `bump` in a Svelte file,
  `label` in Astro frontmatter, `hello` in an Astro client script).
- **Matching pitfalls.** The embedded analyzer also creates:
  - a `component` entity spanning the whole file
    (`metadata.componentFile: true`)
  - one synthetic `function` per region, named `setup script`,
    `instance script`, `frontmatter script` or `client script N`
    (`metadata.role: 'script'`)
  - template handler functions, such as a Svelte `click event` on line 7–7

  Exclude the first two from matching explicitly. None of them should get
  metrics.
- **Top-level code** in `<script setup>` or the Svelte instance script is
  measured like a module's top level: not as a unit.
  - Callbacks there become units named by their call (`onMounted callback`,
    `$effect callback`).
  - A wrapped function named by its variable (`const total = computed(() =>
    …)`) is named `total`.
- **Spread language.** Functions count under the file's language (`vue`,
  `svelte`, `astro`), which is also what the Inspector compares with.
- **Fixture.** Write `sample.vue`, `sample.svelte` and `sample.astro` with the
  TypeScript sample's functions inside a script block, after a few template
  lines. The numbers must match `SHARED`. Also add:
  - a test that start lines are the original file's
  - a Vue file with `<script>` and `<script setup>` both present
  - an Astro file with frontmatter and a client script
- **Real code.**
  - `examples/tanstack-query` (20 `.vue`, 86 `.svelte`, 2 `.astro` files)
  - `koel/koel` (Laravel + Vue, close to Codiluce's main audience)
  - `withastro/starlight` (Astro)
  - `huntabyte/shadcn-svelte` (Svelte)

  Lizard can only cross-check Vue (`-l vue`).

## Phase 2: Java and Kotlin

**Java** (`.java`; grammar `java`)
- Functions:
  - `method_declaration` and `constructor_declaration`, with a body
  - `compact_constructor_declaration` (records)
  - `static_initializer`, named `static`
  - a field initialized with a lambda (`variable_declarator` inside a
    `field_declaration`)
- Anonymous: `lambda_expression`. Methods of an anonymous class
  (`object_creation_expression` with a `class_body`) are named functions.
- Scopes: `class_declaration`, `interface_declaration`, `enum_declaration`,
  `record_declaration`, `annotation_type_declaration`.
- Branches: `if_statement`, `for_statement`, `enhanced_for_statement`,
  `while_statement`, `do_statement`, `catch_clause`, `ternary_expression`,
  and `binary_expression` with `&&`/`||`. Switch arms are
  `switch_block_statement_group` and `switch_rule`, but not when their
  `switch_label` is `default`. Check how a group with several labels
  (`case A, B ->`) looks, and count labels as TypeScript counts fall-through
  cases.
- Nesting: if, the loops, `switch_expression` (used for switch statements
  too), `try_statement`, `try_with_resources_statement`,
  `synchronized_statement`.
- Else-if: `if_statement alternative: (if_statement)` → `@else_if`.
- Parameters: `formal_parameter` and `spread_parameter`, but not
  `receiver_parameter`. `inferred_parameters` and lambda identifiers belong to
  the lambda.
- Comments: `line_comment`, `block_comment`. Annotations: `annotation`,
  `marker_annotation`.

**Kotlin** (`.kt`, `.kts`; grammar `kotlin`, which has few fields, so read
the trees)
- Functions:
  - `function_declaration` with a `function_body`
  - `secondary_constructor`
  - `anonymous_initializer` (`init { }`)
  - `getter`/`setter` inside a `property_declaration`: one function named by
    the property
  - a property initialized with a lambda or an `anonymous_function`
- Anonymous: `lambda_literal`, `annotated_lambda` (trailing lambda) and
  `anonymous_function`. Name them by their call, as TypeScript does, so DSL
  blocks read `routing callback`.
- Scopes: `class_declaration` (interfaces and enums are this node too),
  `object_declaration`, `companion_object` (named `Companion` when it has no
  name).
- Branches: `if_expression`, `for_statement`, `while_statement`,
  `do_while_statement`, `catch_block`, and `binary_expression` with
  `&&`/`||`. Each `when_entry` counts except the `else ->` one. Elvis `?:`
  and `?.` don't count.
- Nesting: `if_expression`, the loops, `when_expression`, `try_expression`.
- Else-if: find how `else if` nests in this grammar and mark the inner
  `if_expression` as `@else_if`.
- Parameters: `parameter` in `function_value_parameters`, and
  `lambda_parameters` for lambdas. An extension receiver isn't one.
- Comments: `line_comment`, `block_comment`. Annotations: `annotation`.
- `.kts` Gradle scripts are skipped by Phase 0, item 12. Other `.kts` files
  are measured.

**Real code.**
- `spring-projects/spring-petclinic` and `apache/commons-lang` (Java)
- `square/okhttp` and `JetBrains/kotlinconf-app` (Kotlin)

Both languages have Lizard support.

## Phase 3: C#

`.cs` and `.csx`; grammar `csharp`.
- Functions:
  - `method_declaration` and `constructor_declaration` with a body or an
    `arrow_expression_clause`
  - destructors, operators and conversion operators: find their nodes in the
    trees
  - `local_function_statement`, a named nested unit
  - `property_declaration` whose `accessor_list` has an
    `accessor_declaration` with a body, or which has an
    `arrow_expression_clause`: one function named by the property. An
    auto-property is not a function. Indexers work the same way.
- Anonymous: `lambda_expression`, `anonymous_method_expression`.
- Scopes: class, struct, record and interface declarations.
- Branches: `if_statement`, `for_statement`, `foreach_statement`,
  `while_statement`, `do_statement`, `catch_clause`, `conditional_expression`,
  and `binary_expression` with `&&`/`||`. Also:
  - each `switch_section` except a section that is only `default:`. Check
    how a section with several `case` labels looks, and count labels.
  - each `switch_expression_arm` except a `discard` (`_`) arm
  - `catch_filter_clause` and `when_clause` add nothing (guards)
  - `??`, `?.` and `conditional_access_expression` don't count
- Nesting: if, the loops, `switch_statement`, `switch_expression`,
  `try_statement`, `using_statement`, `lock_statement`, `fixed_statement`.
- Else-if: `if_statement alternative: (if_statement)` → `@else_if`.
- Parameters: `parameter` in a `parameter_list`, except the first parameter
  of an extension method (a parameter with the `this` modifier). Lambda
  parameters belong to the lambda; there is also `implicit_parameter`.
- Comments: `comment`, including XML `///`. Attributes: `attribute_list`.
- Preprocessor `preproc_if`/`preproc_elif`/`preproc_else` don't count and
  don't nest. Code in every arm counts.
- Watch out for partial classes. Each declaration is its own symbol, which
  is fine: matching is per file.

**Real code:** `dotnet/eShop` and `jasontaylordev/CleanArchitecture`. Lizard
supports C#.

## Phase 4: Ruby (Rails)

Files: `.rb`, `.rake`, `.ru` and `Rakefile`; grammar `ruby`. Build scripts
are skipped (Phase 0, item 12). `.erb` templates are not measured.
- Functions:
  - `method`
  - `singleton_method` (`def self.find`), named `find` in its class, not
    `self.find`
  - a lambda assigned to a variable or constant
- Anonymous: `do_block` and `block` (as the `block` of a `call`, named by the
  call's `method`), and `lambda` (`-> { }`, `lambda { }`). At class level,
  Rails macros become units named by the call (`User.scope callback`).
  Check a `call` with a `do_block` in the trees to see how to capture the
  method name.
- Scopes: `class`, `module`. `singleton_class` (`class << self`) doesn't
  qualify the name.
- Branches:
  - `if`, `unless`, `elsif`, `while`, `until`, `for`
  - each `when`, and each `in_clause` (pattern matching); `case … else`
    doesn't count
  - each `rescue`
  - `conditional` (ternary)
  - `if_modifier`, `unless_modifier`, `while_modifier`, `until_modifier`,
    `rescue_modifier`
  - `binary` with `&&`, `||`, `and`, `or`
- Nesting:
  - `if`, `unless`, `while`, `until`, `for`, `case`, `case_match`, and
    `begin` when it has a `rescue`
  - not modifiers
  - not a method body with an implicit `rescue`: it isn't indented further
- Else-if: `elsif` is a clause inside its `if` (the `alternative` field). It
  is a branch and isn't in `@nesting`, as PHP's `elseif` already works.
- Parameters: the children of `method_parameters`, `block_parameters` and
  `lambda_parameters`:
  - `identifier`, `optional_parameter`, `splat_parameter`,
    `hash_splat_parameter`, `keyword_parameter`, `block_parameter`,
    `destructured_parameter`, `forward_parameter`
  - not block-local variables (`|x; y|`)
- Comments: `comment` (covers `=begin`). Closing keyword: `"end" @closing`
  for every block that ends with `end`.
- Endless methods (`def full_name = "…"`) are functions.

**Real code:** `mastodon/mastodon` (a Rails application) and `rubocop/rubocop`.
Lizard supports Ruby.

## Phase 5: Rust

`.rs`; grammar `rust`. The local clones `examples/ripgrep`,
`examples/axum` and `examples/ruff` are enough.
- Functions:
  - `function_item` with a body
  - functions inside `impl_item` are qualified by the impl's type
    (`Cart.add`, as Go receivers)
  - default methods in `trait_item` are qualified by the trait
  - a closure bound with `let`: `let_declaration` with a `closure_expression`
    value
- Anonymous: `closure_expression`, named by its call outside functions.
  `async_block` is not a function; its lines belong to the function around
  it.
- Scopes: `impl_item` (named by its type: take the type name without
  generics or references), `trait_item`. Don't use `mod_item` as a scope.
- Branches:
  - `if_expression`, which includes `if let` (`let_condition`)
  - `while_expression` (including `while let`), `for_expression`,
    `loop_expression`
  - each `match_arm` except one whose pattern is `_`
  - a `let_declaration` with an `alternative` (`let … else`)
  - `binary_expression` with `&&`/`||`
  - `let_chain` parts joined by `&&` count as `&&`
  - `?` (`try_expression`) doesn't count
- Nesting: if, the loops, `match_expression`. `unsafe_block` and
  `async_block` don't nest; they aren't control flow.
- Else-if: `else_clause (if_expression)` → `@else_if`.
- Parameters: `parameter` and `variadic_parameter`, but not `self_parameter`.
  `closure_parameters` belong to the closure.
- Comments: `line_comment` and `block_comment`, which cover `///` and `//!`
  doc comments. Attributes: `attribute_item`, `inner_attribute_item`.
- Macros: `macro_invocation` bodies are token trees, not code, so a `match`
  inside `println!` or `assert!` is invisible. That's accepted; write it
  down. Functions defined inside `macro_rules!` aren't measured.
- Inline tests (`#[cfg(test)] mod tests`, `#[test] fn`) count in the language
  spread, because `TEST_FILE` works on paths only. That's accepted for now;
  see Follow-ups.

Lizard supports Rust.

## Phase 6: C and C++

**C** (`.c`, and `.h` resolved to C; grammar `c`)
- Functions: `function_definition`. Its name sits in the declarator chain:
  `function_declarator declarator: (identifier)`, possibly inside
  `pointer_declarator` and parentheses for functions returning pointers.
  Capture every shape. Old K&R definitions should still parse; check one.
- Branches: `if_statement`, `for_statement`, `while_statement`,
  `do_statement`, `case_statement` (not `default:`; see how the grammar marks
  a default case), `conditional_expression`, and `binary_expression` with
  `&&`/`||`. `seh_except_clause` counts as a catch.
- Nesting: if, the loops, `switch_statement`, `seh_try_statement`.
- Else-if: `else_clause (if_statement)` → `@else_if`.
- Parameters: `parameter_declaration` and `variadic_parameter`, but not a
  lone `void`.
- Comments: `comment`.
- Preprocessor: `preproc_if`, `preproc_ifdef`, `preproc_elif` and
  `preproc_else` don't count and don't nest. Code in every arm counts.
  Function-like macros (`preproc_function_def`) aren't functions.
- Macros that break parsing give syntax errors. Phase 0 counts them, so the
  Inspector warns.

**C++** (`.cc`, `.cpp`, `.cxx`, `.hpp` and similar, and `.h` resolved to
C++; grammar `cpp`)
- Everything in C, plus:
  - Functions: methods defined in a class body (`function_definition` with
    a `field_identifier` declarator), and out-of-line definitions
    (`qualified_identifier`): the scope is the receiver, so `Cart::add` →
    `Cart.add`. Also constructors, destructors (`destructor_name`) and
    operators, and `template_declaration` around any of them.
    `default_method_clause` and `delete_method_clause` have no body and
    aren't functions.
  - Anonymous: `lambda_expression`.
  - Scopes: `class_specifier`, `struct_specifier`, `union_specifier`. Don't
    use `namespace_definition` as a scope.
  - Branches: also `for_range_loop` and `catch_clause`.
  - Nesting: also `for_range_loop` and `try_statement`.
  - Parameters: also `optional_parameter_declaration` and
    `variadic_parameter_declaration`.

**Real code:**
- C: `examples/jq`, `examples/curl`, `examples/git`
- C++: `nlohmann/json`, `google/leveldb`

Lizard supports both (`-l c`, `-l cpp`).

## Phase 7: Swift, Scala, Groovy

**Swift** (`.swift`; grammar `swift`)
- Functions:
  - `function_declaration` with a body
  - `init_declaration`, `deinit_declaration`, `subscript_declaration`
  - a `computed_property` (getter/setter/modify), or a `willset_didset_block`:
    one function named by the property
  - `protocol_function_declaration` without a body is not a function
- Anonymous: `lambda_literal`, including trailing closures.
- Scopes: `class_declaration` (classes, structs, enums, actors and
  extensions all use this node in this grammar; check), and
  `protocol_declaration`.
- Branches:
  - `if_statement` (including `if let`), `guard_statement`, `for_statement`,
    `while_statement`, `repeat_while_statement`
  - each `switch_entry` except `default` (`default_keyword`)
  - `catch_block`, `ternary_expression`
  - `conjunction_expression` (`&&`), `disjunction_expression` (`||`)
  - `nil_coalescing_expression` and `try?` don't count
- Nesting: if, guard, the loops, `switch_statement`, `do_statement` (do/catch).
- Parameters: `parameter`. Closure parameters belong to the closure.
- Comments: `comment`, `multiline_comment`. Attributes: `attribute`.

**Scala** (`.scala`, `.sc`; grammar `scala`; covers Scala 2 and 3 syntax)
- Functions:
  - `function_definition` (a `function_declaration` has no body)
  - auxiliary constructors (`def this`)
  - a `val_definition` with a `lambda_expression` value
- Anonymous: `lambda_expression`, and a `case_block` passed as an argument
  (a partial function).
- Scopes: `class_definition`, `object_definition`, `trait_definition`,
  `enum_definition`, `given_definition`. Look at `extension_definition` and
  decide whether it scopes.
- Branches:
  - `if_expression`, `while_expression`, `do_while_expression`
  - `for_expression`: count it as a loop, including `for … yield`
  - each `case_clause` except a wildcard `case _`; inside a `catch_clause`,
    each case counts as a catch
  - `infix_expression` with operator `&&`/`||`
  - `guard` adds nothing
- Nesting: if, the loops, `match_expression`, `try_expression`.
- Closing: `end_marker` → `@closing`.
- Parameters: `parameter` (each parameter list counts, for curried methods),
  `class_parameter` for constructors.
- Comments: `comment`, `block_comment`. Annotations: `annotation`.

**Groovy** (`.groovy`, `.gvy`, `.gy`; grammar `groovy`, a community
grammar, so read the trees carefully). Gradle files and `Jenkinsfile` are
skipped.
- Functions: `method_declaration` with a body, `constructor_declaration`, and
  a `closure` assigned to a variable. Spock feature methods have string names
  (`def "adds an item"()`); keep the string as the name.
- Anonymous: `closure`.
- Scopes: class, interface, enum, trait and record declarations.
- Branches:
  - `if_statement`, `for_statement`, `for_in_statement`, `while_statement`,
    `do_while_statement`
  - `switch_case` and `switch_arrow_case` (not `switch_default`)
  - `catch_clause`, `ternary_expression`
  - `binary_expression` with `&&`/`||`
  - `elvis_expression` doesn't count
- Nesting: if, the loops, `switch_expression`/`switch_block`,
  `try_statement`.
- Comments: `line_comment`, `block_comment`, `groovydoc_comment`.

**Real code:**
- Swift: `Alamofire/Alamofire`, `pointfreeco/swift-composable-architecture`
- Scala: `typelevel/cats`, `playframework/play-samples`
- Groovy: `spockframework/spock`, `grails/grails-core`

Lizard supports Swift and Scala, not Groovy.

## Phase 8: F# and VB.NET

**F#** (`.fs`, `.fsx`; grammar `fsharp`). `.fsi` signature files, grammar
`fsharp-signature`, have no bodies: don't measure them.
- Functions:
  - `function_or_value_defn` whose left side is a `function_declaration_left`
    (it has arguments)
  - a value whose body is a `fun_expression`
  - `member_defn` / `method_or_prop_defn`: methods and properties with
    code, named by the member without `this.`
  - `additional_constr_defn` (`new`)
- Anonymous: `fun_expression`, and `function_expression` (`function | … ->`),
  whose `rule`s count as arms.
- Scopes: `type_definition` (named by the type), nested `module_defn`.
- Branches:
  - `if_expression`, and `elif_expression`: a branch kept flat, like an
    else-if
  - each `rule` of a `match_expression` or `function_expression`, except a
    wildcard `_` rule
  - the `with` rules of a `try_expression`, each as a catch
  - `while_expression`, `for_expression`
  - `infix_expression` whose `infix_op` is `&&` or `||`
- Nesting: if, match, try, the loops. Computation expressions
  (`ce_expression`, `async { }`, `task { }`) don't nest; their lines belong
  to the function.
- Parameters: each curried argument pattern in the function's
  `argument_patterns`, with tuple elements counted one by one. The self
  identifier of `member this.X` isn't one.
- Comments: `line_comment`, `block_comment`, `xml_doc`.

**VB.NET** (`.vb`; grammar `vbnet` / `tree-sitter-vb_dotnet.wasm`)
- Checked on a sample: keywords such as `AndAlso`, `OrElse`, `Then`,
  `Else`, `End If` and `End Function` are hidden. `binary_expression` shows
  only `left` and `right` for logical operators. Phase 0 items 6 and 7 exist
  for this.
- Functions: `method_declaration` (Sub and Function), `constructor_declaration`
  (`Sub New`, named `New`), and a `property_declaration` with a
  `get_accessor` or `set_accessor`: one function named by the property.
- Anonymous: `lambda_expression`.
- Scopes: `class_block`, `module_block`, `structure_block`, `interface_block`.
- Branches:
  - `if_statement`, and `elseif_clause` (a branch, flat)
  - `for_statement`, `for_each_statement`, `while_statement`, `do_statement`
  - each `case_block`, but not `case_else_block`
  - `catch_block`
  - `ternary_expression` (`If(a, b, c)`)
  - `binary_expression` with `(#operator? @branch "AndAlso" "OrElse")`
- Nesting: if, the loops, `select_case_statement`, `try_statement`,
  `using_statement`, `sync_lock_statement`, `with_statement`.
- `@line` on `else_clause`, `case_else_block`, `try_statement`,
  `finally_block`, `catch_block` and `do_statement`: their keyword lines hold
  code.
- Parameters: `parameter` in a `parameter_list`; lambdas use
  `lambda_parameter`.
- Comments: `comment`. Attributes: `attribute_block`.
- Single-line `If x Then y`: check its tree; it should count as one branch
  and no nesting.

**Real code:**
- F#: `giraffe-fsharp/Giraffe`, `fsprojects/Paket`
- VB.NET: the VB folders of `dotnet/samples`. VB code is rare, so the
  fixture and hand checks matter more here.

Lizard supports neither.

## Phase 9: Objective-C

`.m`, and `.h` resolved to Objective-C; grammar `objective-c`
(`tree-sitter-objc.wasm`, a superset of C). Reuse the C query patterns.
- Functions:
  - `method_definition` inside `implementation_definition`, qualified by the
    class
  - C `function_definition`
  - Name: the method's selector, `addItem:count:`. If the query can't
    assemble a selector from its `keyword_declarator` parts, add a general
    engine rule: several `@name` captures in one match are joined in source
    order.
  - Check what `name` the structural symbols use, since names break ties.
    Matching by end line works either way.
- Anonymous: `block_literal` (`^{ }`).
- Scopes: the class of the implementation. A category
  `@implementation Cart (Extras)` qualifies as `Cart`.
- Branches: everything in C, plus `catch_clause` (`@catch`).
  `finally_clause` doesn't count.
- Nesting: everything in C, plus `try_statement` and `synchronized_statement`.
  Find what `@autoreleasepool` looks like; it doesn't nest.
- Parameters: `method_parameter`, one per keyword part. `self` and `_cmd`
  are implicit.
- **`.mm` files (Objective-C++).** The structural analyzer parses them with
  two grammars (`src/analysis/tree-sitter/objc-cpp.ts`). For metrics, a `.mm`
  file where `objectiveCppSource(content)` is true is skipped with
  "Objective-C++ is not measured yet". Others are measured as Objective-C.
  Mixed measuring is a follow-up.

**Real code:** `AFNetworking/AFNetworking`, `SDWebImage/SDWebImage`, and the
`.m` files in `examples/ollama`. Lizard supports Objective-C
(`-l objectivec`).

## Final phase: versions, text, documentation, verification

- **Versions.** Bump `CODE_HEALTH_VERSION` to `${METRICS_VERSION}:2`, once,
  when the work merges. This invalidates the working-tree cache (one full
  re-measure) and changes the history identity: users index the history
  again to see the new languages there. Say so in `docs/reference.md`.
- **UI text.**
  - `web/components/CodeHealth.tsx`: add labels to `LANGUAGE` (Vue, Svelte,
    Astro, Java, Kotlin, C#, Ruby, Rust, C, C++, Swift, Scala, Groovy, F#,
    VB.NET, Objective-C). Change the parameters title to "Declared
    parameters (not receivers such as self or this)".
  - Show the syntax-error note (Phase 0, item 9).
  - `web/lib/lenses.ts`: make the Complexity `basis` text say "…and their
    equivalents in each language".
- **Documentation.**
  - `docs/reference.md` "Code health" bullet: the language list, the new
    rules (unless/guard, default arms, guards, closing keywords,
    annotations, properties, receivers, preprocessor), components
    measuring script blocks only, and build scripts skipped.
  - `grammars/README.md` metrics paragraph: it still says the
    TypeScript/JavaScript/PHP grammars aren't shipped, which is outdated.
    List the measured languages.
  - The `measure.ts` header: every new capture and rule.
- **Package.** `scripts/test-package.mjs` checks that each grammar's
  `declarations.scm` is in the tarball. Make it check `metrics.scm` for every
  measured dialect too, and run `npm run test:package`.
- **Speed.** Index three repositories before and after the work (for
  example `examples/ripgrep`, `examples/jq` and a Java repository). Report
  the share of the first index that code health takes, and the time to
  index again.
- **Full checks:** `npm run typecheck`, then `npm test`. If any UI behavior
  changed, also run `npm run test:e2e`, in the worktree only.
- **Hand-check.**
  - Start scratch servers from the worktree, away from the live port 4300:
    `npm run codiluce -- serve --repo <repo> --state-dir <scratch>/state --port 4377 --ui none`
    for the API, and
    `CODILUCE_API=http://127.0.0.1:4377 npx next dev web --port 4378`
    for the map. `next dev` rewrites `web/next-env.d.ts`: restore it
    afterwards with `git checkout web/next-env.d.ts`, in the worktree only.
  - Open one repository per phase. Check Color by → Complexity and the
    Inspector's Code health section on a method, a property, a constructor,
    a component and a file with syntax errors.
  - Stop the servers by PID, not by pattern: a `pgrep -f` pattern once
    killed the agent's own shell.

## Out of scope (write down, don't build)

- **Template complexity** (`v-if`, `{#if}`, `{#each}`, Astro and JSX
  expressions in markup) and ERB, Razor and Liquid templates.
- **Mixed Objective-C++ measuring**, and macro expansion in C and C++.
- **Test functions inside source files** (Rust `#[test]`, `#[cfg(test)]`):
  a possible `@test` capture so they leave the language spread.
- **A worker thread** for measuring, explained to the user on 2026-10-15
  and not requested yet.

## Results log

Fill one row per language as it lands.

| Language | Repositories checked | Functions | Lizard equal / ±1 | Symbols matched | ms per 1k lines | Grammar load | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Vue | | | | | | | |
| Svelte | | | | | | | |
| Astro | | | | | | | |
| Java | | | | | | | |
| Kotlin | | | | | | | |
| C# | | | | | | | |
| Ruby | | | | | | | |
| Rust | | | | | | | |
| C | | | | | | | |
| C++ | | | | | | | |
| Swift | | | | | | | |
| Scala | | | | | | | |
| Groovy | | | | | | | |
| F# | | | | | | | |
| VB.NET | | | | | | | |
| Objective-C | | | | | | | |
