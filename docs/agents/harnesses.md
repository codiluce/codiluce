# Connecting coding harnesses

Codiluce has adapters for Codex, Claude Code, Cursor, OpenCode, Pi, GitHub Copilot,
Gemini CLI, Cline, Google Antigravity, Windsurf / Devin Desktop (Cascade), OpenClaw
and Hermes Agent. The registry in `src/harnesses/registry.ts` supplies setup,
validation, UI labels, history capabilities and character identities.

Codex and Claude Code retain their established integrations. Other adapters are
experimental: their wire contracts have fixture coverage, but capabilities depend
on the installed product and runtime. MCP, live activity, history and child-agent
attribution are independent. **Agents → Agent connections** shows the distinctions
and generates the files for the selected runtime.

## Setup

From the repository, preview the configuration, then apply it:

```sh
codiluce harness list
codiluce harness setup --agent opencode
codiluce harness setup --agent opencode --apply
codiluce harness setup --agent pi --apply
```

In a source checkout use `npm run codiluce -- harness …` instead. Pass `--repo`
and `--state-dir` when observing a particular worktree or a custom state directory.
The new setup flow binds both MCP and activity to that repository and state.
Unlike the legacy global Codex/Cursor wizard defaults, these generated user-scope
entries also name the specific repository.

Choose a runtime when a family has several:

```sh
codiluce harness setup --agent github-copilot --profile copilot-cli --apply
codiluce harness setup --agent github-copilot --profile copilot-vscode --apply
codiluce harness setup --agent github-copilot --profile vscode-local --apply
codiluce harness setup --agent cline --profile cline-cli --apply
codiluce harness setup --agent cline --profile cline-legacy --apply
```

Copilot CLI uses `.mcp.json`; the VS Code profiles use `.vscode/mcp.json` with
`servers` entries. The VS Code session target determines the harness. Claude or
Codex hosted in VS Code should use the corresponding Claude/Codex adapter.

Project scope is preferred where supported. User-only products automatically use
their user configuration. `--scope project` or `--scope user` makes the choice
explicit. If a destination is managed by the harness UI, setup supplies a snippet
and instructions rather than guessing a settings path. For the Cline editor,
open **Configure MCP Servers** and merge its snippet there.

Setup parses JSON/JSONC/JSON5, TOML and YAML, preserves unrelated settings and
comments, and updates Codiluce-owned hook groups without adding copies. Existing
hooks containing both Codiluce and another command are kept intact. Malformed
files and unsupported inline TOML server tables require a manual merge instead
of a rewrite. Preview output contains Codiluce snippets, not existing credentials.

Choose one installation scope per observer. Native plugins include stable tool
event IDs so repeated tool delivery can be deduplicated. Events without reliable
IDs are retained rather than guessing that identical actions are duplicates.

## Hooks and native extensions

OpenCode uses a project plugin; Pi uses an extension; OpenClaw uses a native plugin
with a manifest. Other products use their own command/file hook configuration.
The existing command remains available:

```sh
codiluce activity hooks --agent codex
codiluce activity hooks --agent opencode
codiluce activity hooks --agent hermes
```

For Codex and Claude this prints the legacy mergeable hook JSON. For other
products it prints the generated observer files and instructions.

Codex definitions still require `/hooks` review/trust. Pi project MCP and
extensions require Pi project trust. Hermes shell hooks retain Hermes consent.
OpenClaw setup writes the plugin files; follow its printed `openclaw plugins
install -l …` instruction and enable the plugin through OpenClaw. Codiluce does
not change plugin allowlists, hook trust or disabled-hook policy.

Cursor and Antigravity pre-tool permission gates are excluded. Their adapters use
observation-only events and return the native no-op output. All observers discard
delivery errors; command forwarding has a 1.5-second network timeout. Native
extensions use bounded queues, do not mutate tool arguments/results, and never
request another model turn. OpenClaw requires a proven configured agent workspace;
messaging sessions are not assumed to belong to the repository.

No agent run, model request, filesystem watcher or remote connection is started
to obtain activity. Remote/cloud runtimes need a collector in their execution
environment and are outside these local profiles. A cloud process cannot reach
the developer machine through its own loopback address.

## Session history

**Import / refresh history** discovers repository-scoped Codex and Claude
transcripts, Pi session trees, Copilot CLI `events.jsonl`, Gemini CLI project chat
files, and OpenClaw JSONL sessions with repository metadata. Pi imports follow the
selected branch. Private reasoning and system instructions are excluded.

All twelve harnesses also accept explicit version 1 session exports:

```sh
codiluce harness import --agent opencode --path /path/to/export.json
```

An OpenCode `opencode export SESSION_ID` JSON export can be passed directly.
For other products without a native reader, use this portable envelope:

```json
{
  "schemaVersion": 1,
  "provider": "hermes",
  "sessionId": "session-id",
  "cwd": "/absolute/path/to/repository",
  "title": "Explain sign-in",
  "messages": [
    { "id": "u1", "role": "user", "text": "Explain sign-in." },
    {
      "role": "tool",
      "callId": "read-1",
      "tool": "read_file",
      "input": { "path": "src/auth.ts" },
      "text": "Tool output available to the user.",
      "status": "completed"
    },
    { "id": "a1", "role": "assistant", "text": "Public answer." }
  ]
}
```

The provider and repository must match the command. `role: "system"`, reasoning
blocks and `channel: "analysis"` are excluded. Imports are stored under
`<state>/agent-exports` and in the existing conversation archive; sources are
bounded to 32 MB and do not follow symlinks. File associations come from literal
tool arguments, never prose. The export workflow does not scan private editor or
Hermes databases. An activity-only session remains usable without history.

## Characters and child actors

Every harness has an original pixel body, with the existing Clawd and blue cloud
preserved. Session color rings distinguish simultaneous sessions. The pose engine,
props, reduced-motion handling and map movement are shared. Bolt is the fallback
for an unknown presentation identity.

A child actor requires an explicit native child instance ID or parent session
relationship. A custom agent definition, shared model, execution/turn ID, or a
parallel tool call is not a child actor. Inferred thinking/reply poses are
illustrative; no reasoning text is collected for them.

## Validation and extending the registry

`tests/harnesses.test.ts` covers native payloads, configuration preservation,
idempotence, plugin callback execution, hook responses and HTTP ingestion for all
twelve. `tests/harness-history.test.ts` covers native trees, visible message
selection and exports. `web/e2e/harnesses.spec.ts` exercises the selectors, session
identities and crew. The existing Codex/Claude activity/history tests remain the
regression baseline.

Real local MCP discovery was checked with OpenCode **1.18.27** and Pi **1.3.0**
(Pi on Node **24.21.0**, Codiluce MCP on Node **22.12.0**). Pi's own resource loader
also loaded the generated extension without errors. These checks do not certify
every event on every editor/CLI release; other new profiles remain experimental.

Add metadata and profiles to the registry, a decoder in `harnesses/activity.ts`
for a nonstandard wire protocol, an optional native collector/history reader,
fixtures and a character. Setup, API validation, MCP history filters, session
selectors and the crew consume the shared registry. Unknown ingestion IDs never
trigger code downloads. Kiro and other candidates can follow this path.
