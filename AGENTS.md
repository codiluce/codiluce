# Workspace workflow

- Keep `/var/www/html/codiluce` checked out on `main`. Routine updates, fixes, and UI features belong here unless the user requests another branch or worktree.
- The long-running **Plan multilingual framework support** session must use `/var/www/html/codiluce-multilingual` on `framework/multilingual-support` for all implementation, tests, generated validation artifacts, and commits.
- If that session starts in the main checkout, change the working directory to its dedicated worktree before continuing. Do not perform its work in `main` or switch the main checkout to its branch.
- Keep its ongoing changes isolated. Merge that branch into `main` only when the user explicitly requests it.
- Before writing or committing, verify the working directory and branch. Preserve concurrent work from other sessions.

# Report artifacts

- Do not create Cursor Canvas reports or `.canvas.tsx` files to present findings.
- Give routine findings in the conversation. Create a separate report only when a standalone artifact is needed.
- When needed, create a browser-accessible HTML report in a suitable project location and provide its URL or opening instructions.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for codiluce/codiluce, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: needs-triage, needs-info, ready-for-agent, ready-for-human and wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root, both created only when needed. See `docs/agents/domain.md`.
