# Branches and worktrees on the map

Designed 2026-10-15. Placing new files in their nearest folder is built. Viewing a branch at its tip and showing
worktrees, described below, are not built yet.

## Where things stand

The PRs panel shows open work: branches that aren't merged into the base branch, found with
`git for-each-ref --no-merged`. For each one, it computes the net change from the fork point (`git merge-base`) to the
branch tip, then places each changed file on the map being viewed by matching its path
(`src/history/pull-sources.ts`, `src/projection/pulls.ts`).

A file the branch adds can't match a path, because the map is built from the base branch. Since 2026-10-15, such a
file is counted in the deepest existing folder that holds its path (the repository root at worst), along with the
folders below it that don't exist yet:

- **Panel:** the Folders list says "+5 new" next to `src/analysis/metrics/`, where `metrics/` is shown dimmed because
  it doesn't exist yet. A "New files" list selects the folder that will hold each file.
- **Map:** the folder stays lit. When it's closed, its badge counts the new files. When it's open, a tag under its
  front corner says "+5 new · metrics/".
- **Legend:** "11 files it changes lit · 27 new in 10 folders".
- **Inspector:** a folder's inspector lists the open work that adds files inside it.

Example: `code-health` at `d427d1c` changes 38 files. 11 of them are on the map. The other 27 are new and land in 10
folders: `src/analysis/` (in `metrics/`), `tests/fixtures/` (in `health/`), `grammars/queries/` (in three new
language folders), and so on.

Two limits remain, and the rest of this document addresses them.

1. **New code isn't analyzed.** New files appear only as counts, with no blocks, symbols or edges. Impact and flows
   can't see them. A file the branch modifies is shown as it is on the base branch, so its new symbols don't appear
   either. `code-health` changes `src/core/graph.ts` and `src/pipeline/index.ts` and adds
   `src/analysis/metrics/analyzer.ts`. The map shows the base versions of the first two and nothing of the third.
2. **Uncommitted work in other worktrees is invisible.** Codiluce reads one checkout. Branches checked out in other
   worktrees appear only as their committed tip. Example: `feature/live-agents`, checked out in
   `/var/www/html/codiluce-agents`, points at `7319eeb`, the same commit as `main`, and has 15 uncommitted changes
   (8 modified files, 7 untracked). `--no-merged` leaves it out entirely. `code-health` was in the same state until
   its first commit, `c415140`.

## Step 2: view a branch at its tip

### What the user sees

Each open branch in the PRs panel gets **View branch**. So does a GitHub pull request whose head commit is in the
local repository. View branch opens the map at the branch tip, compared with its fork point, in the split comparison
view that History uses:

- Files it adds are real blocks marked as added, with their symbols.
- Files it changes show their new symbols.
- Impact, flows and the inspector all read the graph at the tip.

The header says "Branch code-health at d427d1c, compared with 7319eeb (where it forked)". Leaving the view returns to
the live map.

The tip has to be analyzed first. The initial-setup design measured about 18 s per commit on this repository. Until
the analysis finishes, the panel shows its progress and the map keeps the nearest-folder placement.

### How

**Analysis:** the tip is analyzed the same way as a History commit. It's built from Git objects in a scratch
directory, analyzed in a worker, and saved as a snapshot keyed by its commit and the analysis identity. Nothing is
checked out or fetched. A new commit on the branch becomes a new snapshot. Snapshots share entity versions
(`entity_versions` / `snapshot_entities`), so a branch tip mostly stores what it changed.

**Queue:** `HistoryService.request(sha, ref)` already accepts any commit on the first-parent line of a ref, and the
tip is on its own branch's line. It runs `history index --ref <branch> --commits <sha>`.

**Problem to fix first:** that command also calls `updateLayoutRegistry` with the branch's timeline. There is only
one registry (`layout_registry`, `id = 1`). If the base has indexed commits after the fork point, its snapshot list
isn't a prefix of the branch's line. The registry would then be rebuilt along the branch, and the base branch's
History layout would move until its next index rebuilds it back. Branch snapshots must be saved without touching the
registry. Options: a `--no-layout` flag, or a separate entry point that indexes single commits.

**Layout:** no new registry is needed. A view whose snapshot isn't in the registry already gets a copy of the
registry extended with that snapshot (`timelineFor` in `src/projection/service.ts`). That's how the live working
tree is placed today. Areas of the base branch keep their places, and the branch's new folders and files are added
inside their parents.

