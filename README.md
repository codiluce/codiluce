# Archipelago

Code & Architecture Visualizer: a deterministic, evidenced software graph for Next.js + Laravel repositories and an interactive isometric map that projects it (spatial map, evidence inspector, lazy source, named flows stored by the server), plus Git history: every commit of a branch indexed as a versioned snapshot, browsable on a timeline and comparable as an architectural and source diff. Calls between symbols are resolved across both stacks (including frontend HTTP requests whose base URL is built in code, through axios instances and wrapper functions), down to the **database tables** the Laravel migrations declare, which gives every entity and every commit a **blast radius**, and every page, endpoint or function a **"what happens from here"** picture. Files carry their Git history (commits, authors, churn), and indexing again only re-analyzes the applications that changed. Phases 1–4 are implemented; the architecture and what remains (Phase 5: runtime ingestion, annotations) are in [docs/architecture-visualizer.md](docs/architecture-visualizer.md).

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

`index` keeps a bounded analysis cache in `<state>/cache/`: an application whose files did not change since the last index is replayed instead of analyzed (on Etengabe, an unchanged re-index takes ~3.5 s instead of ~11 s; editing one frontend file re-analyzes only the frontend). The cache is safe to delete; `index --no-cache` re-analyzes everything. Named flows are kept in `<state>/flows.db`, separate from the regenerated graph cache.

Generated state contains repository metadata, including file paths, symbols, routes, and diagnostics. Keep local state and inspection exports under `.archipelago/`, which is excluded by `.gitignore`. If you choose another state directory, add it to that workspace's `.gitignore` before publishing. Share only sanitized configuration examples.

## Visualizer

The map is a Next.js + React app in `web/`, statically exported to `web/out` and served by `serve` on the same origin as the API (which reads the graph and writes only named flows).

```bash
cd /var/www/html/archipelago
npm ci
npm run archipelago -- index --repo /var/www/html/etengabe.eus --state-dir .archipelago/etengabe
npm run build:web
npm run archipelago -- serve --repo /var/www/html/etengabe.eus --state-dir .archipelago/etengabe --port 4300
```

Open **http://127.0.0.1:4300/**. `serve` uses `web/out` automatically when it exists (`--ui PATH` chooses another build, `--ui none` serves only the API). Reindexing while the server runs is detected within ~30 s and the map offers a reload. Flows saved on the map are written to `<state>/flows.db`; `--read-only` makes the server write nothing.

UI development with hot reload uses two terminals: the `serve` command above (API on 4300), plus

```bash
npm run dev:web            # http://127.0.0.1:4310, proxies /api to ARCHIPELAGO_API (default http://127.0.0.1:4300)
```

### What the map does

