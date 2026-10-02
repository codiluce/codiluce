# Archipelago — Code & Architecture Visualizer

Archipelago is the project name and the npm command is `archipelago`.

## 1. Supported repository structure

Archipelago supports repositories containing Next.js and Laravel applications. A typical repository uses the following structure:

- `frontend/`: Next.js, React, TypeScript, Sass; App Router under `src/app`, components under `src/components`, HTTP wrappers under `src/services`, hooks under `src/hooks`. A common `tsconfig.json` alias maps `@/*` to `./src/*`.
- `backend/`: Laravel / PHP, Composer PSR-4 `App\\` → `app/`. Routes under `routes/`; controllers in `app/Http/Controllers`, Eloquent models in `app/Models`, services in `app/Services`, migrations in `database/migrations`.
- Laravel applications may also contain Inertia/React/Vite assets under `resources/`. Those files remain part of the Laravel application.
- `backend/bootstrap/app.php` can register API routes with a custom prefix, including **`apiPrefix: ''`**. The analyzer reads the configured prefix rather than assuming `/api`.
- Analysis does not read credentials, connect to the application database, or invoke target application scripts. The index describes the working tree, with HEAD and dirty state recorded separately.
- The test fixture proves a login chain: frontend login function → `POST /auth/login` → `AuthController::login`. Model/table relationships and requests built through dynamic base URLs are deferred to later phases.

## 2. Proposed architecture and location

Keep the tool in this separate workspace. It accepts a target repository path; default generated configuration/cache lives in `<target>/.archipelago/`, with `--state-dir` allowing all generated files to live outside that repository. No Laravel boot, Artisan invocation, database access, or application code mutation is required.

Use a TypeScript engine with these actual boundaries:

```text
src/core/       graph types, graph builder, identities, configuration
src/analyzers/ filesystem, TypeScript/Next.js, PHP/Laravel
src/pipeline/  ordered indexing and independent API matching
src/storage/   SQLite schema, transactions, bounded queries
src/api/       read-only HTTP inspection API
src/cli.ts     init, index, inspect, serve
tests/         fixture repositories and integration tests
```

The future Next.js UI will consume query/projection APIs; neither analyzers nor storage depend on React. A graph is canonical; layout, LOD, selection, and source rendering are projections. No AI inference in Phase 1.

## 3. Canonical graph schema

`SoftwareGraph` has a schema version, repository identity, entities, relations, diagnostics, and analysis-run metadata. Every entity and relation has nonempty evidence. Evidence has `source`, `confidence`, `analyzer`, `analyzerVersion`, optional repository-relative file, source range, commit, and explanation. Confidence does not replace provenance.

Entity types include repository, application, domain, directory, file, component, class, function, method, route, api_endpoint, controller, model, database_table, external_service, test, and user_flow. Hooks are functions with `role: hook`. Each entity has `id`, `type`, `name`, optional path/language/parent/source range, metadata, and optional metrics. Relations include contains, imports, exports, calls, renders, references, routes_to, handles, requests, reads, writes, queries, maps_to, extends, implements, observed_call, part_of_flow, and changed_with. `handles` points **endpoint → handler** consistently. `calls`, `renders` and `references` (a function passed as a value: an event handler, a callback) keep one relation per (from, to, type) with every site as evidence (up to 25) and `metadata.sites/lines/forms/events`. Symbols carry derived metadata: `callSites` (resolved, external, unresolved, unresolved names) and `effects` (category, operation, detail, line, status, target, the name matched on); both are excluded from the entity's shape hash, so their changes read as relationship changes, not as the entity changing.

IDs are hashes of repository namespace + entity identity, never absolute checkout paths or line numbers. Files initially use repository-relative paths. PHP symbols use application + fully qualified name + normalized parameter signature. TypeScript symbols use application + module-relative path + lexical qualified name + normalized parameter signature; module path is necessary because TS has module-scoped, not globally qualified, symbols. Signature changes change IDs. Symbols record declaration fingerprints (`contentHash` of the declaration text, `bodyHash` of the whitespace-normalized text after the name); history comparisons use them, with Git rename detection, for a separate lineage mapping that never rewrites canonical IDs (§13). Relation IDs use endpoints + relation kind + a semantic discriminator where needed; repeated references merge evidence.

