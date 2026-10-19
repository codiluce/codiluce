# Initial setup

A first-run configurator for `codiluce start`, designed 2026-10-10. This is the original design;
the configurator is now implemented. History setup now loads all first-parent Git commits and file changes
automatically, without asking for a depth or precomputing architecture snapshots. See the
[current history behavior](../architecture-visualizer.md#13-history).

## Why

Today `start` analyzes the working tree and opens the map, and nothing else:

- **History:** `start` never indexes commits, and it disables indexing on request. The History panel says
  `Run: npm run codiluce -- history index …`, which only works in a source checkout.
- **Descriptions** (`annotate`): these cost money. They're only offered as a separate command, and the user must find
  it in the docs.
- **Persistence:** it's unclear what survives a run through `npx`, which costs money to redo, and where an API key
  should be kept.

The configurator asks a few questions on the first run and saves the answers. Every later `start` then does the right
thing without flags, and it never spends money without the user's consent.

## What persists, by install method

The tool's install method doesn't affect the user's data. All results are written to the state directory,
`<repo>/.codiluce/`, and npx doesn't touch it:

| | `npx codiluce@latest` | `npm i -g codiluce` | `npm i -D codiluce` (JS repos) |
|---|---|---|---|
| Tool files | npx cache (`~/.npm/_npx`) | global prefix | `<repo>/node_modules` |
| Version | newest release on every run | fixed until `npm update -g` | fixed by the lockfile, shared with the team |
| `.codiluce/` (map, history, descriptions) | kept | kept | kept |
| `.env` beside the tool | lost when the cache changes | lost on upgrade | lost on reinstall |

So what's temporary under npx is the **version**, not the data. A version change has costs:

- **History (time, no money):** analyzer versions are part of the snapshot identity (`historyIdentity`). After an
  upgrade, every snapshot shows as "stale analysis" and `history index` analyzes every commit again. That's about 18 s
  per commit on this repository.
- **Descriptions (money, partial):** an annotation is reused when its `content_key` and `prompt_version` match.
  The content key is a digest of the request, which includes analyzer facts (calls, renders, tables, effects). When
  an upgrade changes those facts for a file, that file's description is out of date, and refreshing it costs money.
  A `prompt_version` bump makes a whole task out of date. Old descriptions are never deleted (`AnnotationStore.prune`
  has no callers), so they keep showing until they're refreshed.
- **The API key:** `openAiKey` reads `.env` from the tool directory. That directory is temporary under npx and is
  replaced on a global upgrade. The other location it reads, the state directory, is inside the repository, and
  `.codiluce/` isn't ignored by Git, so a key there could be committed by mistake.

Descriptions can also be lost in ways unrelated to npx: deleting `.codiluce/`, running `git clean -fdx`, cloning the
repository again, or moving to another computer. For scale, the annotations of `.codiluce/etengabe` (943 files, 315
flows, 315 commits) take 0.9 MB and cost $0.35. `history.db` beside them takes 187 MB.

The design makes the state durable whatever the install method, and it makes version changes visible instead of
silent. It doesn't require an install, and `npx codiluce@latest start .` stays the quickstart.

## Where settings live

Settings live in three places. Earlier entries in this list win:

1. **Flags for one run:** `--history`, `--no-history`, `--describe`, `--max-cost`, `--yes`.
2. **Repository:** `<repo>/.codiluce/config.yml`. It already holds `repository`, `applications`, `ignore` and
   `maxFileBytes`. It gains the `history` and `annotations` sections shown below.
3. **User, on this computer:** `~/.config/codiluce/config.yml` (`$XDG_CONFIG_HOME`; `%APPDATA%\codiluce` on Windows).
   It holds the defaults used for new repositories.
4. Built-in defaults.

```yaml
# <repo>/.codiluce/config.yml (new sections)
history:
  depth: 50              # commits, a Git date such as "6 months ago", all, or none
  onDemand: true         # index a commit when it's opened in the timeline
annotations:
  enabled: false
  tasks: [files, flows, folders, domains, overview, commits, chapters]
  refresh: manual        # manual: show what's out of date and its cost; auto: refresh below autoMaxCost
  autoMaxCost: 0.50      # US dollars per start, used only when refresh is auto
  maxCost: 10            # US dollars per run, as --max-cost
```

```yaml
# ~/.config/codiluce/config.yml
defaults:                # same shape as the repository sections
  history: { depth: 50 }
  annotations: { enabled: false, refresh: manual }
askOnFirstRun: true      # false: new repositories take these defaults without questions
```

**The API key** is stored in `~/.config/codiluce/credentials`, in dotenv format so `process.loadEnvFile` can read it,
with mode 0600. Lookup order:

1. `OPENAI_API_KEY` in the environment.
2. The user credentials file.
3. `.env` in the state directory. This is the current location and stays supported. Codiluce warns when Git doesn't
   ignore that file.
4. `.env` in the tool directory, for source checkouts only.

The key is never written inside the repository, and it's never sent through the browser.

**A small run record** in `.codiluce/state.json` holds `{ "setup": 1, "version": "0.2.0", "lastStart": "…" }`. It
tells a first run apart from a version change. `config.yml` stays a file people edit by hand.

**`.codiluce/.gitignore`**, containing `*`, is written on the first run, the same way `.pytest_cache` and `.ruff_cache`
hide themselves. The user's root `.gitignore` is never changed. If something under `.codiluce/` is already tracked
(`git ls-files .codiluce`), Codiluce doesn't write the file and only prints a note.

## The first run

The configurator runs when `start` finds no `config.yml`, or finds one without a `history` or `annotations` section.
It then asks only the missing questions, so existing users are asked once after the upgrade. `codiluce setup` runs the
same questions again whenever the user wants.

It asks **after** analyzing the working tree and **before** opening the browser. By then the numbers are real: the
first analysis has no cache, so its duration is a fair cost per commit, and the description estimate (`estimate()`)
works offline. Asking before the browser opens matters because the browser takes focus, and a question waiting in
the terminal would go unseen. Only the first run waits, for two questions.

```
[2/4] Analyzing the repository… done in 14 s (943 files, 12,408 entities)

Set up this repository. Enter keeps the default; change it later with `codiluce setup`.

History: main has 1,284 commits. Each takes about 14 s, 6 at a time, in the background while you use the map.
  1) The last 50 commits, about 2 min           (default)
  2) The last 6 months: 212 commits, about 8 min
  3) All 1,284 commits, about 50 min
  4) None. A commit is still indexed when you open it in the timeline.
>

Descriptions: OpenAI can describe the files, flows and folders in plain English. Your OpenAI account pays for it.
Estimate for this repository: about $0.30. Descriptions are saved in .codiluce/ and aren't paid for again unless
the code they describe changes.
  1) Not now                                    (default)
  2) Yes
> 2
OpenAI API key (hidden): ****
Keep the key for all repositories on this computer (~/.config/codiluce/credentials)? [Y/n]
Measured with one request per small task ($0.002, answers kept): $0.34. Describe now? [Y/n]
When the code changes later:
  1) Show me what's out of date and its cost; I run it   (default)
  2) Refresh automatically when it costs less than $0.50 per start
>
Use these answers for new repositories too? [y/N]

Saved to .codiluce/config.yml. .codiluce/ is hidden from Git.
You ran Codiluce through npx@latest. Your results stay in .codiluce/, but each new version analyzes history again.
To keep one version, run: npm install --global codiluce
```

Then `start` continues:

- **[3/4] Starting the local server.** The browser opens. On-demand history indexing is on by default for `start`;
  `serve` keeps it opt-in.
- **[4/4] Background work:**
  - History is indexed to the configured depth, newest commits first.
  - When the user agreed, descriptions are written with `maxCost` set to the measured estimate × 1.25.
  - Commit and chapter descriptions wait for their history.
  - Progress is shown in the terminal and in the History panel (`indexing` in `/api/history`).

**Non-interactive runs** take the user defaults, then the built-in ones, and print what they chose. A run is
non-interactive when stdin or stdout isn't a TTY, `CI` is set, or `--yes` is passed. These runs never ask and never
spend, unless `annotations.refresh: auto` was written in the repository config.

## Every later start

Later starts print one status line per area and ask nothing:

```
History: 50 of 1,284 commits indexed; 3 new commits are being indexed in the background.
Descriptions: 12 files changed since they were described (about $0.01). Run `codiluce annotate`.
```

With `refresh: auto`, when the refresh is under `autoMaxCost`, the second line becomes "refreshing in the
background". Above the limit, Codiluce prints the line as shown and doesn't spend.

**After a version change**, which `state.json` records, `start` says what will be redone before redoing it:

```
Codiluce was updated (0.1.1 → 0.2.0), and the analysis changed:
  History: 50 snapshots will be analyzed again in the background (time only, no cost).
  Descriptions: kept. 87 of 943 file descriptions are out of date; refreshing them costs about $0.03.
```

Stale snapshots stay visible, marked as they are today, until their replacements are ready. Before any migration
of the `annotations.db` schema, a copy is saved as `annotations.db.bak`, because that file is the only result that
cost money.

## Detection

- **Install kind,** from `toolDirectory()`:
  - `npx`: the path contains `/_npx/`.
  - `checkout`: `web/app/page.tsx` exists.
  - `project`: the path is under `<repo>/node_modules`.
  - `global`: any other location.

  The install hint is printed only for `npx`, and only once per version.
- **Shallow clone:** when `git rev-parse --is-shallow-repository` returns true, history is skipped with a
  one-line explanation. Codiluce doesn't run `git fetch --unshallow` itself.
- **Not a Git repository:** the history and people questions are skipped.

## Browser (later)

The map gets a "This repository" settings section. It shows the same settings, history progress, and out-of-date
descriptions with their cost. A "Describe" button needs a POST endpoint that spends money. Any web page can send
requests to `127.0.0.1`, so the endpoint must require a random token that `start` puts in the URL it opens, as
Jupyter does. The API key is still entered only in the terminal.

## Build order

1. `state.json`, `.codiluce/.gitignore`, user config directory, new key lookup, and the version-change notice.
2. The `history` section, background history in `start`, on-demand indexing on by default, shallow-clone check, and
   the npx command in the empty History panel.
3. `codiluce setup` and the first-run questions for history.
4. The `annotations` section, its first-run questions, the `refresh` policy, and the out-of-date summary on start.
5. The browser settings section and the token-protected "Describe" endpoint.

## Open questions

- **When to ask:** after the first analysis, with real numbers but a few seconds' wait on the first run, as above?
  Or before it, with rough numbers and no wait?
- **Default history depth:** 50 commits or 6 months? A count gives a predictable time; a date matches how people
  think about history.
- **Sharing descriptions with the team:** they're small (0.9 MB for 943 files) and are the only results that cost
  money. Options:
  - Keep them local (current behavior).
  - Allow `annotations.db` in `.codiluce/.gitignore`. It's a binary file, so the last writer wins.
  - Add an `annotations export` to a text file that Git can merge.
- **The README quickstart:** keep `npx codiluce@latest start .`, and rely on the configurator's install hint for
  regular users?
