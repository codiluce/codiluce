# Codiluce example repositories

20 public GitHub repositories cloned locally on **2026-10-08** for testing Codiluce against real source code, different languages, workspace layouts, contributor histories, and architectural changes. The set includes production applications and libraries, plus one official full-stack template.

Only this `readme.md` is eligible to be tracked by the parent repository. Every other item under `examples/`, including the nested repositories, download logs, and analysis output, is ignored by the root `.gitignore`. Each clone also excludes its own `.codiluce/` through `.git/info/exclude` so analysis state does not make that checkout dirty.

## Run Codiluce

Run these commands from the **Codiluce project root**. The launcher prints the browser URL, normally `http://127.0.0.1:4300/`.

```bash
# Combined Go backend, React frontend, and TanStack Query
npm start -- examples/memos

# Small Rust and C projects
npm start -- examples/ripgrep
npm start -- examples/jq

# Python and Next.js / AI applications
npm start -- examples/flask
npm start -- examples/nextchat

# Laravel routes, controllers, migrations, and tables
npm start -- examples/bookstack
```

Stop the current server with Ctrl+C before switching repositories, or choose a different port with `--port 4400`. On a headless machine, add `--no-open` and open the printed URL yourself. The first source-checkout launch builds the visualizer if its build is missing.

For indexing without opening the visualizer:

```bash
npm run codiluce -- index --repo examples/memos
npm run codiluce -- inspect summary --repo examples/memos
```

Codiluce analyzes source without installing the target application dependencies or starting those applications. Its state defaults to `examples/<name>/.codiluce/`. Language and framework analysis coverage varies; these samples are also useful for identifying unsupported imports, routes, generated clients, and other gaps.

## Choose a starting point

- **Go + TanStack Query together:** `memos`.
- **TanStack Query internals and framework adapters:** `tanstack-query`.
- **Python API + React/TanStack Query:** `full-stack-fastapi`.
- **Rust:** start with `ripgrep` or `axum`; use `ruff` for a larger workspace.
- **C:** start with `jq`; then use `curl` or `git`.
- **Python:** start with `requests` or `flask`; use `django` for scale.
- **AI projects:** `langgraph`, `ollama`, and `nextchat`.
- **Refactoring and file moves:** the Flask comparison below; `memos` and `tanstack-query` also retain full branch history.
- **Many contributors:** `git`, `tanstack-query`, `flask`, `requests`, and `ripgrep` retain hundreds or thousands of Git author identities.
- **Laravel application flows:** `bookstack` and `firefly-iii`.

## History and contributors

Nine repositories have full history reachable from the selected branch: `memos`, `caddy`, `tanstack-query`, `full-stack-fastapi`, `ripgrep`, `axum`, `jq`, `flask`, and `requests`. The other eleven were cloned with `--depth 500` to bound downloads. Depth counts ancestry steps, so merge-heavy repositories can retain more than 500 commits. Each clone has its selected branch's working tree checked out; other branches, tags, submodule checkouts, and Git LFS payloads were not requested.

The inventory records the actual available commit counts and mailmap-normalized Git author identities in each clone. Identities include bots and can still represent the same person more than once; they are not unique-human contributor counts. Every checkout passed Git connectivity checks and had a clean working tree after cloning.

Index a bounded recent history before opening the timeline:

```bash
npm run codiluce -- history index --repo examples/flask --limit 40
npm start -- examples/flask --history-indexing
```

To fetch older history in a shallow clone:

```bash
git -C examples/django fetch --unshallow origin
```

### Concrete Flask refactor

