# Archipelago

Code & Architecture Visualizer: a deterministic, evidenced software graph for Next.js + Laravel repositories (Phase 1) and an interactive isometric map that projects it (Phases 3–4: spatial map, evidence inspector, lazy source, named flows), plus Git history: every commit of a branch indexed as a versioned snapshot, browsable on a timeline and comparable as an architectural and source diff. The architecture and remaining phases are in [docs/architecture-visualizer.md](docs/architecture-visualizer.md).

The primary command is `npm run archipelago -- …`. Generated state uses `.archipelago/` and `archipelago.db`.

## Run against a repository

Requires Node >=22.12. The scripts enable the built-in SQLite API for the installed Node version.

```bash
cd /path/to/archipelago
npm ci
npm run archipelago -- init --repo /path/to/repository --state-dir .archipelago/example
npm run archipelago -- index --repo /path/to/repository --state-dir .archipelago/example
npm run archipelago -- inspect summary --repo /path/to/repository --state-dir .archipelago/example
npm run archipelago -- serve --repo /path/to/repository --state-dir .archipelago/example --port 4300
```

Open **http://127.0.0.1:4300/api** for the endpoint directory, or **http://127.0.0.1:4300/api/summary** for index counts/diagnostics. The cache/configuration stays in this tool workspace; target application code is untouched. Omit `--state-dir` to use `<repository>/.archipelago/` instead. `init` preserves existing config and database; `index` also works without init using autodetection.

Generated state contains repository metadata, including file paths, symbols, routes, and diagnostics. Keep local state and inspection exports under `.archipelago/`, which is excluded by `.gitignore`. If you choose another state directory, add it to that workspace's `.gitignore` before publishing. Share only sanitized configuration examples.

## Visualizer

The map is a Next.js + React app in `web/`, statically exported to `web/out` and served by `serve` on the same origin as the read-only API.

```bash
cd /var/www/html/archipelago
npm ci
npm run archipelago -- index --repo /var/www/html/etengabe.eus --state-dir .archipelago/etengabe
npm run build:web
npm run archipelago -- serve --repo /var/www/html/etengabe.eus --state-dir .archipelago/etengabe --port 4300
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

### History: browse and compare commits

Index a branch's history, then open **History** in the map:

```bash
npm run archipelago -- history index --repo /var/www/html/etengabe.eus --state-dir .archipelago/etengabe   # first-parent history of the current branch
npm run archipelago -- history status --repo /var/www/html/etengabe.eus --state-dir .archipelago/etengabe
npm run archipelago -- serve --repo /var/www/html/etengabe.eus --state-dir .archipelago/etengabe --port 4300 [--history-indexing]
```

`history index` options: `--ref BRANCH` (default: the checked-out branch), `--limit N` (newest N commits), `--since DATE` (Git date syntax), `--commits SHA,SHA`, `--jobs N` (parallel analysis processes, default up to 6), `--all-parents`, `--pr-metadata github`. Commits that already have a snapshot under the current configuration and analyzer versions are skipped, so re-running after new commits only analyzes those. On the real Etengabe repository the 315 first-parent commits take ~90 s with 6 processes and ~83 MB in `history.db`; a later commit takes ~1.5 s.

**What the map shows.** A timeline bar lists the branch's first-parent commits (solid ticks: indexed; faint: not yet indexed; diamonds: merges) over a sparkline of measured lines, ending in the live working tree. Drag or click it, use ◀ ▶, `[` `]` anywhere or ←/→ on the focused timeline; Home/End jump to the ends.
- *Snapshot* mode renders the system exactly as indexed at that commit.
- *Compare* mode (the default) compares the viewed snapshot with its predecessor: **added** entities and relationships in green, **removed** ones as translucent red ghosts in the place they used to occupy, **modified** in amber, **moved/renamed** in violet; a dotted rim marks entities whose relationships or findings changed while they did not. Labels carry +, −, ~ and → glyphs, so status never depends on color alone. Collapsed areas show counts of the changes inside them, and *Dim unchanged* fades the rest. **Pin** the baseline (or Shift+←/→ on the timeline) to compare any two commits.
- The inspector's overview summarizes the comparison: entity counts by status and type, files and lines, relationships and findings added/removed, identities followed across renames, applications and routes/endpoints that changed, and a filterable list of every changed entity. For a selected entity it shows the architectural diff: what changed (source, signature, declared facts, kind, size, rename, move), where it was before and how its identity was followed, changed facts before → after, line counts, relationships and findings added/removed (with *Why?* evidence from the snapshot they belong to), and whether evidence changed. **Source diff** opens a unified or side-by-side diff (optionally ignoring whitespace) of the entity's own source: a symbol's range, or a whole file. *History of this entity* lists the commits where it appeared, changed, moved or disappeared.
- Selections, search, relationships, flows, findings and source all follow the viewed snapshot. When an entity's ID changed between the views (a renamed file, a changed signature), the selection follows its lineage, in either direction of time. URLs carry the view (`#id=…&at=<sha>&vs=<sha>`).