Diagnostics are first-class records: analyzer, severity, code, file/line, `resolution: unresolved`, reason, and optional entity. Parse failures are errors, are persisted, and produce a nonzero CLI status after successful cache writing. Unresolved expressions never create invented edges.

Flow and annotation types exist separately from structural facts. Flow steps reference entity IDs and optional relation IDs; observed flows can include trace IDs and timing. Annotations contain provider/kind/value/confidence and never overwrite entity facts. Runs/snapshots include commit, dirty state, timestamp, config digest, schema version, and analyzer versions. Historical commits are stored as versioned snapshots in a separate store (§13).

## 4. Analyzer pipeline

1. Resolve and validate configuration; autodetect application manifests without executing them.
2. Scan sorted directories, prune ignored subtrees, create containment hierarchy and file metadata.
3. Build one TypeScript program per application over its indexed TypeScript/JavaScript files (`src/analyzers/ts-program.ts`); declare symbols per file, resolve local imports with the application tsconfig, then resolve calls, renders and references with the type checker (`ts-references.ts`) and evaluate request URLs (`ts-url.ts`).
4. Parse PHP with `php-parser`, collect namespaces/classes/methods, walk registered Laravel route files and statically evaluable includes/groups, then resolve method calls and effects (`php-references.ts`).
5. Independently match HTTP observations — literal URLs and URLs built from a proven base — to candidate endpoints. Unmatched/ambiguous/unproven calls remain diagnostics.
6. Validate IDs, references, parents, evidence, confidence and containment cycles.
7. Persist one generated snapshot atomically. Inspection queries load only bounded result sets.

Analyzers implement `analyze(context): Promise<void>` against an analysis context with a graph builder and scanned-file inventory. They do not access rendering or SQLite. This straightforward interface avoids a generic plugin framework before multiple language implementations exist.

## 5. Next.js extraction strategy

Recognize `app` or `src/app` route conventions. `page.tsx` creates a UI route; `layout.tsx` records its route scope; `route.ts` exposes endpoints only for exported HTTP methods. Strip route groups and parallel-slot segments, translate `[id]`, `[...slug]`, `[[...slug]]`, and diagnose unsupported intercepted route syntax. Store original filesystem segments so route inference can be explained.

Use AST nodes for imports/re-exports, exported symbols, functions, classes, methods, hooks, and JSX-producing functions/components. Source ranges and LOC come from parsed text. JSX output identifies components; capitalization alone does not prove a React component. File imports link to indexed local files; external imports are file metadata rather than unbounded external symbol expansion. Calls, renders and references are resolved by the type checker of the application's program (§14); the program sees only indexed files and the compiler's lib files, never `node_modules`.

Phase 1 detects direct `fetch` and imported axios calls; accepts only literal URLs and literal/default methods without dynamic option overrides. Local bindings/shadowed HTTP identifiers are excluded. Dynamic expressions, unresolved wrappers, unsupported axios forms, malformed files, and local imports that cannot resolve receive diagnostics. Exact asset imports (including Sass) use indexed paths and explicit tsconfig aliases when TypeScript's module resolver cannot resolve them. Relative literal paths can match same-application Next endpoints; cross-application relative URLs remain structural candidates until a proxy/origin is proven. Absolute URLs require explicit `apiOrigins` association. Queries are stripped for matching; segment parameters match literal segments; multiple matching endpoints remain ambiguous. No wildcard replacement of arbitrary JavaScript expressions.

Server-action directives and exports are recorded as metadata. A URL that is not literal is evaluated to a proven base (§7). Imported wrapper clients (`axios.create`), Pages Router, and server-action call graphs are not resolved.

