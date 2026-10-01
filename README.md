# Archipelago

Code & Architecture Visualizer: a deterministic, evidenced software graph for Next.js + Laravel repositories (Phase 1) and an interactive isometric map that projects it (Phases 3–4: spatial map, evidence inspector, lazy source, named flows). The architecture and remaining phases are in [docs/architecture-visualizer.md](docs/architecture-visualizer.md).

The primary command is `npm run archipelago -- …`. `npm run atlas -- …` remains a compatibility alias. Generated state continues to use `.atlas/` and `atlas.db` so existing indexes remain usable.

## Run against a repository

Requires Node >=22.12. The scripts enable the built-in SQLite API for the installed Node version.

```bash
cd /path/to/archipelago
npm ci
npm run archipelago -- init --repo /path/to/repository --state-dir .atlas/example
npm run archipelago -- index --repo /path/to/repository --state-dir .atlas/example
npm run archipelago -- inspect summary --repo /path/to/repository --state-dir .atlas/example
npm run archipelago -- serve --repo /path/to/repository --state-dir .atlas/example --port 4300
```

Open **http://127.0.0.1:4300/api** for the endpoint directory, or **http://127.0.0.1:4300/api/summary** for index counts/diagnostics. The cache/configuration stays in this tool workspace; target application code is untouched. Omit `--state-dir` to use `<repository>/.atlas/` instead. `init` preserves existing config and database; `index` also works without init using autodetection.

Generated state contains repository metadata, including file paths, symbols, routes, and diagnostics. Keep local state and inspection exports under `.atlas/`, which is excluded by `.gitignore`. If you choose another state directory, add it to that workspace's `.gitignore` before publishing. Share only sanitized configuration examples.

## Visualizer

The map is a Next.js + React app in `web/`, statically exported to `web/out` and served by `serve` on the same origin as the read-only API.

```bash
cd /var/www/html/archipelago
npm ci
npm run archipelago -- index --repo /var/www/html/etengabe.eus --state-dir .atlas/etengabe
npm run build:web
npm run archipelago -- serve --repo /var/www/html/etengabe.eus --state-dir .atlas/etengabe --port 4300
```

Open **http://127.0.0.1:4300/**. `serve` uses `web/out` automatically when it exists (`--ui PATH` chooses another build, `--ui none` serves only the API). Reindexing while the server runs is detected within ~30 s and the map offers a reload.

UI development with hot reload uses two terminals: the `serve` command above (API on 4300), plus

```bash
npm run dev:web            # http://127.0.0.1:4310, proxies /api to ARCHIPELAGO_API (default http://127.0.0.1:4300)
```

### What the map does

