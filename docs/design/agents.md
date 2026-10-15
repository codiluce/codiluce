# Agents: observed activity on the map

Developed in `/var/www/html/codiluce-agents`, branch `feature/live-agents`.

The **Agents** button opens a panel beside the map, like the other navigation
tools. It lists Codex and Claude Code sessions, their observed runtime status,
session titles when available, recent file actions, searches and commands. Select a session to filter the feed
and map. Select a file path to reveal the exact file, including files hidden from
the map. If the file is missing from the current index, this explicit click refreshes
the repository index before selecting it. Deleted or excluded files show an explanation
instead of silently selecting their folder. Search scopes can select their nearest
indexed folder. The map keeps its current camera until a path is selected.

## Connect

Start Codiluce for the repository, then open **Agents → Agent connections** in
the panel footer. This opens a modal, keeping setup out of the activity feed.
Copy the configuration for the chosen product and merge the `hooks` entries
into its settings, preserving existing entries:

- Codex: `<repo>/.codex/hooks.json`. Review and trust the definitions with
  `/hooks` before using them. Hooks must be enabled and supported by the runtime.
- Claude Code: `<repo>/.claude/settings.local.json`. Restart if the running
  session does not pick up the new settings.

The CLI can print the same mergeable configuration:

```sh
npm run codiluce -- activity hooks --agent codex --repo /path/to/repository
npm run codiluce -- activity hooks --agent claude-code --repo /path/to/repository
```

Installed packages use `codiluce activity hooks ...` instead. Pass
`--state-dir` if the map uses a custom state directory. The generated command
binds observations to that repository and state directory, including a specific
worktree. It does not change either agent's configuration automatically.

The lightweight hook receives the product's JSON on stdin and forwards it to
the loopback address in `<state>/serve.json`. It sends no hook decision or
context back to the agent. Malformed input, a missing server, network failure
or disabled activity is ignored; network delivery times out after 1.5 seconds.
No API key, model call, transcript access, or app-server launch is required.

## What is observed

- Hook lifecycle events identify sessions, tool invocations and completions,
  explicit permission requests, stopped turns and finished sessions. A stopped
  turn is idle; it does not mean the whole session has finished. Runtime claims
  become unknown after five minutes without an observation.
- Direct file reads and edits, patch headers (including old and new paths for
  moves), and explicit grep/glob scopes carry repository-relative paths.
- A small set of literal shell reads (`cat`, `head`, `tail`, `sed -n 'Np'`) and
  simple `rg`/`grep` searches are interpreted. Pipelines, shell expansions,
  scripts and unfamiliar flags stay commands with no claimed file access.
  Known test commands are labelled as tests. Raw commands are not retained.
- There is no filesystem activity watcher. Only hook observations with a session
  identity enter the feed and map. Changes made by commands whose paths cannot be
  interpreted are not assigned invented file attribution.

Hooks do not cover all execution paths. An agent id is used only when the
provider includes one; in particular, Codex can identify a subagent lifecycle
while reporting tool hooks under its parent session id. No extra attribution
is inferred. Search results do not mark every result or every descendant as read.
Tool starts describe an attempted action; only completions confirm success.

## Rendering and transport

`GET /api/agents` returns a snapshot. `GET /api/agents/stream` streams snapshots
as server-sent events, initially and on changes, with a heartbeat. Reconnection
gets the current bounded snapshot rather than duplicating events. The live
connection stays mounted when the panel is closed.

`POST /api/agents/events` accepts `{ provider: "codex" | "claude-code", payload }`
with JSON content type and `X-Codiluce-Request: activity`. It normalizes the
provider payload, rejects foreign working directories and repository escapes
(including symlink escapes), and resolves paths against the current index.
There is no cross-origin CORS grant. `GET /api/agents/setup` supplies the hook
snippets for this running installation.

Events are held only in memory: at most 500 events and 100 sessions. Prompts,
transcripts, file contents, patch bodies and command output are discarded.
Only paths, search queries, tool identities, session titles and lifecycle metadata are kept.
Restarting the server clears the feed. Events while the map is stopped are
not queued or replayed.

Agent colors are stable per provider/session/explicit agent id. File badges
collapse to their visible ancestors when zoomed out; searches outline their
scope. Multiple agent badges may share a block. Marks fade over 30 seconds,
respect the overlay toggle and session filter, and are suppressed in history.
Shared badges signal overlap, not a proven conflict.

`--read-only` disables ingestion and index refreshes from activity. Incoming
observations do not automatically index architecture or move the camera. Only
clicking an observed, unindexed file requests a refresh through
`POST /api/agents/reveal` (an event id and path index, with the activity request
header). This endpoint cannot index an arbitrary client-supplied path. Retained
observations resolve against the latest index, so folder fallbacks do not persist
after indexing. The selected file is then revealed and focused on the map.

## Connection status and titles

The inline information icon explains activity coverage and the server connection.
The footer modal distinguishes detected configuration, provider-reported trust or
disabled settings, and observed hook delivery. A last-delivery timestamp does not
expire into a disconnected claim just because a session is idle. Receiving an event
is not treated as proof of saved trust. Setup snippets are initially expanded only
when no configuration or delivery has been found.

Codex metadata is read through short-lived, bounded local `codex app-server`
requests: `hooks/list` provides discovered definitions and trust states,
`config/read` provides the saved hooks feature setting, and metadata-only
`thread/read` supplies a title for an observed session in this repository. No thread
is started or resumed; no turn runs, trust changes, or transcript is retained.
When this interface is unavailable, configuration-file detection and observed
delivery remain available, and trust is unknown. The modal refreshes its check on
open or **Check again**; title lookups are throttled to once per actor per 30 seconds.
Claude custom `session_title` metadata is retained from hook input. Missing titles
fall back to the provider and short session id; prompts are never used as titles.

## Future adapters

An app-server adapter can forward observed Codex JSON-RPC notifications into
the same normalized model when a host already owns that connection. This first
version does not attach to unrelated app-server sessions or start agent runs.
The metadata-only helper described above does not become the conversation host.
Hooks let existing Codex and Claude Code sessions participate without Codiluce
becoming their conversation host.

Protocol references: [Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Codex app-server](https://learn.chatgpt.com/docs/app-server),
[Claude Code hooks](https://code.claude.com/docs/en/hooks).