## 6. Laravel extraction strategy

Parse namespaces and `use` imports, named classes, inheritance, controller declarations and method parameter signatures. Resolve imported/fully qualified controller names without executing PHP. All PHP files remain hierarchy nodes; basic symbol extraction covers `app`, routes, services, jobs, events, middleware, commands, and migration files.

Read `bootstrap/app.php` AST for registered web/API route files and literal API prefixes, anchored to unconditional `Illuminate\\Foundation\\Application::configure()` builder expressions. Support standard route verbs, match/any, nested prefix/middleware/name groups, array controller actions, controller groups, invokable classes, and route-file `require`/`include` with literal `__DIR__` concatenation. Closures and arrow functions remain endpoints with closure-handler metadata. Unsupported resource registration, conditional registration, dynamic prefixes/controllers/URIs/includes, domain routing, and constraints are explicit diagnostics rather than silently guessed. Constraints must be considered before declaring HTTP matches exact. A coverage diagnostic explains that package/provider and implicit health routes are outside this inventory.

Method calls through declared types and Eloquent operations are resolved (§14). Table mappings and migrations/foreign keys remain to be added. Explicit `$table` wins; convention mappings carry framework-convention provenance. Never claim migrations describe the live database. Framework metadata from an optional explicit `route:list --json` export can enrich static results later, but the default indexer never boots application code.

## 7. Frontend/backend API matching

Collect HTTP request observations with caller entity, method, URL/expression, source range and resolution. The matcher is independent of analyzers and only creates `requests` when the method, path, origin association and route candidate are supported. Match each HTTP verb and ordered path segments; account for parameter names without asserting a dynamic URL is resolved. A known literal request matching conflicting web/API routes receives an ambiguity diagnostic. Preserve both request and route evidence on the edge. A relative URL that happens to match Laravel is insufficient to prove the frontend host forwards it: it receives `unverified-relative-api-boundary` instead. Next rewrite/proxy extraction is deferred.

Explicit `apiOrigins` can associate an origin such as `https://api.example.test` with the backend, and `apiOriginEnv` declares environment variables that hold an application's origin (a configured assumption, recorded as evidence). A non-literal URL is evaluated through templates, concatenation, `const` bindings, class properties (every assignment), local functions (every return, with argument binding), `new URL`, `.toString()`, `||`/`??` and conditionals into alternatives made of text, *holes* (dynamic values) and proven origins. Every alternative must reach the same application and path pattern; holes may fill whole path segments (matched only to route parameters; a literal route that could match them makes the request ambiguous) or sit after `?`. The proof's hops become evidence on the `requests` edge. Relative URLs from a Laravel application's own scripts reach that application (same origin).

## 8. Spatial and LOD strategy (later phases)

Use deterministic hierarchical rectangles, initially ordered by stable IDs with fixed/persisted slots and bounded weights. Sort order alone guarantees repeatability, not insertion stability; persisted positions and localized subdivision address that separately. Layout is versioned outside the graph and never changes identities.

LOD 0: applications/database/external areas. LOD 1–2: configured domains or directories. LOD 3: files. LOD 4: symbols. LOD 5: lazy source fragments. Start with native Canvas 2D, one React canvas component and an indexed hit-test structure; measure before adopting Pixi/WebGL. No React component per primitive. Hierarchy/viewport queries and aggregated selected-edge queries avoid sending the whole graph. Hierarchy is the default, selection exposes filtered incoming/outgoing edges, and breadcrumbs preserve context.

### Implemented visualizer (Phases 3–4, first iteration)

