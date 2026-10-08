# Contributing to Codiluce

Thanks for your interest! Codiluce is young and shaped by the teams who use it, so feedback counts as much as code.

## Feedback

- **Tell us what your team needs.** [Book a 30-minute call](https://calendly.com/mikeltorresugarte-ynlf/30min): your
  stack, your codebase, and what you still cannot see in it.
- **Report what it gets wrong.** [Open an issue](https://github.com/codiluce/codiluce/issues).
  `npx codiluce inspect diagnostics` lists what the analyzers could not prove, which is a good place to start. Remove
  private paths first.
- **Ask for your stack.** Missing a language or framework? Open an issue with a public repository that uses it.

## Develop locally

You need Node.js 22.12 or newer.

```bash
git clone https://github.com/codiluce/codiluce.git
cd codiluce && npm ci
npm start -- /path/to/repository   # index a repository and open the map
```

For the map with hot reload, run `npm run codiluce -- serve --repo /path/to/repository --port 4300` in one terminal
and `npm run dev:web` in another (http://127.0.0.1:4310). The [technical reference](docs/reference.md) covers every
command, the HTTP API and the internals.

One rule for analyzers: **name-only matching never creates an edge.** Prove a relationship with evidence, or report it
as a finding.

## Before a pull request

```bash
npm test            # engine, projection/layout/source and frontend unit/integration tests (Node test runner)
npm run typecheck   # engine and web
npm run build       # engine (tsc) and static UI (next build)
npm run test:package # build/pack, install with production dependencies, and exercise the shipped CLI/UI
npm run test:e2e    # Playwright browser tests against the indexed fixture repository and a scripted Git history (builds the UI first)
```

Browser tests use Playwright's Chromium. Run `npx playwright install chromium` once if it is not cached.

### What the tests cover

History tests run against a scripted Git history (`tests/history-fixture.ts`: an edit, an addition, a file replaced by a directory, a Git rename, a signature change, a removed route, and the backend application moved to another directory). They cover idempotent content-addressed indexing, the tree mirror against `git ls-tree`, application relocation, diff classification and lineage, ghosts and change counts, selection carry-over in both directions of time, timeline-layout stability and non-overlap, blob-backed source and diffs, entity history, the HTTP surface, on-demand indexing, PR markers, the places of the split view (and that the browser groups time-lapse frames as the server does), and the store's timeline navigation; browser tests step through commits, check that nothing moves, and drive the split view.

Fixtures cover both stacks, HTTP provenance (literal, proven base through a singleton service and an environment variable, same-origin, template segments, axios instances, wrapper functions with URL and method from their parameters, nested wrappers, unresolvable wrappers), migrations (create, alter, rename, drop, conditional columns, both foreign-key forms, dynamic names), model mappings (explicit and convention) and table reads/writes, Git metrics across a rename, the analysis cache (replay identical to a fresh index after PHP edits, TypeScript edits and new files; bounds; corrupt entries), call resolution and its coverage counts, effects with response statuses, unresolved calls, ambiguous routes, ignored/generated content, binary/large files, parse failures, stable identities across indexing and relocation, SQLite rollback, and bounded read-only API queries. Visualizer tests cover deterministic and insertion-local layout, projection districts, world/screen transforms, LOD visibility and culling, hit testing, aggregation, deep search navigation, stale-request cancellation, evidence→source navigation, source path/range/symlink/staleness restrictions, the flow catalog (one list, kind and completeness filters, grouping), flows on the map and their playback, blast radius (cross-stack distances and chains, containers, possible callers, commit impact), steps (kinds, folding, conditions, ordering, navigation), branches and waves of flows on the map, condition reading for TypeScript and PHP, and the main browser interactions. No lint configuration exists in this workspace. Target application builds/tests are unaffected by this tool's implementation.

## Releasing to npm

Codiluce is licensed under [MIT](LICENSE). The package is configured for the public npm registry under the name `codiluce`. Publishing builds the CLI and visualizer through `prepack`; consumers receive the built files and only the analyzer's runtime dependencies. The package excludes source/tests, local state, credentials and brand explorations. License notices for the bundled UI libraries and fonts are included in `web/out/licenses/`.

1. [Create an npm account](https://www.npmjs.com/signup) if needed and enable two-factor authentication. Direct publishing requires 2FA or a granular token with bypass 2FA enabled; see [npm's publishing guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/).
2. Run `npm login --registry=https://registry.npmjs.org/`, then `npm whoami --registry=https://registry.npmjs.org/` to check the signed-in account.
3. Check `npm view codiluce --registry=https://registry.npmjs.org/`. An E404 means no package is visible at that name; npm still decides whether the name can be published. If another owner has it, use a scope you own: `npm pkg set name="@YOUR_NPM_USERNAME/codiluce"`, then run `npm install --package-lock-only --ignore-scripts`. The executable remains `codiluce`, and users run `npx @YOUR_NPM_USERNAME/codiluce@latest start .`.
4. Validate the checkout and preview the release contents:

   ```bash
   npm ci
   npm run typecheck
   npm test
   npm run test:package
   npm publish --dry-run
   ```

   The package check builds and packs a real tarball, installs it with development dependencies omitted and install scripts disabled, then verifies the prebuilt UI, API, compiled history workers, shutdown and `npm exec` from outside the checkout. It needs Git for its temporary history fixture.

5. Publish the first release:

   ```bash
   npm publish --access public
   ```

   Complete npm's authentication prompt. After publishing, verify the registry release with `npx codiluce@latest --version` and `npx codiluce@latest start /path/to/a/repository` (use the scoped name if applicable).

For subsequent releases, commit your changes, run `npm version patch` (or `minor`/`major`), repeat validation and publish. Each published name/version pair can be used only once, even after unpublishing; see [npm publish](https://docs.npmjs.com/cli/v11/commands/npm-publish/). `npm pack` can also produce a tarball for testing or sharing before any registry release.