- **Spatial map.** Native Canvas 2D, isometric 2.5D, one `<canvas>`; React renders only controls and panels. Drag/wheel/pinch or arrow keys and `+`/`−` pan and zoom; `F` fits; double-click zooms into an area. Rendering is device-pixel-ratio aware, culls off-screen boxes and has a per-frame primitive budget. Themes are data (`web/lib/themes.ts`: Midnight, Paper).
- **Stable layout.** Coordinates come from the server (`src/projection/layout.ts`), never from the browser: integer world rectangles from a deterministic bottom-up skyline packing with bucketed sizes and quantized row widths. Slot order is persisted per state directory in `layout.json`, so children added later are appended and removed children leave holes (compacted past 30% of a container). Selection, search, filters, panel size and loading order never move anything. Without `layout.json`, the same graph gives the same coordinates. Insertion stability comes from the persisted slots, not from sorting.
- **Projection districts.** Routes and endpoints are canonical children of their application. They are drawn in a dashed **Routes & endpoints** district inside that application (split by first path segment above 16 entries). Districts are projection-only (`projection:…` IDs), not graph entities, and breadcrumbs always show canonical ancestry.
- **Semantic zoom.** A container opens once it is larger than ~210 px on screen, and its children load on demand (pages of 500, capped at 3,000 per container). Labels change content by tier: applications show framework and counts; directories show files, measured lines and findings; files show language, lines and symbols; symbols show kind and signature. At the deepest level, a selected file or symbol draws its source on its own face. The status bar names the level (Applications → Directories & modules → Files → Symbols → Source) and the area at the center of the view. There is no Database area: no table entities are indexed, and the legend says so.
- **Search & navigation.** Ranked search over indexed entities, with type facets (files, symbols, routes, endpoints, controllers, components…). Choosing a result inserts its ancestor chain, loads context, flies the camera there and selects it. Breadcrumbs, Back/Forward (`Alt+←/→`, `Backspace`) and `#id=` deep links are supported.
- **Relationships.** Hierarchy by default. On selection, incoming and outgoing relationships load with direction and type filters and are drawn as arcs. An endpoint that isn't drawn at the current zoom is reached through its nearest visible ancestor, drawn dashed, and explained in the inspector. Areas show boundary-crossing edges aggregated by visible ancestor, with counts and drill-down. Only indexed relations are shown.
- **Inspector & provenance.** Type, canonical path, language, source range, metrics (absent ones say "not measured"), relevant metadata and HTTP calls. Every relationship has **Why?**, which lists its evidence (source, analyzer and version, confidence, file:line, explanation) and opens the supporting source. Unresolved findings are listed per entity and area, toggleable as map markers. Dynamic calls are drawn as a dangling "?" stub.
- **Lazy source.** `GET /api/source` reads bounded windows (≤400 lines, ≤256 KB) of indexed, analyzable files only. It is addressed by entity, relation evidence or diagnostic identity, never by path. It rejects traversal and symlinks and reports content changed since indexing (sha256 vs. index). The UI highlights syntax, the symbol range and evidence lines, and loads earlier or later windows.
- **Named flows.** Click entities (or "Add selection") to record ordered steps, then name and save them. Flows are stored in `localStorage` per repository identity, through a small adapter (`web/lib/flows.ts`), as entity IDs only. Showing a flow dims the rest of the map, numbers the steps and plays, pauses and restarts an indicator; the current step is inspected. A link between two steps is drawn solid only when an indexed relationship connects them, otherwise "declared order only". Steps missing after reindexing are flagged and skipped. Flows are declared sequences, not observed executions.

### Projection API (read-only, bounded)

- `GET /api/projection`: run, root summary, layout info, counts, coverage
- `GET /api/projection/children/:id?offset&limit`: spatial children with world rects, in slot order
- `GET /api/projection/nodes?ids=a,b`: summaries for up to 200 IDs
- `GET /api/projection/locate/:id`: node, spatial ancestors, canonical ancestors
- `GET /api/projection/search?q&type&limit&offset`: ranked entity search with type counts
- `GET /api/projection/relations/:id?direction&type&limit&offset`: non-containment relations with endpoint summaries/ancestry
- `GET /api/projection/aggregate/:id` and `/aggregate/:id/edges?anchor&type&direction`: boundary edges grouped by the other side's visible ancestor, and their members
- `GET /api/projection/diagnostics/:id`: findings in a node's subtree (or a symbol's source range)
- `GET /api/projection/between?a&b`: relations directly connecting two entities
- `GET /api/source?entity=ID | relation=ID&evidence=N | diagnostic=ID [&start&end]`

Layout, projection and source modules live in `src/projection/`, separate from analyzers. They read the SQLite cache and never write to it; only `layout.json` is written in the state directory.

## Inspect the graph

```bash
npm run archipelago -- inspect entities --repo /path/to/repository --state-dir .atlas/example --search /auth/login --type api_endpoint
npm run archipelago -- inspect entities --repo /path/to/repository --state-dir .atlas/example --search AuthController
npm run archipelago -- inspect diagnostics --repo /path/to/repository --state-dir .atlas/example --code unresolved-http-call
```

Use returned IDs with `inspect entity --id ID`, `inspect relations --id ID --direction outgoing --type handles`, and `inspect relation --id ID`. Entity and relation **details** include complete evidence; **lists** intentionally omit evidence/large entity metadata. Pagination defaults to 100, caps at 500, and returns `hasMore`.

The equivalent HTTP endpoints are:

- `GET /api/summary`
- `GET /api/entities?search=login&type=method&limit=100&offset=0`
- `GET /api/entities/:id`
- `GET /api/entities/:id/children`
- `GET /api/entities/:id/relations?direction=outgoing&type=handles`
- `GET /api/relations/:id`
- `GET /api/diagnostics?severity=warning&code=unresolved-http-call`

The server binds to loopback and accepts GET only. It opens the cache read-only and queries it on each request, so subsequent successful indexing runs appear without restarting. There is still no whole-graph endpoint: the visualizer uses the bounded projection API above. The only source access is the identity-addressed `/api/source`.

SQLite can also be inspected directly:

```bash
sqlite3 .atlas/example/atlas.db 'SELECT type, count(*) FROM entities GROUP BY type;'
sqlite3 .atlas/example/atlas.db 'SELECT code, count(*) FROM diagnostics GROUP BY code;'
```

## Configuration

`init` autodetects Next/Laravel manifest roots (through two directory levels). Explicit applications override detection. `.atlas/config.yml` can contain:

```yaml
repository:
  name: example-repository
  # Optional stable namespace shared across renamed/relocated checkouts:
  # id: my-example-repository
applications:
  - name: frontend
    path: frontend
    type: nextjs
  - name: backend
    path: backend
    type: laravel
    apiOrigins:
      - https://api.example.test
ignore:
  - "**/custom-generated/**"
maxFileBytes: 1048576
```

Ignore patterns support `*`, `**`, and `?` and extend safe defaults. Git-ignored content is pruned as well; tracked files still respect configured/default ignores. Symlinks are skipped. Repository-relative application paths must remain inside the repository and cannot overlap. Default repository identity is its configured name; set `repository.id` to distinguish repositories with identical names. Changing that namespace changes IDs. A cache rejects indexing a different repository identity into it.

`apiOrigins` proves which application owns an absolute literal origin; it does **not** evaluate environment variables or dynamic base URL expressions. Relative cross-stack requests are reported as unverified until a proxy mapping can be determined.

## What is implemented

- Canonical graph, stable checkout-independent IDs, nonempty evidence, source ranges, validation, explicit unresolved diagnostics.
- Filesystem/application hierarchy, language, LOC, bytes and content hashes.
- TypeScript AST imports/re-exports, local/asset imports with tsconfig aliases, components containing JSX, functions/classes/methods, hook-name metadata, exports and server-module/action metadata.
- Next App Router page/layout/route conventions, parameter/group/slot routes, locally resolved exported HTTP handlers.
- PHP namespaces/imports/classes/methods/inheritance, Laravel route-file registration and configured API prefixes, static groups/includes, verbs/array/invokable/controller-group handlers.
- Literal HTTP request matching in a separate phase, with ambiguity/origin/shadowing/constraint checks.
- Atomic SQLite replacement, preserved analysis-run/snapshot headers, normalized evidence and metrics, bounded CLI/API inspection.

The fixture chain proves **frontend login function → POST /auth/login → AuthController::login**. Requests built through a dynamic `this.API_BASE_URL` remain unresolved. On the real Etengabe index, `POST /auth/login → AuthController::login` is a verified `handles` relationship, and the frontend `AuthService.login` call stays an `unresolved-http-call`. Model/table queries, call/render edges and Git file churn/history are later phases. Snapshot headers record indexing history; previous entity versions are not retained.

`index` exits **0** for a graph with no analyzer errors, **2** when parse/config analyzer errors are persisted, and **1** for fatal/configuration/storage failures. Warnings remain inspectable. A fatal scan or write failure preserves the previous successful graph.

## Verify

```bash
npm test            # engine, projection/layout/source and frontend unit/integration tests (Node test runner)
npm run typecheck   # engine and web
npm run build       # engine (tsc) and static UI (next build)
npm run test:e2e    # Playwright browser tests against the indexed fixture repository (builds the UI first)
```

Browser tests use Playwright's Chromium. Run `npx playwright install chromium` once if it is not cached.

Measured (not a guarantee), Node 22 on this workstation:
- A synthetic 101k-entity / 151k-relation hierarchy builds its projection index in ~0.4 s and its layout in ~1.1 s, with ~164 MB server heap. Re-layout from persisted state is identical.
- Client visibility over a 20k-node loaded scene takes <0.5 ms per frame.
- On the real Etengabe map (5k entities), headless Chromium renders 90–310 visible primitives at 60 fps while panning.
- Browser rendering of a 100k-entity repository has not been measured.

Fixtures cover both stacks, HTTP provenance, unresolved calls, ambiguous routes, ignored/generated content, binary/large files, parse failures, stable identities across indexing and relocation, SQLite rollback, and bounded read-only API queries. Visualizer tests cover deterministic and insertion-local layout, projection districts, world/screen transforms, LOD visibility and culling, hit testing, aggregation, deep search navigation, stale-request cancellation, evidence→source navigation, source path/range/symlink/staleness restrictions, flow persistence and playback, and the main browser interactions. No lint configuration exists in this workspace. Target application builds/tests are unaffected by this tool's implementation.