- **Location:** `web/` (Next.js App Router, React, TypeScript, statically exported and served by `archipelago serve`). Server-side projection lives in `src/projection/` (`hierarchy.ts`, `layout.ts`, `service.ts`, `source.ts`, `dto.ts`), with routes in `src/api/projection-routes.ts`. Analyzers and storage are unchanged.
- **Layout:** computed on the server per analysis run, from a compact in-memory hierarchy index (no metadata blobs), and cached until the run changes. Children are packed bottom-up with a skyline packer over integer, bucketed sizes. Several quantized row widths are scored, plus exact side-by-side fits of the largest children. Slot order is persisted in `<state-dir>/layout.json` (versioned): first layouts seed slots largest-first (files and classes keep source order), later additions append, and removals leave holes until compacted. A container's own size still changes when its content crosses a bucket or width step, which moves later siblings. Changes are local, not zero.
- **Projection groups:** `route`/`api_endpoint` entities whose canonical parent is an application are placed in a synthetic `projection:routes:<appId>` district (split by first path segment above 16). Groups are flagged `kind: group`, carry an explanation, are excluded from search and breadcrumbs, and never become entities.
- **Client:** `web/lib/` separates camera/isometric transforms (`camera.ts`), LOD rules (`lod.ts`), the loaded-node cache with culling, budget and hit testing (`scene.ts`), Canvas drawing (`renderer.ts`), themes (`themes.ts`), input and animation (`controller.ts`), state and request cancellation (`store.ts`), and flows and playback (`flows.ts`, `playback.ts`). Hit testing scans the culled, budgeted visible set back to front. The client never holds more than the opened parts of the hierarchy.
- **Flows:** browser `localStorage`, per repository identity, through an adapter. Steps are entity IDs (engine `Flow`/`FlowStep`, `type: 'declared'`). Server-side flow tables remain future work.

## 9. SQLite schema

Use built-in `node:sqlite` on Node >=22.12; npm scripts supply the experimental flag required by the installed runtime. Store schema version with `PRAGMA user_version` and reject unknown versions. Foreign keys are enabled. No Neo4j or separate DB server.

- `analysis_runs`: ID, repository ID/name, commit SHA, dirty state, analysis time, configuration digest, schema version and analyzer versions.
- `repository_snapshots`: snapshot/run/repository identity and commit; marks working-tree snapshots. Each successful index replaces the current generated graph transactionally; run headers survive. Full versioned entity history is deferred.
- `entities`: ID/type/name/path/language/parent, source range, metadata JSON; indexes on parent/type/path/name.
- `relations`: ID/from/to/type/metadata JSON; indexes on both endpoints/type.
- `evidence`: entity or relation owner, provenance JSON, indexed by owner; owner references enforced.
- `metrics`: entity FK and JSON metrics.
- `diagnostics`: analyzer, severity, code, file/line, entity, resolution/reason.
- `flows`, `flow_steps`, `annotations`: separate graph overlays. Phase 1 defines types, but tables/editing ship with the flow phase, avoiding empty speculative storage.

Use a transaction for replace/validate/write: a failed index leaves the previous graph available. The cache can be deleted and regenerated. Inspection opens SQLite read-only. Source text is not stored wholesale; a future source endpoint must verify repository containment, indexed paths and bounded ranges before reading files.

## 10. Testing strategy

Node's test runner and TypeScript fixtures; no UI tests in Phase 1. Fixture repository includes Next pages/groups/dynamic segments/layout/API handlers, JSX components, alias imports/re-exports, literal and dynamic HTTP calls, Laravel imports/groups/bootstrap/custom prefix/controller handlers, malformed code, ignored folders, and binary files.

Assert expected contains/imports/routes_to/handles/requests chains and exact evidence ranges; all dangling relationships/cycles/duplicate identities are rejected. Repeated runs and relocated checkouts must generate identical entity/relation IDs. Test transaction rollback, SQLite round trips, bounded search/hierarchy/neighborhood APIs, and config path constraints. Later phases add service/model/migration chains and deterministic/local-change layout tests.

After each phase run `npm test`, `npm run typecheck`, `npm run build`, and index a representative target repository. No linter is introduced only for scaffolding. Target build/tests are not run because its application code is unchanged.

## 11. Implementation phases

