import { GITHUB_URL, NPM_URL } from './site';

export type Release = {
  version: string;
  publishedAt: string;
  title: string;
  summary: string;
  changes: { title: string; items: readonly string[] }[];
  source?: { href: string; label: string };
  prerelease?: boolean;
};

/** Newest first. Dates come from npm's publication timestamps; notes describe published packages only.
 * Add an entry when publishing and keep the latest stable version in sync with VERSION in site.ts.
 * Sources: https://registry.npmjs.org/codiluce and the corresponding Git tags / published tarballs.
 * 0.1.1 shares 0.1.0's runtime bundles: the later Flows fix first shipped in 0.2.0.
 */
export const RELEASES: readonly Release[] = [
  {
    version: '0.5.0',
    publishedAt: '2026-11-12T12:59:56.284Z',
    title: 'One column. A guided way into your code.',
    summary: 'A simpler map layout, a tour of your own repository and more reliable agent connections.',
    changes: [
      { title: 'Added', items: [
        'A first-visit tour follows a file through the map, search, code, flows, dependencies and history in your own repository. Optional chapters introduce agents, explanations, people, pull requests, features and settings.',
        'Setup connects agents to their MCP server and installs activity hooks for this repository, so their work appears in Agents. Local hook settings stay out of Git; Codex asks you to trust new hooks in /hooks.',
        'The Explain view identifies agents using another Codiluce version and offers the setup command that reconnects them to the map’s version.',
      ] },
      { title: 'Improved', items: [
        'A rail on the left opens one shared, resizable column for selection, code, impact, flows, dependencies, people, pull requests, explanations and agents. Selecting code keeps the current view open; Color by lives on the map.',
        'Dependencies follow the selection while their view is open, and Impact keeps its results when you change views.',
        'Agent setup pins npx commands to the running Codiluce version. Activity hooks start the cached package directly, falling back to npx if the cache was cleared.',
      ] },
      { title: 'Fixed', items: [
        'Agent connection detection and recovery handle servers bound to another repository or installation, and failed connection and session checks offer a retry.',
        'Older MCP servers can still show explanation progress when they report an explicit explanation title or question.',
        'Updated the bundled map’s build dependency to the patched Next.js 16.4.6 release and clarified the composer’s missing API key message.',
      ] },
    ],
    source: { href: `${GITHUB_URL}/compare/v0.4.0...v0.5.0`, label: 'Compare changes' },
  },
  {
    version: '0.4.0',
    publishedAt: '2026-10-19T11:42:34.045Z',
    title: 'Follow your agents. Explore every connection.',
    summary: 'Agent characters and session replays, guided explanations, a 2D plan and dependency maps bring the code into focus.',
    changes: [
      { title: 'Added', items: [
        'Agent characters move between the files they read and edit, split for parallel work and wait in a queue while thinking or running commands. Browse saved sessions and replay them step by step with playback controls.',
        'Explanation tours tell a story in scenes on the map, with diagrams tied to indexed code. Search reusable question templates, fill their placeholders and ask in the map or through your agent.',
        'Switch between the 3D map and a 2D plan with labels that avoid overlaps. Select code to follow its dependencies and inspect the evidence behind each connection.',
        'Shared adapters for twelve coding harnesses, with MCP, activity and session-history capabilities depending on the harness. Experimental adapters and their limits are documented in the agent guide.',
        'Browse each file’s Git evolution, with architecture snapshots available on demand.',
      ] },
      { title: 'Improved', items: [
        'Setup loads the complete Git history in the background without asking for a depth. The map opens with calmer defaults, and analysis follows more Node HTTP routers, fetch wrappers and object methods.',
        'Further bounded parser and history processing, with compatibility and performance qualification across the supported language and framework packs.',
      ] },
    ],
    source: { href: `${GITHUB_URL}/compare/v0.3.0...v0.4.0`, label: 'Compare changes' },
  },
  {
    version: '0.3.0',
    publishedAt: '2026-10-15T14:06:06.840Z',
    title: 'See your agents at work.',
    summary: 'Live agent activity, explanations as they are written, pull requests and code health arrive on the map.',
    changes: [
      { title: 'Added', items: [
        'Follow live Claude Code and Codex sessions through activity hooks: see which files an agent reads, edits or searches while it works.',
        'An explanation working card shows what an agent is explaining and the tools it calls before its answer is published.',
        'Open and merged pull requests light up the files they change, with their commits and impact.',
        'Code health metrics in the Inspector and Color by lenses for complexity, recent changes and hotspots.',
      ] },
      { title: 'Improved', items: [
        'Continuous flow playback, clearer flow controls, refined map shapes and area summaries, and saved map visibility settings.',
        'Bounded parser and compiler transfers, memory limits and worker recovery make large analyses and Git histories more resilient.',
      ] },
    ],
    source: { href: `${GITHUB_URL}/compare/v0.2.0...v0.3.0`, label: 'Compare changes' },
  },
  {
    version: '0.2.0',
    publishedAt: '2026-10-14T11:28:33.886Z',
    title: 'Ask your agent. Read the answer on the map.',
    summary: 'MCP explanations, first-run setup and a much wider set of languages and frameworks.',
    changes: [
      { title: 'Added', items: [
        'Connect coding agents over MCP to read the indexed graph and publish explanations. Their links highlight the files, symbols and flows they describe in the Explain column.',
        'Ask questions directly in the map with your own API key. A first-run setup guides history indexing, optional model keys and agent connections.',
        'Framework analysis expands to Python, Vue, Svelte, Astro, Nuxt, Go, Ruby and Rails, Java and Kotlin with Spring, C# with ASP.NET, and Rust. Each pack records its evidence and limits.',
        'Source structure for additional languages and embedded templates, including C, C++, Objective-C, Swift, Scala, Groovy, F#, VB.NET, ERB, Razor and Liquid.',
      ] },
      { title: 'Improved', items: [
        'Branching request flows play on the map. Parser workers, caching and historical snapshots have tighter memory and lifetime bounds, with published compatibility evidence.',
      ] },
      { title: 'Fixed', items: [
        'Fixed the Flows panel repeatedly reloading when its view identity did not match the active map grouping.',
      ] },
    ],
    source: { href: `${GITHUB_URL}/compare/0c092657c6db3023d7809911677f32b35b17963e...v0.2.0`, label: 'Compare changes' },
  },
  {
    version: '0.1.1',
    publishedAt: '2026-10-08T08:47:40.114Z',
    title: 'A home for the project.',
    summary: 'Package links now point to codiluce.com and the Codiluce GitHub organization.',
    changes: [
      { title: 'Updated', items: [
        'Corrected the npm homepage, repository and issue tracker links. This packaging update keeps the same CLI and map bundles as 0.1.0.',
      ] },
    ],
  },
  {
    version: '0.1.0',
    publishedAt: '2026-10-08T08:34:20.072Z',
    title: 'Bring your code to light.',
    summary: 'The first usable npm release: a local, interactive map of your repository and its history.',
    changes: [
      { title: 'Added', items: [
        'Start with npx codiluce@latest start .: the package includes the compiled CLI and prebuilt map, with no target application build required.',
        'An evidenced graph for Next.js and Laravel, with TypeScript and JavaScript analysis, frontend-to-backend request flows and database tables.',
        'A zoomable isometric map with search, an evidence inspector, source code, flow playback and themes.',
        'Git history snapshots, architectural and source diffs, authorship and blast radius, plus optional model-generated descriptions and feature grouping.',
      ] },
    ],
    source: { href: `${GITHUB_URL}/tree/0c092657c6db3023d7809911677f32b35b17963e`, label: 'Browse source' },
  },
  {
    version: '0.0.0-stage',
    publishedAt: '2026-10-08T08:32:11.666Z',
    title: 'Preparing the first release.',
    summary: 'A temporary npm placeholder used to set up publishing before the first usable release.',
    prerelease: true,
    changes: [],
  },
];

export const releaseId = (version: string) => `v${version}`;
export const releaseHref = (version: string) => `/releases/#${releaseId(version)}`;
export const npmReleaseHref = (version: string) => `${NPM_URL}/v/${version}`;
export const releaseDate = (publishedAt: string) => new Intl.DateTimeFormat('en', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
}).format(new Date(publishedAt));
