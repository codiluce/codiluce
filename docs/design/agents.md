# Agents: observed activity on the map

Twelve harness families now share a registry and adapters: Codex, Claude Code, Cursor,
OpenCode, Pi, GitHub Copilot, Gemini CLI, Cline, Antigravity, Cascade (Windsurf / Devin
Desktop), OpenClaw and Hermes. See the [connection guide](../agents/harnesses.md) for
setup commands, runtime profiles, history coverage and validation limits. The
[compatibility roadmap](agent-harness-compatibility.html) records the original plan.

Developed in `/var/www/html/codiluce-agents`, branch `feature/live-agents`.

The **Agents** button opens a panel beside the map, like the other navigation
tools. It combines searchable connected harness sessions with observed runtime status,
correlated by provider and session ID. Active agent sessions rise to the top. Select one to read
human and assistant messages; consecutive tool calls and observed activity are collapsed.
The same panel can expand for reading and dock again without losing its filters or reading position.
Opening a session keeps only its characters on the map; pointing at a session in the list dims the
other sessions' characters. Select a file path to reveal the exact file, including files hidden from
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

For any registered harness, `codiluce harness setup --agent NAME` previews MCP and
activity files; append `--apply` to install. OpenCode and Pi use native plugins or
extensions. OpenClaw supplies a plugin and manifest; follow its printed enablement
instructions. Hermes uses native shell hooks. The connection dialog selects the
runtime and shows independent MCP configuration, activity and history information.

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
- Literal shell reads (`cat`, `head`, `tail`, `sed -n 'Np'`) and simple
  `rg`/`grep` searches are interpreted, including batches separated by `&&`,
  semicolons or newlines. Common read options such as `head -n 80`, `tail -n +20`
  and `cat -n` are supported, with quoting and explicit tool working directories
  respected. In mixed read/search batches, explicit file reads take precedence;
  search scopes are not counted as file reads. Pipelines, shell expansions,
  scripts, directory changes and unfamiliar flags stay commands with no claimed file access.
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

`POST /api/agents/events` accepts `{ provider: <registered harness ID>, payload }`
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

With **Show agents on the map** on (the default, remembered), each agent is a
pixel character on the map itself, in either projection. It hops to the file it
reads, edits or searches (inside a closed area it stands on that area's roof,
and a search outlines its scope), and steps outside, beside the map's edge, for
what is about no file: thinking, the reply, planning, the web, commands, waiting
for permission. Files worked on at the same time split the character: parallel
calls and batched reads send a copy to each file, which comes back when its call
completes. A small square in the session's color floats over each character and
its copies; the same square marks the session's row in the Agents list (subagents
wear their session's color). Characters carry no name label. Colors are stable
per provider/session. Characters on one block stand side by side; that signals
overlap, not a proven conflict. They respect the session filter and are not shown
in history.

The map itself is not dimmed or relabelled while agents work: it keeps its own
granularity, and the characters and their block outlines are the only marks. A
running session's card lists the files and folders of its current turn, newest
first, with the session's square beside those its characters stand on now. A
file that is not yet in the index is shown on its nearest indexed folder, and the
card says so.

Hooks see tool calls, not what a script does. A command that reads many files
from one script (for example `python - <<PY ... PY`) is one command with no file
attribution: the character stays beside the map, running a command. Reads made
with the harness's read tool or with literal `cat`/`head`/`sed -n` commands are
attributed.

**Replay on the map** (in a finished session's reader) plays that session again
from its saved transcript, alone on the map: prompts are thinking, the reply that
ends a turn is writing, and tool calls hop to the files they named, calls made
within a second of each other splitting the character as before. Runs of calls
that named no file go by quickly, so the time goes to the files; a replay lasts
at most 90 seconds (the latest steps of a longer session). `GET
/api/conversations/<id>/replay` returns the latest 1,000 prompts, replies and tool
calls in order, each call with its paths resolved against the current map. It
works in read-only mode and needs an imported transcript.

`--read-only` disables ingestion and index refreshes from activity. Incoming
observations do not automatically index architecture or move the camera. Only
clicking an observed, unindexed file requests a refresh through
`POST /api/agents/reveal` (an event id and path index, with the activity request
header). This endpoint cannot index an arbitrary client-supplied path. Retained
observations resolve against the latest index, so folder fallbacks do not persist
after indexing. The selected file is then revealed and focused on the map.

Explanations activate only through an explicit explanation prompt or `start_explanation`; ordinary
MCP reads do not start an explanation. Old inferred activity records are ignored.

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

## Agent session history

**Import / refresh history** saves available project transcripts locally, independently of
live hook observations and the rebuildable architecture index. While Agents is open,
recently observed sessions refresh every ten seconds. Live history refresh only reads transcript
filenames matching observed provider/session IDs; it does not reimport unrelated history.
Session lists are prefetched alongside the map and cached across panel opens. The default first page of
30 summaries is persisted in browser storage for up to seven days (128 KB maximum), scoped by repository
root and state directory; full transcripts are not stored in the browser. Filtered pages use a bounded
in-memory cache. Revalidation retains visible rows and uses ETags; local imports and imports from other
processes invalidate them. Hidden tabs release their live event stream and reconnect when visible.
Canonical links use `#sessions=list` or `#sessions=<provider:session-id>` with optional `message`;
legacy `conversation` fragments remain readable. A six-position, four-dot clockwise animation identifies
running agents in the menu and public update; reduced-motion preferences use a static indicator.
Public progress and response text is read from a bounded 512 KB transcript tail every three seconds;
only the newest update is displayed in each running session card. Private reasoning is excluded.
Current-turn file observations stay listed while the agent is running, and clear when it becomes idle.
Codex setup messages remain in the archive but are hidden in the session reader. The UI filters are a
single row: text, agent and file/folder. Messages can lag hook activity. Sessions without available transcripts retain their observed
activity and show a pending explanation. Refresh does not move the reader; **Latest messages**
lets the reader move explicitly. File and folder filters continue to use literal tool associations.

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

Native Pi session trees, Copilot CLI events, Gemini CLI project chat files and
repository-scoped OpenClaw JSONL can also be imported. All twelve families accept
explicit session exports; OpenCode's native JSON export can be imported directly.
The capability notes distinguish these paths from automatic history discovery.