1. **This task:** documented architecture; configuration/autodetection; filesystem graph; basic TypeScript/Next.js symbols/imports/routes/HTTP observations; basic Laravel classes/routes/controller methods; SQLite; CLI/API inspection; deterministic integration fixtures and real indexing verification. Small literal API matcher validates the separation early.
2. Cross-stack correctness: typed calls/render relationships, base URL resolution, Eloquent operations and the complete login chain are implemented (§14); wrapper clients, models/migrations as entities, Git file metrics and bounded analyzer caching remain.
3. Spatial map: independent deterministic layout, viewport/LOD API, Next/React Canvas renderer, pan/zoom/search/breadcrumbs, evidence inspector and lazy highlighted source.
4. Named manual flows and playback; flow overlay persistence; verify all milestone interactions against the real application.
5. History (implemented, §13): first-parent commit snapshots, lineage-aware diffs, timeline layout and source diffs. Optional runtime ingestion and annotations only after the first vertical slice is reliable. No instrumentation, AI classification, cloud/collaboration or distributed indexing now.

## 12. Known limitations

Phase 1 is an inspectable structural graph, not the finished spatial visualizer. No runtime behavior or live database schema is asserted. Working-tree scan includes untracked nonignored files and reports dirty state. No automatic domains, per-file Git churn metrics, model/table extraction or incremental parsing yet. Scanner skips symlinks, secret-like files, generated outputs, large files and binary LOC with reasons. Each application gets one TypeScript program (parsed source files are cached per process by path and text, so history workers reparse only changed files); calls through callbacks, props, untyped values and interface dispatch stay unresolved and are counted, not linked.

Static Laravel extraction cannot prove registration inside arbitrary conditions/service providers, evaluate macros, or emulate resource transformations and route constraints. Diagnostics expose these gaps. TS detection does not resolve arbitrary metaprogramming or imported wrapper HTTP calls. The live cache keeps one current snapshot; history lives in `history.db` (§13).