Without History indexed there's no registry. The view would then use the snapshot's own compact layout, and
positions wouldn't match the live map. View branch can either require History or index the fork point as well (two
commits).

**Comparison:** the view is `{ snapshot: tip, compareTo: fork point }`. The fork point also needs a snapshot. Reuse
the base branch's snapshot when History has one, otherwise index it with the tip. Comparing with the base branch's
current tip instead would mark the base's own changes since the fork as the branch's, reversed. Showing what a
merge would produce needs both tips and a three-way merge, and is out of scope.

**API:**
- `POST /api/pulls/item/:id/analyze` queues the tip, plus the fork point if needed.
- `/api/pulls/item/:id` reports `snapshot` (the head's snapshot, the field merged pull requests already use for
  their merge commit) and `baseSnapshot` once both are indexed, or `analysis: queued | running | failed`.
- The UI then opens the view with `snapshot` and `compareTo`.

**Permissions:** on-demand indexing is off for `serve` unless `--history-indexing` is passed (`start` follows the
`history.onDemand` setting) and always off with `--read-only`. When it's off, the panel shows the CLI command to run
instead.

**Not analyzable:** GitHub pull requests whose commits aren't local. Codiluce never fetches, so these keep the
nearest-folder placement.

### Open questions

- Should a branch be analyzed only when it's clicked, or automatically for branches checked out in a worktree or the
  few most recent ones?
- When should snapshots of old tips (the branch moved on, was deleted or merged) be pruned?
- Is the fork point always the right baseline, or should comparing with the base branch's tip be an option?

## Step 3: worktrees

### What the user sees

- **Location:** each open branch says where it's checked out, e.g. "code-health · checked out in ../codiluce-health".
- **Uncommitted layer:** a branch with uncommitted work shows it as a second layer, e.g. "+15 uncommitted", which
  can be switched on and off. Uncommitted files are lit like committed ones but with a lighter or dashed style. New
  files go to their nearest folder, as committed ones do.
- **Hidden branches:** a branch at the base commit that has uncommitted changes is listed. Today it's hidden.
  `feature/live-agents` would show "0 commits · 15 uncommitted files".
- **Detached worktrees** show as "detached at 1a2b3c4 in ../path".

### How

**Listing:** `git worktree list --porcelain -z` gives each worktree's path, HEAD, and branch or `detached`. Skip
`bare` and `prunable` entries, and skip the served checkout itself: its uncommitted work is already the live map.

**Changes, read-only:**
- `git -C <path> --no-optional-locks diff -z -M --numstat HEAD` (and `--name-status`) gives changes to tracked files.
- `git -C <path> --no-optional-locks ls-files --others --exclude-standard -z` gives untracked files. Count their
  lines by reading them, up to `maxFileBytes`.
- `--no-optional-locks` (or `GIT_OPTIONAL_LOCKS=0`) stops Git from refreshing the worktree's index, which `git status`
  otherwise does. Codiluce promises never to write to the repository.

**Open set:** branches not merged into the base, plus worktree branches with uncommitted changes, plus detached
worktrees that are ahead of the base or have uncommitted changes. List at most 20 worktrees.

**Model:**
- `OpenBranch` gains `worktree?: { path: string; uncommitted?: PullFileChange[] }`.
- Each change in a change set gets a `layer: 'commit' | 'uncommitted'`. A path changed in both layers counts once,
  with both layers.
- `pullDetail` lights or places files per layer. Impact starts from either layer or both.

**Freshness:** uncommitted changes change while someone edits, so recompute them on each panel request with a short
cache (a few seconds). Committed work keeps its cache by base and tip.

**Analyzing a worktree:** this means analyzing a directory, not a commit. The pipeline already does it for the
served checkout, but snapshots are keyed by commit. It would need a snapshot kind like "worktree <path> at <time>",
replaced on each analysis. This comes after step 2.

### Open questions

- Should the API return worktree paths as given, or relative to the repository's parent folder?
- Should merged branches still checked out in a worktree be listed when they have uncommitted work?

## Build order

1. Index branch commits without touching the shared layout registry or the base branch's timeline. The same problem
   affects today's on-demand `request(sha, ref)` whenever `ref` isn't the default.
2. Worktree listing and the uncommitted layer (step 3, placement only). This is small and needs no analysis.
3. View branch: snapshots of the tip and fork point, the API, the panel action, and the comparison header.
4. Analyzing a worktree's uncommitted state, if step 2 proves useful.
