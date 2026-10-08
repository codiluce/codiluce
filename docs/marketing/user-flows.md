# Codiluce user flows

Twenty things an engineering team can do with Codiluce, each one shown on a public repository from
[`examples/`](../../examples/readme.md). Use them for demos, videos, posts and the website.

Every number below was measured on 2026-10-08. The example checkouts were indexed with the development build:
`main` plus the uncommitted analysis work in the working tree (Tree-sitter declarations, workspaces). The machine
was a laptop with an AMD Ryzen 7 5800H. Measure again before publishing, because both the projects and Codiluce
change.

**Release note:** most of these flows need the next npm release. npm 0.1.1 has no People panel and no
declarations for Go, Rust or Python. The **Needs** column says which version each flow needs.

| # | Flow | Repository | Main feature | Needs |
|---|------|------------|--------------|-------|
| 1 | [Your first day on a new codebase](#1-your-first-day-on-a-new-codebase) | dagu | Zoomable map | next |
| 2 | [Where does this concept live?](#2-where-does-this-concept-live) | django | Search | next |
| 3 | [Where is the weight of the code?](#3-where-is-the-weight-of-the-code) | curl | Map sized by lines | 0.1.1 |
| 4 | [What does the cron job actually do?](#4-what-does-the-cron-job-actually-do) | firefly-iii | Console flows | 0.1.1 |
| 5 | [Check the evidence behind a link](#5-check-the-evidence-behind-a-link) | full-stack-fastapi | Why?, analysis coverage | 0.1.1 |
| 6 | [Blast radius before you change a core API](#6-blast-radius-before-you-change-a-core-api) | tanstack-query | Impact | next |
| 7 | [Plan a database schema change](#7-plan-a-database-schema-change) | bookstack | Table relations, Impact | 0.1.1 |
| 8 | [See the code by the data it serves](#8-see-the-code-by-the-data-it-serves) | bookstack | Data families | next |
| 9 | [Review an agent-assisted pull request by its architecture](#9-review-an-agent-assisted-pull-request-by-its-architecture) | caddy | History Compare | next |
| 10 | [See how much code agents write, and where](#10-see-how-much-code-agents-write-and-where) | nextchat | People | next |
| 11 | [Catch up after two weeks away](#11-catch-up-after-two-weeks-away) | memos | Pinned baseline, split view | next |
| 12 | [Understand a refactor you were not part of](#12-understand-a-refactor-you-were-not-part-of) | flask | Compare, moves | next |
| 13 | [Review what changed since the last major release](#13-review-what-changed-since-the-last-major-release) | axum | Compare any two commits | next |
| 14 | [Watch ten years of architecture in a minute](#14-watch-ten-years-of-architecture-in-a-minute) | ripgrep | Time-lapse | 0.1.1 |
| 15 | [Find who to ask before you change a folder](#15-find-who-to-ask-before-you-change-a-folder) | jq | People per folder | next |
| 16 | [Spot a bus factor of one](#16-spot-a-bus-factor-of-one) | requests | People windows | next |
| 17 | [Map a 10,000-file monorepo](#17-map-a-10000-file-monorepo) | ruff | Scale | next |
| 18 | [One map for a mixed-language system](#18-one-map-for-a-mixed-language-system) | ollama | Languages, applications | next |
| 19 | [Evaluate a dependency before you adopt it](#19-evaluate-a-dependency-before-you-adopt-it) | langgraph | Packages, search | next |
| 20 | [Give the whole team a read-only map](#20-give-the-whole-team-a-read-only-map) | git | `serve --read-only` | 0.1.1 |

Before recording, read [What not to show yet](#what-not-to-show-yet). It lists the gaps found while checking these
flows, including why no flow here goes from a click to a database table.

## Understand a codebase

### 1. Your first day on a new codebase

**Who:** a new engineer, or anyone opening an unfamiliar repository. **Repository:** dagu, a Go workflow engine
with a React dashboard.

1. Run `npx codiluce@latest start .` in the repository.
2. Codiluce detects 7 applications without configuration: the Go service, the TypeScript UI and the npm packaging
   wrappers.
3. Double-click into the Go service, then `internal/`, then a package. The labels change at each level: files and
   lines, then symbols, then signatures.
4. Select a function to read its source on the map.

**What you see:** 4,032 files and 34,564 declarations, indexed in 36 seconds.
**Message:** your first hour in a new repository, on a map instead of a file tree.

### 2. Where does this concept live?

**Who:** an engineer who needs to fix or extend one feature in a large codebase. **Repository:** django, with
6,996 files.

1. Press `/` and type `csrf`.
2. The results mix files, classes, functions and docs: `django/middleware/csrf.py`, the `csrf_exempt` decorator,
   the `csrf_token` template tag and the security check in `django/core/checks/security/csrf.py`.
3. Pick one, and the map flies to it with its neighbours around it.

**What you see:** 284 matches across code, tests and docs, each in its place on the map.
**Message:** search answers "where", and the map answers "and what is next to it".

### 3. Where is the weight of the code?

**Who:** a tech lead estimating work, or anyone who wants proportions before reading code. **Repository:** curl.

1. Open the map at the application level. Blocks are sized by their measured lines.
2. Compare `lib/` (libcurl) with `src/` (the `curl` command-line tool).

**What you see:** `lib/` holds 43% of the measured lines (395 files). The command-line tool in `src/` is 6% (96
files). Tests are 2,738 files.
**Message:** a repository's proportions, in one glance.

### 4. What does the cron job actually do?

**Who:** an on-call engineer, or anyone who inherits background jobs. **Repository:** firefly-iii, a personal
finance application with 85 console commands.

1. Open **Flows**, filter by **Console** and pick `firefly-iii:cron`.
2. The flow plays on the map. `Cron::handle` fans out to six cron jobs: auto budgets, the update check, exchange
   rates, recurring transactions, bill warnings and webhooks.
3. Open **Lanes** to read the same flow from left to right: the jobs it runs, the events it fires, the cache
   entries it writes and the tables it touches.

**What you see:** 26 files and 107 entities, 3 tables, and 4 events such as `SubscriptionsAreOverdueForPayment`.
There are 19 gaps where a call could not be resolved, and each one is shown as a gap, never guessed.
**Message:** know what runs while you sleep, before it pages you.

### 5. Check the evidence behind a link

**Who:** a skeptical senior engineer: "how do I know the map is right?" **Repository:** the official full-stack
FastAPI template (FastAPI backend, React frontend).

1. Select the `AddItem` component.
2. Its relationships include "rendered by `Items`". Click **Why?**.
3. The source opens at `frontend/src/routes/_layout/items.tsx`, line 65, highlighted, with the explanation
   "Renders `<AddItem>`" and the analyzer that found it.
4. Scroll to **Analysis coverage**. It says what was analyzed for this file and what was not.

**What you see:** every link has a file and a line behind it. Name-only matches never create one.
**Message:** a map you can audit, not a picture someone drew.

## Change it safely

### 6. Blast radius before you change a core API

**Who:** library maintainers, platform teams and anyone changing shared code. **Repository:** tanstack-query,
detected as 100 applications: packages, integrations and examples.

1. Search for `QueryObserver` in `packages/query-core`.
2. Click **Impact** in the inspector. The map tints what depends on it by distance.
3. Read the reach: the packages and the chain that reaches each one.

**What you see:** 385 entities within four hops, in 20 packages. Some examples: `lit-query` 75, `query-core` 74,
`preact-query` 56, `react-query` 51, `vue-query` 40, `solid-query` 27 and the devtools 14. Codiluce also says the
result is a lower bound: unresolved calls such as `unsubscribe` (205 call sites) might reach further.
**Message:** know who breaks before you push, and how sure you can be.

### 7. Plan a database schema change

**Who:** a backend engineer about to change a table. **Repository:** bookstack, a wiki, which recently moved
pages, chapters, books and shelves into one `entities` table.

1. Select the `entities` table in the Database district. Its migration is
   `2025_09_15_132850_create_entities_table.php`.
2. The inspector lists the 5 models that map to it: `Book`, `Bookshelf`, `Chapter`, `Page` and `EntityTable`.
3. Filter its relationships to reads and writes. In `app/`, 7 files read it and 3 write it (`PageRepo`,
   `UserRepo` and `TrashCan`). The rest are tests, factories and seeders.
4. Click **Impact**: 1,218 entities within four hops, including 4 console commands.

**Message:** see everything that touches a table before you write the migration.

### 8. See the code by the data it serves

**Who:** a team lead splitting work, or an engineer learning the domain. **Repository:** bookstack.

1. Turn on ▦ (data families) in the map controls.
2. Files, commands and tables take the color of their family. Families come from foreign keys and table names,
   with no language model.
3. Select a folder. The inspector's **Data in this folder** shows its files per family. Select a family to light
   its files.

**What you see:** 40 tables grouped into 31 families. The largest are Roles (6 tables, 114 files) and Entities (4
tables, 97 files), followed by Images, Activities and Attachments.
**Message:** the domain of an application, read from its schema.

## Review what agents change

### 9. Review an agent-assisted pull request by its architecture

**Who:** a reviewer facing a large AI-assisted pull request. **Repository:** caddy. Pull request #7880 ("unify
Caddyfile lexer/parser/formatter") is co-authored by Claude: 13 files, +3,146 / −394 lines.

1. Open **History** and select commit `4f45ded7`. Compare shows it against the commit before it.
2. The map splits into an overview plus a view on each place that changed.
3. Turn on **Dim unchanged** and read the change as structure instead of a diff.

**What you see:** in non-test code, 6 new types (`FormatOptions`, `LexOptions`, `FormattedFile`…), one type removed
(`heredocState`), `lexer`, `Token` and `parser` modified, and 25 new functions. The tests add 76 functions.
**Message:** review what an agent built, not only the lines it typed.

### 10. See how much code agents write, and where

**Who:** an engineering manager, or a team adopting coding agents. **Repository:** nextchat.

1. Open **People** and choose the 365-day window.
2. Agents and bots are told apart from humans. Claude appears as an agent through its co-author trailers.
3. Select it to light the files it co-wrote on the map.

**What you see:** 35 of the 37 commits of the last year were co-authored by Claude, across 31 files. In memos, five
different agents appear in the same window.
**Message:** agents are part of the team now; see where their code lives.

### 11. Catch up after two weeks away

**Who:** anyone back from holidays, or a lead following several teams. **Repository:** memos, a note-taking app
with a Go backend and a React frontend.

1. Open **History**, select the commit from two weeks ago and pin it as the baseline.
2. Move to today. The split view shows the places that changed, the largest first.

**What you see:** 28 commits since 25 September, with 553 changes in 29 places. The navigation was rebuilt around
"spaces": the `Explore` and `UserProfile` pages were removed, `SpaceSwitcher` and `AudienceMenu` arrived, and a
`LegacyProfileRedirect` keeps old links working. `store/db` and `proto` changed too.
**Message:** two weeks of commits, understood in two minutes.

## Learn from history

### 12. Understand a refactor you were not part of

**Who:** an engineer joining after a big refactor. **Repository:** flask, whose Sans-IO split is documented in its
changelog.

1. Open **History** and select merge `1d8b53f7`, "Split the App and Blueprint into Sansio and IO parts (#5127)".
2. Compare shows it against the commit before it: added in green, removed as red ghosts, modified in amber, moved
   in violet.
3. Select `App` in `sansio/` to see what the split took out of `Flask`.

**What you see:** 109 changes. A new `sansio/` folder holds `App`, `Blueprint` and `BlueprintSetupState`,
`scaffold.py` moved into it, and 46 methods moved.
**Message:** read an architectural refactor as it happened, not as 3,000 lines of diff.

### 13. Review what changed since the last major release

**Who:** maintainers writing release notes, or users planning an upgrade. **Repository:** axum.

1. Open **History**, select the "Release axum v0.8.0" commit (`926543f2`) and pin it as the baseline.
2. Move to the latest commit.

**What you see:** 362 commits and 1,322 changes: 474 added, 716 modified, 18 moved and 114 removed. The removals
include the deprecated `Host`, `Scheme` and `OptionalPath` extractors of `axum-extra`.
**Message:** what a release really changed, ready for the upgrade guide.

### 14. Watch ten years of architecture in a minute

**Who:** anyone telling a project's story: a talk, onboarding, a retrospective. **Repository:** ripgrep.

1. Index a sample of the history. 80 commits from 2016 to 2026 took 27 seconds.
2. Open **History** and press ▶ with **Follow** on.

**What you see:** the project splits into reusable crates. In February 2020, nine crates and 112 files move into
`crates/`, drawn in violet as moves, not as deletions and additions.
**Message:** a repository's whole life, as a time-lapse.

## Know the people

### 15. Find who to ask before you change a folder

**Who:** an engineer about to touch code they do not own. **Repository:** jq.

1. Select `src/`. The inspector's **People** section lists who changed it, for the window you choose.
2. Choose **365 days**.

**What you see:** 20 people changed `src/` in the last year. The one with the most lines made only 2 commits. The
one with 35 commits, last active this week, is the person to ask.
**Message:** find your reviewer from the code, not from an outdated wiki page.

### 16. Spot a bus factor of one

**Who:** engineering managers and maintainers planning continuity. **Repository:** requests.

1. Open **People** and compare the **All** and **365 days** windows.

**What you see:** 772 people across 4,862 commits since the project began, but in the last year one person wrote
87% of the changed lines (54 of 109 commits). A bot made most of the other commits.
**Message:** see where your knowledge depends on one person, before they go on holiday.

## Bring it to your stack and your team

### 17. Map a 10,000-file monorepo

**Who:** platform teams at scale. **Repository:** ruff, a Rust workspace with Python packages.

1. Run `codiluce start .` once. Later runs reuse the cache.
2. Zoom from 63 applications down to a single function.

**What you see:** 10,437 files and 60,416 declarations, indexed in 86 seconds on a laptop. Containers load their
children only when they are large enough on screen, so the map stays fluid.
**Message:** big repositories are where you need a map most.

### 18. One map for a mixed-language system

**Who:** teams whose system is more than one language. **Repository:** ollama, Go with native C and C++ code.

1. Open the map: the Go service and the native parts are separate applications.
2. Select any file. **Analysis coverage** says what was analyzed for its language.

**What you see:** 4 applications, 1,433 files and 13,728 declarations, with each language drawn in its own color.
**Message:** one map for everything in the repository, honest about what it reads at each depth.

### 19. Evaluate a dependency before you adopt it

**Who:** an engineer or architect choosing an open-source library. **Repository:** langgraph.

1. Open the repository's map. It shows 8 Python packages under `libs/`: `langgraph`, `checkpoint`,
   `checkpoint-sqlite`, `checkpoint-postgres`, `prebuilt`, `sdk-py`, `cli` and `checkpoint-conformance`.
2. Search for `StateGraph` and read its class and methods in place.
3. Index its recent history (`history index --limit 50`) and open **History** to see how fast the code you would
   depend on changes.

**What you see:** 679 files and 10,785 declarations, indexed in 7 seconds.
**Message:** understand a library's architecture before it becomes yours.

### 20. Give the whole team a read-only map

**Who:** a lead sharing the architecture with product, QA, support or new hires. **Repository:** git.

1. Index once, then run `codiluce serve --read-only` on an internal machine.
2. Share links that open an exact place: every view has a `#id=…` URL.

**What you see:** git's 4,853 files in 32 detected parts: the C core plus Perl, Python, gitweb's JavaScript and
the new Rust code. Indexing took 12 seconds. Read-only mode refuses on-demand indexing.
**Message:** one shared picture of the system, for everyone who works on it.

## What not to show yet

These gaps showed up while checking the flows. Fix them, or avoid them on camera.

- **No example goes from a click to a database table.** This is the website's "From the click to the table"
  feature:
  - BookStack and Firefly III register routes the way Laravel 10 and older did, and the analyzer reads only
    `withRouting()` and closure route groups. BookStack reports `routing-bootstrap-unresolved` and Firefly III 107
    `unsupported-route-group`.
  - NextChat exports its API handlers as `export const GET = handle`, so only 1 route is found.
  - memos and the FastAPI template have no supported backend framework yet.

  Add a Laravel 11+ or Next.js App Router example, or extend the analyzers, before showing this feature on a public
  repository.
- **Shallow clones distort People.** In a `--depth 500` clone, the oldest commit counts as one person writing the
  whole repository: PocketBase shows 100% for one person and Django 98% of files. Use full-history repositories
  (flows 10, 15 and 16 do), or exclude the shallow boundary commit.
- **Steps stops at callbacks.** On `AddItem`, "What happens from here" finds nothing: the `useMutation` callback that
  calls the generated API client is not followed.
- **Some moves read as remove + add.** axum's `serve.rs` → `serve/mod.rs` shows as removed and added. In entity
  history, requests' `HTTPAdapter.send` starts at the move to `src/`, and Flask's `Scaffold` starts at the Sans-IO
  split, although Compare draws both files as moved.
- **Firefly III's largest data family is named "Recurrences"**, although its 19 tables include `transactions` and
  `accounts`. Use BookStack for families until the naming improves.
- **`--all-parents` snapshots are not on the timeline.** The Flask recipe in `examples/readme.md` indexes two
  development-branch commits. The timeline lists first-parent commits only, so flow 12 uses the main-branch merge
  `1d8b53f7` instead.

## Recreate the measurements

From the Codiluce checkout, after cloning the examples as described in [`examples/readme.md`](../../examples/readme.md):

```bash
npm start -- examples/<name>                     # flows 1–8, 10, 15–20

# history for flows 9, 11–14
npm run codiluce -- history index --repo examples/caddy --commits 4f45ded7,8ae69fae
npm run codiluce -- history index --repo examples/memos --since 2026-09-23
npm run codiluce -- history index --repo examples/flask --commits 0e0e8ddc,1d8b53f7
npm run codiluce -- history index --repo examples/axum --commits 926543f2,61849628
npm run codiluce -- history index --repo examples/ripgrep \
  --commits "$(git -C examples/ripgrep log --first-parent --format=%H | awk 'NR%28==1' | paste -sd, -)"
```

Short SHAs are shown for readability. Pass full SHAs if a short one is ambiguous.