Flask extracted its application and blueprint implementation into Sans-IO base classes. The change is documented in [Flask's changelog](https://github.com/pallets/flask/blob/main/CHANGES.rst) and the full history is present locally.

- [Before the moves](https://github.com/pallets/flask/commit/0e0e8ddcdc2bd572cdecd371bc0f309ac62ee9c4): `0e0e8ddcdc2bd572cdecd371bc0f309ac62ee9c4`.
- [Move files into `src/flask/sansio/`](https://github.com/pallets/flask/commit/a64588f87a2bd7ba557814ec039e3b2af2ce842d): `a64588f87a2bd7ba557814ec039e3b2af2ce842d`.
- [Split App and Blueprint into Sans-IO and IO parts](https://github.com/pallets/flask/commit/0ec7f713d679ceed2c605e62ac5d38d579f29fa0): `0ec7f713d679ceed2c605e62ac5d38d579f29fa0`.

Index just these three snapshots. `--all-parents` includes the development-branch commits in the timeline:

```bash
npm run codiluce -- history index --repo examples/flask --all-parents \
  --commits 0e0e8ddcdc2bd572cdecd371bc0f309ac62ee9c4,a64588f87a2bd7ba557814ec039e3b2af2ce842d,0ec7f713d679ceed2c605e62ac5d38d579f29fa0
npm start -- examples/flask
```

Compare the first and last snapshots to inspect the structural extraction; compare the first and second for a pure file-move case. This exercises lineage, moved files, changed class structure, and relationships without editing the checkout.

## Repository inventory

Each snapshot link identifies the exact revision cloned. Source areas below were checked against the local checkout. Paths are relative to each example repository.

### 1. [usememos/memos](https://github.com/usememos/memos)

A real self-hosted note-taking application with a Go backend, React frontend, generated RPC clients, storage adapters and SQL migrations. This is the combined Go + TanStack Query example.

- **Local:** `examples/memos`. **Stack:** Go + React + TanStack Query.
- **Source areas:** `server`, `core`, `store`, `web/src/hooks`, `web/src/components`, `proto`.
- **Test:** Nested backend/frontend applications, query hooks and RPC wrappers, generated-code handling, database files and changing architecture.
- **Snapshot:** [`b1fa9aefcc22`](https://github.com/usememos/memos/tree/b1fa9aefcc22fde5774b7f6cf0b3e19fc67acc6e), branch `main`; 1,322 tracked files.
- **History:** Full selected-branch history; 4,848 available commits, 452 Git author identities.

### 2. [dagucloud/dagu](https://github.com/dagucloud/dagu)

A self-hosted workflow orchestrator with a Go service and React dashboard. Its current frontend declares TanStack Table, not TanStack Query.

- **Local:** `examples/dagu`. **Stack:** Go + React workflow application.
- **Source areas:** `cmd`, `internal`, `ui`.
- **Test:** Go package boundaries, service/API structure, dashboard code, YAML workflows and mixed language ownership.
- **Snapshot:** [`659d4cb66ff4`](https://github.com/dagucloud/dagu/tree/659d4cb66ff4d37c8bedf526aadb6b73fe23d4d7), branch `main`; 4,043 tracked files.
- **History:** Shallow clone, requested depth 500; 500 available commits, 34 Git author identities.

### 3. [pocketbase/pocketbase](https://github.com/pocketbase/pocketbase)

An established backend product with authentication, realtime APIs, record handling, migrations and an embedded dashboard.

- **Local:** `examples/pocketbase`. **Stack:** Go backend and embedded application.
- **Source areas:** `core`, `apis`, `forms`, `migrations`, `tools`, `ui`.
- **Test:** Go interfaces and methods, large core packages, embedded assets, schema and route detection gaps.
- **Snapshot:** [`5cec579da984`](https://github.com/pocketbase/pocketbase/tree/5cec579da984436a258602a46a96302fbd31f77c), branch `master`; 923 tracked files.
- **History:** Shallow clone, requested depth 500; 514 available commits, 2 Git author identities.

### 4. [caddyserver/caddy](https://github.com/caddyserver/caddy)

A production web server organized around pluggable modules, HTTP handlers and interfaces.

- **Local:** `examples/caddy`. **Stack:** Go modular HTTP server.
- **Source areas:** `modules`, `cmd`, `caddyconfig`.
- **Test:** Module registration, interfaces, middleware, package boundaries and contributor history.
- **Snapshot:** [`221ebc450339`](https://github.com/caddyserver/caddy/tree/221ebc4503398fa8c87d95a52d43d0d93a6aeef4), branch `master`; 705 tracked files.
- **History:** Full selected-branch history; 2,741 available commits, 482 Git author identities.

### 5. [TanStack/query](https://github.com/TanStack/query)

The actual TanStack Query implementation, its framework adapters, tests and runnable example source.

- **Local:** `examples/tanstack-query`. **Stack:** TypeScript multi-package library; TanStack Query.
- **Source areas:** `packages/query-core`, `packages/react-query`, `packages/vue-query`, `packages/svelte-query`, `examples`, `docs`.
- **Test:** Workspace discovery, shared library ownership, framework adapters, generics, tests, and long-term package refactoring.
- **Snapshot:** [`aab352876a01`](https://github.com/TanStack/query/tree/aab352876a01f76fd0e00b0b500a85907ec7c8b4), branch `main`; 3,601 tracked files.
- **History:** Full selected-branch history; 5,508 available commits, 1,157 Git author identities.

### 6. [ChatGPTNextWeb/NextChat](https://github.com/ChatGPTNextWeb/NextChat)

An open-source AI chat application with Next.js routes, client components, model integrations and a Rust/Tauri desktop shell.

- **Local:** `examples/nextchat`. **Stack:** Next.js + TypeScript + AI application.
- **Source areas:** `app`, `app/api`, `app/components`, `app/client`, `src-tauri`.
- **Test:** Next.js route and component analysis, HTTP wrappers, streaming interfaces and nested Rust application detection.
- **Snapshot:** [`defdcdb55d85`](https://github.com/ChatGPTNextWeb/NextChat/tree/defdcdb55d850cd12c4c657eb83729fd66e215c0), branch `main`; 425 tracked files.
- **History:** Shallow clone, requested depth 500; 3,110 available commits, 340 Git author identities.

### 7. [fastapi/full-stack-fastapi-template](https://github.com/fastapi/full-stack-fastapi-template)

The official full-stack FastAPI template, combining Python API code, SQLModel, a React frontend, generated API clients and TanStack Query. This is a template rather than a deployed product.

- **Local:** `examples/full-stack-fastapi`. **Stack:** Python FastAPI + React + TanStack Query; official template.
- **Source areas:** `backend/app`, `backend/app/api`, `backend/app/models.py`, `frontend/src`, `frontend/src/client`, `frontend/src/hooks`.
- **Test:** Nested Python/TypeScript applications, generated clients, query hooks, models, REST routes and frontend/backend linking gaps.
- **Snapshot:** [`f27b47215078`](https://github.com/fastapi/full-stack-fastapi-template/tree/f27b4721507824e57ebd0286ff1a84d82e83bf59), branch `master`; 252 tracked files.
- **History:** Full selected-branch history; 1,533 available commits, 89 Git author identities.

### 8. [BurntSushi/ripgrep](https://github.com/BurntSushi/ripgrep)

A mature search tool split into reusable crates, with an executable frontend and a substantial test suite.

- **Local:** `examples/ripgrep`. **Stack:** Rust command-line application and workspace.
- **Source areas:** `crates`, `crates/core`, `crates/searcher`, `crates/grep`, `tests`.
- **Test:** Cargo workspace discovery, crate boundaries, Rust declarations, CLI structure and contributor history.
- **Snapshot:** [`3fce3b5bb023`](https://github.com/BurntSushi/ripgrep/tree/3fce3b5bb0236da2df6d99672afb8a719642eca7), branch `master`; 237 tracked files.
- **History:** Full selected-branch history; 2,287 available commits, 501 Git author identities.

### 9. [astral-sh/ruff](https://github.com/astral-sh/ruff)

A real Python linter and formatter implemented primarily in Rust, with many crates and language-specific test fixtures.

- **Local:** `examples/ruff`. **Stack:** Rust workspace + Python tooling.
- **Source areas:** `crates`, `crates/ruff_linter`, `crates/ruff_python_ast`, `crates/ruff_python_parser`, `python`.
- **Test:** Large Cargo workspaces, Rust declarations, mixed Rust/Python files, fixture volume and map performance.
- **Snapshot:** [`d1d6a5d4ae28`](https://github.com/astral-sh/ruff/tree/d1d6a5d4ae2845e40f33c9f4af4706dba314a359), branch `main`; 11,205 tracked files.
- **History:** Shallow clone, requested depth 500; 500 available commits, 58 Git author identities.

### 10. [tokio-rs/axum](https://github.com/tokio-rs/axum)

A widely used HTTP framework with typed extractors, middleware and small example applications.

- **Local:** `examples/axum`. **Stack:** Rust HTTP framework and examples.
- **Source areas:** `axum`, `axum-core`, `axum-extra`, `examples`.
- **Test:** Cargo members, nested example projects, Rust traits and generics, handlers and middleware.
- **Snapshot:** [`618496288c41`](https://github.com/tokio-rs/axum/tree/618496288c41da835683ec149432c4869722779f), branch `main`; 505 tracked files.
- **History:** Full selected-branch history; 2,016 available commits, 477 Git author identities.

### 11. [curl/curl](https://github.com/curl/curl)

A production networking project separating the curl executable from libcurl, protocol implementations and tests.

- **Local:** `examples/curl`. **Stack:** C command-line tool and library.
- **Source areas:** `src`, `lib`, `include`, `tests`.
- **Test:** C/C++ header classification, native manifests, source/header hierarchy, many files and contributor metrics.
- **Snapshot:** [`bea2e5d6d1dd`](https://github.com/curl/curl/tree/bea2e5d6d1dd11b443eef091681cd132209b5bc2), branch `master`; 4,563 tracked files.
- **History:** Shallow clone, requested depth 500; 500 available commits, 46 Git author identities.

### 12. [jqlang/jq](https://github.com/jqlang/jq)

A mature command-line JSON processor with a parser, bytecode compiler, interpreter and test corpus.

- **Local:** `examples/jq`. **Stack:** C JSON processor; compact native project.
- **Source areas:** `src`, `tests`, `docs`.
- **Test:** Compact C file map, parser/compiler organization, native build files, vendored dependencies and full contributor history.
- **Snapshot:** [`fd25c3e72038`](https://github.com/jqlang/jq/tree/fd25c3e720385919273b5b776486d84af9aa3914), branch `master`; 435 tracked files.
- **History:** Full selected-branch history; 1,956 available commits, 269 Git author identities.

### 13. [git/git](https://github.com/git/git)

The official GitHub mirror of Git, with C libraries and commands, shell scripts, documentation and extensive tests.

- **Local:** `examples/git`. **Stack:** C version-control system; large mature project.
- **Source areas:** `builtin`, `compat`, `t`, `Documentation`.
- **Test:** Large mixed native/shell repository, top-level source files, test directories and many contributor identities.
- **Snapshot:** [`6de20f6092dc`](https://github.com/git/git/tree/6de20f6092dcf9bdb1c8efe03db4b70c82b423dd), branch `master`; 4,857 tracked files.
- **History:** Shallow clone, requested depth 500; 81,631 available commits, 2,481 Git author identities.

### 14. [pallets/flask](https://github.com/pallets/flask)

A compact, mature framework with application and blueprint classes, examples and full branch history. Its Sans-IO extraction provides a concrete architectural refactor to compare.

- **Local:** `examples/flask`. **Stack:** Python web framework; documented structural refactor.
- **Source areas:** `src/flask`, `src/flask/sansio`, `examples`, `tests`.
- **Test:** Python classes/functions, package moves, refactoring across commits, blueprint structure and contributor history.
- **Snapshot:** [`d086db856be1`](https://github.com/pallets/flask/tree/d086db856be187255b8ec61ef409357393020f32), branch `main`; 236 tracked files.
- **History:** Full selected-branch history; 5,562 available commits, 897 Git author identities.

### 15. [django/django](https://github.com/django/django)

A large framework spanning HTTP handling, routing, authentication, ORM, migrations, management commands and tests.

- **Local:** `examples/django`. **Stack:** Python web framework; large community project.
- **Source areas:** `django`, `django/db`, `django/core`, `django/contrib`, `tests`.
- **Test:** Large Python package trees, nested declarations, many contributors, management commands and performance.
- **Snapshot:** [`1b4d021b6525`](https://github.com/django/django/tree/1b4d021b6525bff6439b9d3b8d5388a1a1906ecd), branch `main`; 7,085 tracked files.
- **History:** Shallow clone, requested depth 500; 500 available commits, 128 Git author identities.

### 16. [psf/requests](https://github.com/psf/requests)

A widely used HTTP client with sessions, adapters, authentication and exceptions in a small source tree.

- **Local:** `examples/requests`. **Stack:** Python HTTP client; small library.
- **Source areas:** `src/requests`, `tests`, `docs`.
- **Test:** Readable Python classes and methods, small-project layout, source-directory history and contributor identities.
- **Snapshot:** [`611c6162cbc4`](https://github.com/psf/requests/tree/611c6162cbc4ac2020a2f91c7cfa4f3abf9bbb60), branch `main`; 130 tracked files.
- **History:** Full selected-branch history; 6,495 available commits, 825 Git author identities.

### 17. [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph)

An open-source graph-based agent orchestration library with several Python packages, checkpointing and tests.

- **Local:** `examples/langgraph`. **Stack:** Python + AI agent workflow library.
- **Source areas:** `libs`, `libs/langgraph`, `libs/checkpoint`, `libs/prebuilt`, `examples`.
- **Test:** Python monorepo/package discovery, graph and state abstractions, async methods, decorators and AI-oriented code.
- **Snapshot:** [`40a2e6d84505`](https://github.com/langchain-ai/langgraph/tree/40a2e6d845054cc0cc17a6a169ca6e7394e5231c), branch `main`; 684 tracked files.
- **History:** Shallow clone, requested depth 500; 500 available commits, 36 Git author identities.

### 18. [ollama/ollama](https://github.com/ollama/ollama)

A real local-model inference project with an HTTP API, CLI, model runners and native integrations.

- **Local:** `examples/ollama`. **Stack:** Go + C/C++ + AI inference application.
- **Source areas:** `api`, `cmd`, `server`, `llm`, `model`, `ml`, `mlxrunner`.
- **Test:** Mixed Go/native files, API and CLI separation, native build files and model-provider code. Model weights are not part of the checkout.
- **Snapshot:** [`e3cddc3e897d`](https://github.com/ollama/ollama/tree/e3cddc3e897d8414a60a46e23f5ef3a99be2eb81), branch `main`; 1,433 tracked files.
- **History:** Shallow clone, requested depth 500; 627 available commits, 45 Git author identities.

### 19. [BookStackApp/BookStack](https://github.com/BookStackApp/BookStack)

A real documentation/wiki application with Laravel controllers, routes, models, migrations and frontend assets. The GitHub repository is now a mirror; upstream development is managed on Codeberg.

- **Local:** `examples/bookstack`. **Stack:** PHP Laravel + frontend assets; GitHub mirror.
- **Source areas:** `app`, `routes`, `database/migrations`, `resources`.
- **Test:** Laravel routes-to-controller analysis, database relationships, frontend files, end-to-end flows and contributor history.
- **Snapshot:** [`ff661b59f6f6`](https://github.com/BookStackApp/BookStack/tree/ff661b59f6f605bf768fe850c0d0a8a2dc09d203), branch `development`; 2,615 tracked files.
- **History:** Shallow clone, requested depth 500; 3,936 available commits, 187 Git author identities.

### 20. [firefly-iii/firefly-iii](https://github.com/firefly-iii/firefly-iii)

A production personal-finance application with many controllers, domain models, services, commands and migrations.

- **Local:** `examples/firefly-iii`. **Stack:** PHP Laravel finance application.
- **Source areas:** `app`, `app/Http`, `app/Models`, `app/Console`, `routes`, `database/migrations`, `resources`.
- **Test:** Laravel routes, command entry points, ORM/table relationships, larger PHP application layout and multi-author history.
- **Snapshot:** [`57371b9f82de`](https://github.com/firefly-iii/firefly-iii/tree/57371b9f82debbf90e6453aba8af585e8c382617), branch `main`; 2,248 tracked files.
- **History:** Shallow clone, requested depth 500; 4,897 available commits, 42 Git author identities.

## Recreate the local checkouts

The clones are intentionally not committed. These commands recreate them from GitHub if `examples/` is copied without its ignored contents. Run them from the project root when the destination directories are absent. They clone the current branch tip; the inventory above records the original snapshot.

```bash
mkdir -p examples
export GIT_LFS_SKIP_SMUDGE=1
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch main https://github.com/usememos/memos.git examples/memos
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch main --depth 500 https://github.com/dagucloud/dagu.git examples/dagu
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch master --depth 500 https://github.com/pocketbase/pocketbase.git examples/pocketbase
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch master https://github.com/caddyserver/caddy.git examples/caddy
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch main https://github.com/TanStack/query.git examples/tanstack-query
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch main --depth 500 https://github.com/ChatGPTNextWeb/NextChat.git examples/nextchat
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch master https://github.com/fastapi/full-stack-fastapi-template.git examples/full-stack-fastapi
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch master https://github.com/BurntSushi/ripgrep.git examples/ripgrep
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch main --depth 500 https://github.com/astral-sh/ruff.git examples/ruff
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch main https://github.com/tokio-rs/axum.git examples/axum
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch master --depth 500 https://github.com/curl/curl.git examples/curl
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch master https://github.com/jqlang/jq.git examples/jq
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch master --depth 500 https://github.com/git/git.git examples/git
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch main https://github.com/pallets/flask.git examples/flask
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch main --depth 500 https://github.com/django/django.git examples/django
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch main https://github.com/psf/requests.git examples/requests
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch main --depth 500 https://github.com/langchain-ai/langgraph.git examples/langgraph
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch main --depth 500 https://github.com/ollama/ollama.git examples/ollama
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch development --depth 500 https://github.com/BookStackApp/BookStack.git examples/bookstack
git -c core.hooksPath=/dev/null clone --single-branch --no-tags --branch main --depth 500 https://github.com/firefly-iii/firefly-iii.git examples/firefly-iii

# Keep Codiluce state out of each nested checkout's dirty-file metrics.
for repository in examples/*/; do
  if [ -d "$repository/.git" ]; then
    printf "\n# Local Codiluce analysis state\n.codiluce/\n" >> "$repository/.git/info/exclude"
  fi
done
```

Upstream license files remain in their respective checkouts. Follow each project's own documentation if you also want to build or run the application; that is separate from scanning its source with Codiluce.