References: [TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API), [PHP AST parser](https://github.com/glayzzle/php-parser), [installed Node SQLite API](https://nodejs.org/download/release/v22.12.0/docs/api/sqlite.html).

## 13. History

```text
Git commits (+ optional GitHub PR records)
      ↓  history index: materialize each commit from Git objects, run the same analyzers
Versioned snapshot store (history.db): content-addressed versions + per-snapshot membership
      ↓  snapshot sources (live archipelago.db, or a stored commit)
Snapshot-aware projection + diff (lineage, union with ghosts, timeline layout)
      ↓
Timeline / map / inspector diff / source diff
```

- **Store.** `entity_versions`, `relation_versions` and `diagnostic_versions` hold each distinct record once (keyed by a canonical-JSON hash; diagnostics by their content-derived ID); `snapshot_entities/relations/diagnostics` are integer membership rows. Entity versions also carry the columns the projection needs plus `content_key` (source hash, or size for unread files), `body_hash` and `shape_hash` (described facts without positions), so a snapshot loads without parsing JSON. A snapshot is one analysis run of one commit; `(commit, identity)` is unique, where identity digests the written configuration, analyzer and schema versions and the application policy.
- **Revisions.** `TreeMirror` writes a commit's tree into a scratch directory from `git diff-tree` and `git cat-file --batch`, then applies only the next commit's difference (symlinks as symlinks, submodules as empty directories). The filesystem analyzer skips the ignored-file inventory there (only tracked files exist). Configured applications missing at a revision are matched to the single autodetected application of the same framework, keeping the configured name so symbol identities continue. Workers are child processes over contiguous commit ranges; the parent owns the store.
- **Diff.** `computeDiff(baseline, target, renames)` classifies through lineage: `added`, `removed` (ghost, re-parented into union IDs), `moved` (renamed or reparented, including a changed path), `modified` (source, described facts, signature, kind, size) or `unchanged` with `relations`/`diagnostics` facets. Relations compare by mapped `(from, to, type)` (analyzers use no discriminators); diagnostics by code, severity, owner, mapped file and reason, ignoring lines.
- **Lineage.** Git renames (files), directory renames implied by them (path-suffix votes), symbols by type + qualified name under the mapped parent (or anywhere when PHP-qualified or body-confirmed), by unique name-independent body fingerprint, and remaining entities by type + name under the mapped parent, pairing equal same-named groups in source order.
- **Layout.** The live view keeps `layout.json`. History views use a timeline registry built at index time (per container, every child slot in first-appearance order; per slot, the largest weight; aliases from consecutive-commit lineage) and packed once; snapshots are placed in those slots, containers shrink to their current extent. Snapshots outside the registry (e.g. the working tree) extend it in memory.
- **Source.** Commit snapshots read the Git blob of the indexed file at their own commit (`ls-tree` validation: regular file, size bound), and diffs run Myers' algorithm on the two versions (symbol ranges or whole files), bounded in edit distance and output size.

## 14. Calls, blast radius and steps

```text
analyzers: calls / renders / references (+ evidence per site), callSites, effects
      ↓  projection index (any snapshot or comparison)
impact.ts  — dependents, hop by hop            steps.ts — what an anchor sets in motion
      ↓                                              ↓  conditions.ts (source of the viewed snapshot)
inspector + map overlay, commit reach          Steps outline / diagram, map highlight
```

- **Call resolution.** An edge exists only when a site resolves to a declaration that is an indexed entity. TypeScript uses `getResolvedSignature`/symbols of the application's program, following aliases, `useCallback`-wrapped functions, class fields holding functions and properties of objects returned by hooks (`const { logout } = useAuth()`). PHP types receivers from declarations only (see §6). Sites that reach lib globals, packages or framework classes count as external; callback parameters, props, untyped values and interface dispatch count as unresolved, with the called names. Name-only matching never creates an edge.
- **Effects** are matched on resolved names, never on text alone: an imported facade class or its global alias, a class whose `extends` chain reaches an Eloquent base, a lib global (`localStorage`, `window.location`, `Response`), an import from the framework (`next/navigation`, `next/server`). Responses carry literal statuses (`abort(404)`, `response()->json($x, 201)`, framework exceptions, FormRequest validation 422, implicit controller returns 200).
- **Blast radius** (`impact.ts`). Every relation reads "from depends on to", so dependents are the `from` side of incoming relations. Symbols follow symbol-level types (calls, renders, references, handles, routes_to, requests, extends, implements), files follow imports and re-exports; containment is not climbed; a container seeds everything inside it. Breadth-first by hop count, bounded by depth (≤10) and 5,000 entities, first-reach relation kept per entity for the chain. A comparison seeds the entities the target modified (own facets: source, definition, signature, type, size) or removed, files only when no symbol inside them changed, and also walks relations removed since the baseline. Unknowns are reported: unresolved HTTP findings when an endpoint is reached, and unresolved call sites whose called name equals a seed's name.
- **Steps** (`steps.ts`). Forward over routes_to, renders, calls, references, requests and handles. A node is a step when it is the anchor, a page route, an endpoint, an endpoint's handler, a trigger (reached by a handler reference or a call carrying an event), or an action (effects or outgoing requests); effects are steps of their own (network effects already linked to an endpoint are drawn as the endpoint). Other nodes are folded into the link (`via`, at most 6). Caps: 8 layers, 60 steps, 14 links per step, helpers with more than 40 callers are not followed; each cap is reported on its step. Links carry the relation chain; the service adds each hop's first site line and the guards there.
- **Conditions** (`conditions.ts`) are read at request time from the snapshot's own source (Git blob for commits), from the node at the site line (hinted by the called name) up to the owner's boundary: `if`/`else`, ternaries, `&&`/`||`, `switch` cases, `catch`, and early exits in enclosing blocks. Nothing is stored; an unparseable file gives no guards.
- **Paths** are the shortest forward chain over step relations plus imports/exports/inheritance (or the reverse direction, flagged), used to build static flows.