**How it works.**
- *Versioned store.* `<state>/history.db` (SQLite, WAL) holds content-addressed versions of entities, relations and diagnostics and, per snapshot, membership rows pointing at them: an unchanged entity is stored once for all commits. A snapshot is an analysis run of one commit; its identity digests the configuration as written, the analyzer and schema versions and the application policy, so re-analysis under another configuration or analyzer creates a new snapshot instead of overwriting one (the timeline marks older ones *stale*).
- *Historical analysis.* Commits are materialized from Git objects (`git diff-tree` + `git cat-file --batch`) into scratch directories, applying only the difference between consecutive commits, and analyzed with the same pipeline as the working tree. Nothing is executed and the target repository is only read: no checkout, no `git worktree`, no index writes. Configured applications that do not exist at a commit are matched to the one autodetected application of the same framework there, keeping the configured name — e.g. Etengabe's `backend` lived at `api/` and `frontend` at `front/` before November 2025 — so their symbols keep their identities across the move.
- *Diff and lineage.* Comparisons classify entities by source hash (files: content; symbols: their declaration text), position-free described facts, signature, kind and parent. Canonical IDs are not weakened: a separate lineage maps old to new identities using Git rename detection for files, directory renames implied by them, symbols with the same qualified name or the same name-independent body fingerprint, and same-named entities in the mapped place (e.g. endpoints of a moved application). Relations are compared by endpoints (mapped through lineage) and type; findings ignore line numbers.
- *Timeline layout.* History views use one layout for the whole history: every container reserves a slot for each child it ever had, at that child's largest size, in first-appearance order, and renamed/moved entities inherit their predecessor's slot. Each snapshot draws only what exists then, in those places, so stepping between commits never moves anything (on Etengabe, 312 of 314 consecutive commit pairs keep every surviving entity in place; the other two are the `api/` → `backend/` restructuring). Comparison views lay out the union of both snapshots, which is why removed entities stay where they were. Leaving History returns to the compact live layout (`layout.json`).
- *Historical source.* Source for a commit snapshot is the Git blob of an indexed, analyzable file at that snapshot's commit — still addressed by entity/relation/diagnostic identity, never by a caller-supplied path or commit — with the same size and line bounds and a hash check against the index.
- *Pull requests.* Git records merges, not pull requests. Merge commits are shown as such; GitHub/GitLab merge and squash messages (`Merge pull request #N`, `(#N)`) give *unverified* PR markers, labeled as inferred. `--pr-metadata github` records merged pull requests from the GitHub API (set `GITHUB_TOKEN` for private repositories) as verified markers.
- *On-demand indexing.* With `serve --history-indexing`, clicking a commit without a snapshot offers *Index this commit*, which runs `history index` for that commit in a child process. It is the only non-GET route (`POST /api/history/index`), accepts only commits on the timeline, and requires a custom request header that browsers cannot send cross-origin without a preflight the server never grants. Without the flag the server stays read-only.

Limitations: the timeline follows first parents of one branch (other commits can be indexed with `--commits` and compared by snapshot ID through the API); the working tree includes untracked files that commits do not; lineage does not match a symbol that was renamed *and* edited in the same commit (it reads as removed + added); history views reserve space for everything that ever existed, so early commits look sparse.

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
- `GET /api/source?entity=ID | relation=ID&evidence=N | diagnostic=ID [&start&end] [&side=baseline]`
- `GET /api/projection/resolve/:id?from=SNAPSHOT`: the ID an entity has in this view (lineage-mapped when its ID changed)