- **Spatial map.** Native Canvas 2D, isometric 2.5D, one `<canvas>`; React renders only controls and panels. Drag/wheel/pinch or arrow keys and `+`/`−` pan and zoom; `F` fits; double-click zooms into an area. Rendering is device-pixel-ratio aware, culls off-screen boxes and has a per-frame primitive budget. Themes are data (`web/lib/themes.ts`): Midnight and Paper dock flat panels around sharp blocks; Sorbet and Sorbet Night (light and dark) float rounded glass panels over a pastel backdrop, draw rounded blocks with soft shadows on a dot grid, color files by language and use a rounded typeface (Nunito, bundled with the UI).
- **Stable layout.** Coordinates come from the server (`src/projection/layout.ts`), never from the browser: integer world rectangles from a deterministic bottom-up skyline packing with bucketed sizes and quantized row widths. Slot order is persisted per state directory in `layout.json`, so children added later are appended and removed children leave holes (compacted past 30% of a container). Selection, search, filters, panel size and loading order never move anything. Without `layout.json`, the same graph gives the same coordinates. Insertion stability comes from the persisted slots, not from sorting.
- **Projection districts.** Routes and endpoints are canonical children of their application. They are drawn in a dashed **Routes & endpoints** district inside that application (split by first path segment above 16 entries). Districts are projection-only (`projection:…` IDs), not graph entities, and breadcrumbs always show canonical ancestry.
- **Semantic zoom.** A container opens once it is larger than ~210 px on screen, and its children load on demand (pages of 500, capped at 3,000 per container). Labels change content by tier: applications show framework and counts; directories show files, measured lines and findings; files show language, lines and symbols; symbols show kind and signature. At the deepest level, a selected file or symbol draws its source on its own face. The status bar names the level (Applications → Directories & modules → Files → Symbols → Source) and the area at the center of the view.
- **Database.** Each Laravel application has a **Database** district: the tables its migrations declare, replayed in filename order (created, altered, renamed, dropped; columns with types, nullability, defaults; foreign keys) — the intended schema, never the live database. A table's inspector lists its columns, foreign keys and migrations (each opens its source). Eloquent models are `model` entities that map to their table (`$table`, else Laravel's naming convention, said so in the evidence); code that reads or writes through a model, a model instance or `DB::table('…')` gets `reads`/`writes` relationships to the table, and tables are linked by their foreign keys. A table's **Impact** is the code reading or writing it, the models and tables depending on it, and every endpoint and page that reaches them; a static flow can end at a table.
- **Git metrics.** A file's inspector shows how many commits changed it, by how many authors, its churn (lines added + deleted) and when it last changed, from one bounded `git log` (newest 10,000 commits, renames followed, merges not counted). Uncommitted edits are not in them; a file never committed shows "not measured".
- **Search & navigation.** Ranked search over indexed entities, with type facets (files, symbols, routes, endpoints, controllers, components…). Choosing a result inserts its ancestor chain, loads context, flies the camera there and selects it. Breadcrumbs, Back/Forward (`Alt+←/→`, `Backspace`) and `#id=` deep links are supported.
- **Relationships.** Hierarchy by default. On selection, incoming and outgoing relationships load with direction and type filters and are drawn as arcs. An endpoint that isn't drawn at the current zoom is reached through its nearest visible ancestor, drawn dashed, and explained in the inspector. Areas show boundary-crossing edges aggregated by visible ancestor, with counts and drill-down. Only indexed relations are shown: besides imports, routes and handlers these include resolved `calls`, `renders` and `references` (a function passed as a handler or callback), each listing every call site as evidence.
- **Inspector & provenance.** Type, canonical path, language, source range, metrics (absent ones say "not measured"), relevant metadata and HTTP calls. Every relationship has **Why?**, which lists its evidence (source, analyzer and version, confidence, file:line, explanation) and opens the supporting source. Unresolved findings are listed per entity and area, toggleable as map markers. Dynamic calls are drawn as a dangling "?" stub.
- **Lazy source.** `GET /api/source` reads bounded windows (≤400 lines, ≤256 KB) of indexed, analyzable files only. It is addressed by entity, relation evidence or diagnostic identity, never by path. It rejects traversal and symlinks and reports content changed since indexing (sha256 vs. index). The UI highlights syntax, the symbol range and evidence lines, and loads earlier or later windows.
- **Named flows.** Click entities (or "Add selection") to record ordered steps, then name and save them. Flows are stored by the server in `<state>/flows.db` (every browser using the server sees the same flows), as entity IDs only, through a persistence adapter (`web/lib/flows.ts`). Saving an edit that started from an older version is refused, the stored version is shown, and saving again replaces it. Flows an earlier version kept in this browser's `localStorage` move to the server the first time the map opens; with `serve --read-only` the server's flows can be shown and played but not changed (and new ones stay in this browser), and against a server without flow storage the browser keeps them. Showing a flow dims the rest of the map, numbers the steps and plays, pauses and restarts an indicator; the current step is inspected. A link between two steps is drawn solid only when an indexed relationship connects them, otherwise "declared order only". Steps missing after reindexing are flagged and skipped. A flow can also be built from a path: pick two entities and **Find path** fills the steps with the shortest chain of indexed relationships between them (a *static* flow, every link solid; editing its steps makes it declared). Flows are sequences, not observed executions.
- **Calls, effects and coverage.** A symbol's inspector lists its *effects* — what its own code does outside the indexed code: database reads/writes, responses with their HTTP status, network, storage, navigation, cache, mail, queue, events — each with the name it was matched on, and its *call sites*: how many were linked, left for the framework or packages (external), or stayed unresolved (callbacks, props, untyped values) with the names they call. In the source panel, lines where the selected symbol calls, renders or references something get a ◆ marker that jumps to the target.
- **Blast radius.** **Impact** on any entity (or area) walks what depends on it, hop by hop over calls, renders, references, handles, routes, requests and inheritance (files also follow imports); containment is never climbed, and an area seeds everything inside it. The map tints reached blocks by hop count (the number is drawn on each block), badges closed areas with "◎ N affected · H hops" and dims the rest; the inspector shows counts per hop, the endpoints, pages and applications reached, and every affected entity with the chain that reaches it (*Why?* on each hop). The result is labeled a lower bound: it says how many unresolved HTTP calls might also reach the endpoints, and which unresolved call sites call something with the same name (name-only, not proven). It follows the selection, its depth is adjustable (1–10, default 4) and the link carries it (`#id=…&impact=4`). In History's compare mode, *reach* shows what the commit's modified and removed entities reach, and toggles the same overlay.
- **What happens from here.** From a page, endpoint, component or function, the **Steps** panel draws what it sets in motion: *triggers* (functions bound to events: `onClick={save}`, or called from an inline handler), *actions* (code with effects or HTTP requests), *endpoints* the frontend reaches, the *handlers* they run, and *effects* — including every way a handler answers (`abort(404)`, `response()->json($user, 200)`, a FormRequest's 422). Plumbing in between is folded into each link as *via*; each link carries the event that fires it and the conditions it happens under, read from the source of the viewed snapshot (`if`/`else`, ternaries, `&&`, early returns, `switch`, `catch`), and every hop opens its evidence. The picture is capped (layers, steps, fan-out, folded hops; widely called helpers are dead ends) and says where. It is an outline in the left panel and a layered **Diagram**; clicking a step selects it on the map, double-clicking starts from it, and the map lights the steps and draws their links.

- **Request flows.** The **Requests** panel lists every HTTP request the index can follow — one per endpoint, plus requests no endpoint answers — grouped by application and path, with what was found (client, call, handler, data, response, back on the client) and how many gaps. Filters: *complete* (a page or event reaches a handler and a response, nothing unresolved), *partial*, *no caller* (endpoints no indexed code requests) and *unmatched*. Opening one shows it in lanes, left to right: the page or event handler, the HTTP call, the route, middleware and validation, the controller, services, models and tables, every response it can give (by status), and what the client does once the response is back (by source order). A request travels through it as an animation (paused with reduced motion); links carry their events and the conditions they run under; gaps are drawn as nodes that say what the index could not see (unresolved call sites with their names, a closure handler, a caller nothing calls, a request no endpoint matches). Clicking a step shows its links, their evidence and source; **Trace on map** lights the flow on the map and moves a request along it; **Save as flow** starts a named flow from its main path. The inspector opens an endpoint's flow, or lists the flows passing through any entity (e.g. a table).

### History: browse and compare commits

Index a branch's history, then open **History** in the map:

```bash
npm run archipelago -- history index --repo /var/www/html/etengabe.eus --state-dir .archipelago/etengabe   # first-parent history of the current branch
npm run archipelago -- history status --repo /var/www/html/etengabe.eus --state-dir .archipelago/etengabe
npm run archipelago -- serve --repo /var/www/html/etengabe.eus --state-dir .archipelago/etengabe --port 4300 [--history-indexing]
```

`history index` options: `--ref BRANCH` (default: the checked-out branch), `--limit N` (newest N commits), `--since DATE` (Git date syntax), `--commits SHA,SHA`, `--jobs N` (parallel analysis processes, default up to 6), `--all-parents`, `--pr-metadata github`. Commits that already have a snapshot under the current configuration and analyzer versions are skipped, so re-running after new commits only analyzes those. On the real Etengabe repository the 315 first-parent commits take ~3 min with 6 processes (call resolution type-checks each commit; ~90 s with analyzer 0.2.0); its largest commits take ~3 s each.

**What the map shows.** A timeline bar lists the branch's first-parent commits (solid ticks: indexed; faint: not yet indexed; diamonds: merges) over a sparkline of measured lines, ending in the live working tree. Drag or click it, use ◀ ▶, `[` `]` anywhere or ←/→ on the focused timeline; Home/End jump to the ends.
- *Snapshot* mode renders the system exactly as indexed at that commit.
- *Compare* mode (the default) compares the viewed snapshot with its predecessor: **added** entities and relationships in green, **removed** ones as translucent red ghosts in the place they used to occupy, **modified** in amber, **moved/renamed** in violet; a dotted rim marks entities whose relationships or findings changed while they did not. Labels carry +, −, ~ and → glyphs, so status never depends on color alone. Collapsed areas show counts of the changes inside them, and *Dim unchanged* fades the rest. **Pin** the baseline (or Shift+←/→ on the timeline) to compare any two commits.
- *Time-lapse.* Dragging the timeline shows every commit as you pass it, without waiting for the server; letting go loads that commit's full view (inspector, relationships, findings) in the same places. **▶** (or Space) plays the history from the commit on screen at 0.5–4× speed: new areas rise into place level by level, changed blocks flash in their status color, and with *Follow* the camera drifts toward where the changes happen (moving the map yourself turns it off). Pausing settles on the commit on screen.
- The inspector's overview summarizes the comparison: entity counts by status and type, files and lines, relationships and findings added/removed, identities followed across renames, applications and routes/endpoints that changed, and a filterable list of every changed entity. For a selected entity it shows the architectural diff: what changed (source, signature, declared facts, kind, size, rename, move), where it was before and how its identity was followed, changed facts before → after, line counts, relationships and findings added/removed (with *Why?* evidence from the snapshot they belong to), and whether evidence changed. **Source diff** opens a unified or side-by-side diff (optionally ignoring whitespace) of the entity's own source: a symbol's range, or a whole file. *History of this entity* lists the commits where it appeared, changed, moved or disappeared.
- Selections, search, relationships, flows, findings and source all follow the viewed snapshot. When an entity's ID changed between the views (a renamed file, a changed signature), the selection follows its lineage, in either direction of time. URLs carry the view (`#id=…&at=<sha>&vs=<sha>`).

**How it works.**
- *Versioned store.* `<state>/history.db` (SQLite, WAL) holds content-addressed versions of entities, relations and diagnostics and, per snapshot, membership rows pointing at them: an unchanged entity is stored once for all commits. A snapshot is an analysis run of one commit; its identity digests the configuration as written, the analyzer and schema versions and the application policy, so re-analysis under another configuration or analyzer creates a new snapshot instead of overwriting one (the timeline marks older ones *stale*).
- *Historical analysis.* Commits are materialized from Git objects (`git diff-tree` + `git cat-file --batch`) into scratch directories, applying only the difference between consecutive commits, and analyzed with the same pipeline as the working tree. Nothing is executed and the target repository is only read: no checkout, no `git worktree`, no index writes. Configured applications that do not exist at a commit are matched to the one autodetected application of the same framework there, keeping the configured name — e.g. Etengabe's `backend` lived at `api/` and `frontend` at `front/` before November 2025 — so their symbols keep their identities across the move.
- *Diff and lineage.* Comparisons classify entities by source hash (files: content; symbols: their declaration text), position-free described facts, signature, kind and parent. Canonical IDs are not weakened: a separate lineage maps old to new identities using Git rename detection for files, directory renames implied by them, symbols with the same qualified name or the same name-independent body fingerprint, and same-named entities in the mapped place (e.g. endpoints of a moved application). Relations are compared by endpoints (mapped through lineage) and type; findings ignore line numbers.
- *Timeline layout.* History views use one layout for the whole history: every container reserves a slot for each child it ever had, at that child's largest size, in first-appearance order, and renamed/moved entities inherit their predecessor's slot. Each snapshot draws only what exists then, in those places, so stepping between commits never moves anything (on Etengabe, 312 of 314 consecutive commit pairs keep every surviving entity in place; the other two are the `api/` → `backend/` restructuring). Comparison views lay out the union of both snapshots, which is why removed entities stay where they were. Leaving History returns to the compact live layout (`layout.json`).
- *Time-lapse frames.* `GET /api/history/evolution` returns every indexed commit as a frame of the timeline layout: the nodes that appear or disappear, their rectangles and measured lines, and what changed since the previous commit (removed entities stay one frame as ghosts). Frames are built with the same hierarchy and placement as the comparison views, so a frame and the settled view of its commit coincide. The server walks the timeline once through membership deltas (only versions that changed are read; commits that change no layout input reuse the previous rectangles) in the background, answering `202` with progress meanwhile, and keeps the result until the timeline changes: on Etengabe, 315 commits take ~5 s and ~300 KB gzip. The browser keeps a keyframe every 16 commits and turns any frame into a fully loaded scene in a few milliseconds.
- *Historical source.* Source for a commit snapshot is the Git blob of an indexed, analyzable file at that snapshot's commit — still addressed by entity/relation/diagnostic identity, never by a caller-supplied path or commit — with the same size and line bounds and a hash check against the index.
- *Pull requests.* Git records merges, not pull requests. Merge commits are shown as such; GitHub/GitLab merge and squash messages (`Merge pull request #N`, `(#N)`) give *unverified* PR markers, labeled as inferred. `--pr-metadata github` records merged pull requests from the GitHub API (set `GITHUB_TOKEN` for private repositories) as verified markers.
- *On-demand indexing.* With `serve --history-indexing`, clicking a commit without a snapshot offers *Index this commit*, which runs `history index` for that commit in a child process. It is the only non-GET route (`POST /api/history/index`), accepts only commits on the timeline, and requires a custom request header that browsers cannot send cross-origin without a preflight the server never grants. Without the flag the server stays read-only.

Limitations: the timeline follows first parents of one branch (other commits can be indexed with `--commits` and compared by snapshot ID through the API); the working tree includes untracked files that commits do not; lineage does not match a symbol that was renamed *and* edited in the same commit (it reads as removed + added); history views reserve space for everything that ever existed, so early commits look sparse.

### Flow API

- `GET /api/flows`: `{ storage, writable, flows }` for the indexed repository
- `POST /api/flows` (`{ id?, name, type, steps }`), `PUT /api/flows/:id` (`{ name, type, steps, revision }`; 409 with the stored flow when `revision` is stale), `DELETE /api/flows/:id`, `POST /api/flows/import` (`{ flows }`, keeps ids and dates, suffixes name clashes)

Writes require a JSON body, the `X-Archipelago-Request: flows` header (a cross-origin page cannot send it without a CORS preflight, which the server never grants), a loopback `Host` (no DNS rebinding) and no foreign `Origin`. `serve --read-only` refuses them.

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
- `GET /api/projection/impact/:id?depth&types&type&distance&offset&limit`: blast radius — hop count of every reached entity, per-area counts, highlights, what the walk cannot see, and a page of affected entities with the chain that reaches each
- `GET /api/projection/steps/:id`: what happens from an entity — typed steps, links with folded entities, hops and conditions read from source
- `GET /api/projection/request-flows?entity=ID`: every request flow (one per endpoint, and per entity whose requests no endpoint answers) with its status, stages and gap count; `entity` keeps those that draw it
- `GET /api/projection/request-flows/:id`: one request flow in lanes — nodes (entities, middleware, effects, responses, gaps), links with folded entities, hops and conditions read from source
- `GET /api/projection/path?from&to`: the shortest chain of indexed relationships between two entities (`reversed` when only the other direction exists)

Every route above (and `/api/entities/:id`, `/api/relations/:id`) accepts `snapshot=ID` (a history snapshot, or the live run's ID) and `compareTo=ID` (a baseline); node summaries then carry `change` (status, facets, previous ID/path/name, lineage reason) and, for areas, `changes` counts. History routes:

- `GET /api/history?ref`: first-parent timeline with snapshot, merge and pull request markers, plus the live working tree
- `GET /api/history/changes?snapshot&compareTo&status&type&offset&limit`: changed entities of a comparison
- `GET /api/history/change/:id?snapshot&compareTo`: one entity's architectural diff
- `GET /api/history/entity/:id?ref`: commits where an entity appeared, changed, moved or disappeared
- `GET /api/source/diff?entity&snapshot&compareTo[&whitespace=ignore&context=N]`: line diff of an entity's source
- `GET /api/history/impact?snapshot&compareTo&depth&…`: blast radius of a comparison, seeded by the entities the target modified or removed
- `POST /api/history/index` (only with `serve --history-indexing`)

Layout, projection and source modules live in `src/projection/`, history modules in `src/history/`, separate from analyzers. They read the SQLite caches and never write to them; only `layout.json` is written in the state directory (and `history.db` by `history index`).

## Inspect the graph

```bash
npm run archipelago -- inspect entities --repo /path/to/repository --state-dir .archipelago/example --search /auth/login --type api_endpoint
npm run archipelago -- inspect entities --repo /path/to/repository --state-dir .archipelago/example --search AuthController
npm run archipelago -- inspect diagnostics --repo /path/to/repository --state-dir .archipelago/example --code unresolved-http-call
npm run archipelago -- inspect entities --repo /path/to/repository --state-dir .archipelago/example --type database_table
npm run archipelago -- inspect flows --repo /path/to/repository --state-dir .archipelago/example
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

The server binds to loopback. Besides GET, it accepts only flow writes (above; off with `--read-only`) and, with `--history-indexing`, `POST /api/history/index`. It opens the graph cache read-only and queries it on each request, so subsequent successful indexing runs appear without restarting. There is still no whole-graph endpoint: the visualizer uses the bounded projection API above. The only source access is the identity-addressed `/api/source`.

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
    # Environment variables the frontend reads its API base URL from:
    apiOriginEnv:
      - NEXT_PUBLIC_API_URL
ignore:
  - "**/custom-generated/**"
maxFileBytes: 1048576
```

Ignore patterns support `*`, `**`, and `?` and extend safe defaults. Git-ignored content is pruned as well; tracked files still respect configured/default ignores. Symlinks are skipped. Repository-relative application paths must remain inside the repository and cannot overlap. Default repository identity is its configured name; set `repository.id` to distinguish repositories with identical names. Changing that namespace changes IDs. A cache rejects indexing a different repository identity into it.

`apiOrigins` proves which application owns an absolute origin. `apiOriginEnv` declares, on the application whose origin they hold, the environment variables code reads its base URL from; this is a configured assumption, and every request linked through one carries it as evidence. A request URL is linked when every value its base can take is proven: the analyzer follows template literals, concatenation, `const` bindings (also imported ones), class properties (every assignment in the class, e.g. `this.API_BASE_URL = getUrlFromEnv()`), local functions (every return, with arguments bound to parameters), `new URL(…)`, `.toString()`, `||`/`??` and conditionals, down to configured origins or declared variables. A dynamic value may fill a whole path segment (`users/${id}` matches only a route parameter, and a literal route that could also match makes it ambiguous) or sit in the query string; anything else — an unconfigured origin such as a forgotten `http://localhost:8000`, an undeclared variable, a callback parameter, a path made only of dynamic values — stays an `unresolved-http-call` whose reason names it. Relative requests from a Laravel application's own JavaScript reach that application (same origin); relative cross-stack requests are still reported as unverified until a proxy mapping can be determined.

## What is implemented

- Canonical graph, stable checkout-independent IDs, nonempty evidence, source ranges, validation, explicit unresolved diagnostics.
- Filesystem/application hierarchy, language, LOC, bytes and content hashes.
- TypeScript AST imports/re-exports, local/asset imports with tsconfig aliases, components containing JSX, functions/classes/methods, hook-name metadata, exports and server-module/action metadata.
- Next App Router page/layout/route conventions, parameter/group/slot routes, locally resolved exported HTTP handlers.
- PHP namespaces/imports/classes/methods/inheritance, Laravel route-file registration and configured API prefixes, static groups/includes, verbs/array/invokable/controller-group handlers.
- HTTP request matching in a separate phase, with ambiguity/origin/shadowing/constraint checks: literal URLs, URLs built from a proven base (configured origins, declared environment variables) and same-origin relative URLs, with dynamic whole segments matched only to route parameters.
- HTTP wrappers: axios instances (`axios.create({ baseURL })`, imported anywhere; base and path joined as axios joins them) and wrapper functions whose URL or method comes from their parameters (`postJson(url, body)`, `apiFetch(path, init)` with the method in `init`, nested wrappers): each call site the type checker resolves is evaluated with the parameters bound, and becomes a request of its caller, with the wrapper and every hop as evidence. Call sites that do not resolve are findings on their callers.
- Laravel database schema from migrations: tables (columns, renames, drops, conditional columns, connections), foreign keys, Eloquent models mapped to tables (explicit `$table` or convention), and `reads`/`writes` from methods to tables.
- Per-file Git metrics (commits, authors, churn, last change), and a bounded per-application analysis cache for re-indexing.
- Calls, renders and references. TypeScript: one type-checked program per application over its indexed files and the compiler's own lib files only (never `node_modules`, so the live index and history snapshots resolve identically), covering calls, `new`, static methods, singletons (`X.getInstance().m()`), JSX renders, handler and callback references, functions wrapped in `useCallback`, class fields holding functions, and functions destructured from a hook's returned object. PHP: `$this`, `self`/`static`/`parent`, `new X`, typed parameters, typed and constructor-promoted properties, single-class locals, `app(X::class)` and declared return types, through inheritance. Every other call site is counted per symbol (`callSites`: resolved, external, unresolved with names).
- Effects matched on resolved names (`effects`): Laravel facades by their imported class or global alias, Eloquent queries and writes on classes whose `extends` chain reaches an Eloquent base, framework helpers (`abort`, `response()`, `redirect`, `view`, `dispatch`, `event`), framework exceptions and FormRequest validation with their HTTP status, implicit controller responses; DOM storage and `window.location`, Next navigation (`useRouter`, `redirect`, `notFound`), `Response`/`NextResponse`, and network calls marked with the endpoint they reach. `callSites` and `effects` are derived metadata: they do not make an entity read as changed in history.
- Projection queries over the graph: blast radius (per entity, per comparison), steps with conditions read from source at request time, shortest paths.
- Atomic SQLite replacement, preserved analysis-run/snapshot headers, normalized evidence and metrics, bounded CLI/API inspection.
- Named flows stored on the server (`flows.db`): revisions with conflict detection, import of browser-kept flows, guarded writes, read-only mode; `inspect flows` lists them.

- Historical snapshots: first-parent commit indexing into a content-addressed versioned store, lineage-aware architectural diffs, timeline-stable layout, Git-blob source and source diffs (see *History* above).

The fixture chain proves **page /account → AccountPanel (onClick) → handleSave → AccountService.getInstance().signIn() → POST /auth/login (base URL from `getUrlFromEnv()` and `NEXT_PUBLIC_API_URL`) → AuthController::login → AuthService::authenticate → reads table users (model User, `$table = 'users'`, declared by a migration)**. On the real Etengabe index (configured with its API origins and `NEXT_PUBLIC_API_URL`), frontend requests linked to Laravel endpoints went from 0 to 53 (two through an HTTP wrapper) and unresolved HTTP calls from 68 to 14, with 2,571 calls, 1,102 renders and 422 references resolved; its migrations declare 62 tables with 48 foreign keys, 48 of its 57 models map to one (the others name legacy tables no migration creates), and 295 reads and 233 writes link its code to them. `AuthService.login → POST /auth/login → AuthController::login → users` is one chain, from frontend code to a table. The live index (`archipelago.db`) keeps one current snapshot; past states live in `history.db`.

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
- Indexing Etengabe (5k entities, ~300 TypeScript files per application) takes ~9–11 s with type-checked call resolution, migrations and Git metrics (TypeScript ~5 s, PHP ~1.3 s, Git ~1.1 s, filesystem ~1.5 s); indexing it again unchanged takes ~3.5 s from the analysis cache (1.2 MB). Its blast radius queries take ~10 ms and a Steps picture of a busy page (~60 steps) ~150 ms.

History tests run against a scripted Git history (`tests/history-fixture.ts`: an edit, an addition, a file replaced by a directory, a Git rename, a signature change, a removed route, and the backend application moved to another directory). They cover idempotent content-addressed indexing, the tree mirror against `git ls-tree`, application relocation, diff classification and lineage, ghosts and change counts, selection carry-over in both directions of time, timeline-layout stability and non-overlap, blob-backed source and diffs, entity history, the HTTP surface, on-demand indexing, PR markers, and the store's timeline navigation; browser tests step through commits and check that nothing moves.

Fixtures cover both stacks, HTTP provenance (literal, proven base through a singleton service and an environment variable, same-origin, template segments, axios instances, wrapper functions with URL and method from their parameters, nested wrappers, unresolvable wrappers), migrations (create, alter, rename, drop, conditional columns, both foreign-key forms, dynamic names), model mappings (explicit and convention) and table reads/writes, Git metrics across a rename, the analysis cache (replay identical to a fresh index after PHP edits, TypeScript edits and new files; bounds; corrupt entries), the flow store and its routes (revisions, conflicts, import, write guards, read-only), call resolution and its coverage counts, effects with response statuses, unresolved calls, ambiguous routes, ignored/generated content, binary/large files, parse failures, stable identities across indexing and relocation, SQLite rollback, and bounded read-only API queries. Visualizer tests cover deterministic and insertion-local layout, projection districts, world/screen transforms, LOD visibility and culling, hit testing, aggregation, deep search navigation, stale-request cancellation, evidence→source navigation, source path/range/symlink/staleness restrictions, flow persistence and playback, blast radius (cross-stack distances and chains, containers, possible callers, commit impact), steps (kinds, folding, conditions, caps), paths and static flows, condition reading for TypeScript and PHP, and the main browser interactions. No lint configuration exists in this workspace. Target application builds/tests are unaffected by this tool's implementation.