Every route above (and `/api/entities/:id`, `/api/relations/:id`) accepts `snapshot=ID` (a history snapshot, or the live run's ID) and `compareTo=ID` (a baseline); node summaries then carry `change` (status, facets, previous ID/path/name, lineage reason) and, for areas, `changes` counts. History routes:

- `GET /api/history?ref`: first-parent timeline with snapshot, merge and pull request markers, plus the live working tree
- `GET /api/history/changes?snapshot&compareTo&status&type&offset&limit`: changed entities of a comparison
- `GET /api/history/change/:id?snapshot&compareTo`: one entity's architectural diff
- `GET /api/history/entity/:id?ref`: commits where an entity appeared, changed, moved or disappeared
- `GET /api/source/diff?entity&snapshot&compareTo[&whitespace=ignore&context=N]`: line diff of an entity's source
- `POST /api/history/index` (only with `serve --history-indexing`)

Layout, projection and source modules live in `src/projection/`, history modules in `src/history/`, separate from analyzers. They read the SQLite caches and never write to them; only `layout.json` is written in the state directory (and `history.db` by `history index`).

## Inspect the graph

```bash
npm run archipelago -- inspect entities --repo /path/to/repository --state-dir .archipelago/example --search /auth/login --type api_endpoint
npm run archipelago -- inspect entities --repo /path/to/repository --state-dir .archipelago/example --search AuthController
npm run archipelago -- inspect diagnostics --repo /path/to/repository --state-dir .archipelago/example --code unresolved-http-call
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
sqlite3 .archipelago/example/archipelago.db 'SELECT type, count(*) FROM entities GROUP BY type;'
sqlite3 .archipelago/example/archipelago.db 'SELECT code, count(*) FROM diagnostics GROUP BY code;'
```

## Configuration

`init` autodetects Next/Laravel manifest roots (through two directory levels). Explicit applications override detection. `.archipelago/config.yml` can contain:

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

- Historical snapshots: first-parent commit indexing into a content-addressed versioned store, lineage-aware architectural diffs, timeline-stable layout, Git-blob source and source diffs (see *History* above).

The fixture chain proves **frontend login function → POST /auth/login → AuthController::login**. Requests built through a dynamic `this.API_BASE_URL` remain unresolved. On the real Etengabe index, `POST /auth/login → AuthController::login` is a verified `handles` relationship, and the frontend `AuthService.login` call stays an `unresolved-http-call`. Model/table queries, call/render edges and per-file Git churn metrics are later phases. The live index (`archipelago.db`) keeps one current snapshot; past states live in `history.db`.

`index` exits **0** for a graph with no analyzer errors, **2** when parse/config analyzer errors are persisted, and **1** for fatal/configuration/storage failures. Warnings remain inspectable. A fatal scan or write failure preserves the previous successful graph.

## Verify

```bash
npm test            # engine, projection/layout/source and frontend unit/integration tests (Node test runner)
npm run typecheck   # engine and web
npm run build       # engine (tsc) and static UI (next build)
npm run test:e2e    # Playwright browser tests against the indexed fixture repository and a scripted Git history (builds the UI first)
```

Browser tests use Playwright's Chromium. Run `npx playwright install chromium` once if it is not cached.

Measured (not a guarantee), Node 22 on this workstation:
- A synthetic 101k-entity / 151k-relation hierarchy builds its projection index in ~0.4 s and its layout in ~1.1 s, with ~164 MB server heap. Re-layout from persisted state is identical.
- Client visibility over a 20k-node loaded scene takes <0.5 ms per frame.
- On the real Etengabe map (5k entities), headless Chromium renders 90–310 visible primitives at 60 fps while panning.
- Browser rendering of a 100k-entity repository has not been measured.

History tests run against a scripted Git history (`tests/history-fixture.ts`: an edit, an addition, a file replaced by a directory, a Git rename, a signature change, a removed route, and the backend application moved to another directory). They cover idempotent content-addressed indexing, the tree mirror against `git ls-tree`, application relocation, diff classification and lineage, ghosts and change counts, selection carry-over in both directions of time, timeline-layout stability and non-overlap, blob-backed source and diffs, entity history, the HTTP surface, on-demand indexing, PR markers, and the store's timeline navigation; browser tests step through commits and check that nothing moves.

Fixtures cover both stacks, HTTP provenance, unresolved calls, ambiguous routes, ignored/generated content, binary/large files, parse failures, stable identities across indexing and relocation, SQLite rollback, and bounded read-only API queries. Visualizer tests cover deterministic and insertion-local layout, projection districts, world/screen transforms, LOD visibility and culling, hit testing, aggregation, deep search navigation, stale-request cancellation, evidence→source navigation, source path/range/symlink/staleness restrictions, flow persistence and playback, and the main browser interactions. No lint configuration exists in this workspace. Target application builds/tests are unaffected by this tool's implementation.
