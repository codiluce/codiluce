<p align="center">
  <a href="https://codiluce.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-on-dark.svg">
      <img src="docs/brand/logo-on-light.svg" alt="codiluce" width="300">
    </picture>
  </a>
</p>

<p align="center">
  <strong>Bring your code to light.</strong><br>
  See how your code fits together, even as agents keep changing it.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/codiluce"><img alt="npm version" src="https://img.shields.io/npm/v/codiluce?color=ffbf47&labelColor=0a0a0b"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-f5f5f3?labelColor=0a0a0b"></a>
  <img alt="Node.js 22.12 or newer" src="https://img.shields.io/badge/node-%E2%89%A5%2022.12-f5f5f3?labelColor=0a0a0b">
</p>

<p align="center">
  <a href="https://codiluce.com">Website</a> ·
  <a href="https://codiluce.com/docs/">Docs</a> ·
  <a href="#contributing">Contributing</a>
</p>

![Codiluce mapping BookStack, an open-source wiki: files drawn as isometric blocks, one class selected and its details in the inspector.](site/public/shots/map.webp)

## Why Codiluce?

Agents write and change code faster than anyone can review it line by line. Codiluce keeps you in the picture: it
reads your repository and draws it as a map you can zoom, search and replay, where every link between pages, requests,
functions and tables comes with the evidence behind it.

## Quick start

Run it inside the repository you want to see:

```bash
npx codiluce@latest start .
```

Codiluce indexes the code, starts a local server and opens the map in your browser. You need Node.js 22.12 or newer.
Add `.codiluce/` to your `.gitignore`: that is where the analysis lives.

Want it always at hand? Run `npm install --global codiluce`, then `codiluce start .` in any repository.

## What you can do

- **Zoom from the whole repository to a single line.** Applications, folders, files and symbols nest inside each other,
  sized by their code.
- **Follow a flow end to end.** From a page or a command, through the request, to the handler and the tables it reads
  and writes.
- **Replay your Git history.** Every commit becomes a snapshot. Compare any two, or watch the architecture change as a
  time-lapse.
- **See the blast radius.** Pick anything and see what depends on it, hop by hop.
- **Check the evidence.** Every link opens the file and line that proves it. What cannot be proven shows up as a
  finding, never as a guess.
- **Add descriptions, if you like.** A language model can describe files, flows and commits, with the cost estimated
  and capped first.

## Private by design

Codiluce runs on your machine. It reads your code but never runs it, never installs its dependencies and never writes
to your checkout. Nothing leaves your computer unless you ask for AI descriptions or GitHub pull request data.

## How deep does it go?

TypeScript and JavaScript are analyzed down to calls and requests across applications and local workspace packages, and supported frameworks down to
routes, commands and tables. Express and Nest have static routing packs for mounted routers and registered controllers,
with handler links and visible gaps. Python, Go, Ruby, Rust, Java, C# and Kotlin also have declaration maps, with source ranges
and nested types/functions. Python also resolves static imports across packages, namespace portions and configured or
manifest source roots, binds local/imported calls and bounded re-exports, and has initial FastAPI, Flask and Django packs for
registered routes, routers/blueprints, URL includes/namespaces, invoked or configured entrypoints, exact function/class view handlers and framework references. Conditional/type-only bindings and dynamic
registration retain visible gaps. The inspector shows which analysis features are available for each file. Other ecosystems
are detected and mapped with their files, lines and Git metrics. Missing
yours? [Tell us](https://github.com/codiluce/codiluce/issues).

Java and Kotlin now resolve original local import declarations within selected Maven reactors, literal Gradle projects
and recorded source/classpath inputs. Explicit, wildcard, static and alias imports retain source evidence and visibility
constraints. Unknown build configuration, excluded sources, binary classpaths and competing declarations stay visible.
Scoped Java/Kotlin references now bind original types and exact signatures for direct static/private/final/concrete calls,
with separate original lambda ownership. Virtual/inherited/generic dispatch, generated constructors and injection retain gaps.
The initial Spring MVC pack supports selected Spring 6.2/7.0 and Boot 3.5/4.0 profiles, resolved controller/mapping annotations,
class/method path arrays, original constant paths, recorded or entry-configuration component scans, direct original handlers,
literal servlet prefixes and bounded PathPattern matching. Parameter restrictions and HTTP HEAD/OPTIONS remain distinct;
unknown headers, negotiation, profiles, custom configuration and registrations stay constrained. Plain Spring is detected
alongside Boot. The initial WebFlux.fn pack adds Java builder chains, Kotlin `router`/`coRouter`, nested/composed routes,
original functional handlers and first-match dispatch under selected reactive profiles and bean registrations.
`jvm.spring.stack: webflux` with `componentScan` or `routers` records a deployment selection; `entrypoints.spring` can
select original Boot or Configuration/EnableWebFlux roots. Unknown predicates, filters, bean ordering and custom
configuration remain visible candidates. No target JVM compiler, build, dependency, plugin or application runs.
C# now resolves original namespace, static, alias and global using directives within indexed SDK/MSBuild compile items,
linked source files and local project references. Literal props/targets imports, recorded target/configuration selections
and original XML `Using` items retain source evidence. Compatible partial types combine member lookup while retaining every
original fragment and compilation identity. Scoped references, exact overloads, direct nonvirtual/concrete calls, original
lambdas, local functions and top-level bodies now retain source proof and call coverage. Overlapping compilations,
conflicting partial declarations, conditional preprocessing, denied sources and executable build behavior remain explicit. `applications[].dotnet` records the selected
project and compilation inputs; `sourceRoots.csharp` can define a compilation when no project is available.
Inherited/generic/dynamic dispatch, conversions, generated constructors, accessors and compiler delegate/task behavior
retain explicit gaps. ASP.NET Core 8–10 now adds serving-reachable minimal hosting, nested route groups, invoked original
source helpers/factories, method groups and natural delegates. Original Web SDK/TFM/framework-reference inputs select a
reviewed family; SDK implicit namespaces require original `ImplicitUsings` selection. `entrypoints.aspnet` can select an
original startup method, and `dotnet.aspnet` records a runtime `version` or external deployment `pathBase`.
Route contracts retain optional/default/catch-all/complex segments, reviewed constraints, order, hosts and explicit methods.
GET does not imply HEAD. Authorization, filters, middleware, custom binding/metadata, changed/escaped hosting values and
conditional startup retain gaps. MVC now adds serving-reachable controller registration through original AddControllers,
AddControllersWithViews/AddMvc and MapControllers/MapControllerRoute/MapDefaultControllerRoute/MapAreaControllerRoute calls.
Original public controller/action discovery, compatible partial fragments, bounded source inheritance, attribute selectors,
controller/action/area tokens, ActionName/Async naming, literal route defaults and native conventional order retain original
handler IDs and source proof. Custom application parts, model/parameter/result metadata, filters, activation and executable
MVC options remain candidates. Wider JVM/.NET qualification is next. No target .NET/MSBuild toolchain runs.

Vue, Svelte and Astro now expose embedded JavaScript/TypeScript declarations, imports, calls and requests at their original
component source locations. Module and instance scopes stay distinct; Astro server and client scripts retain separate contexts.
Vue 3 also links local template components and bounded event callbacks. Vue Router 4/5 manual route records resolve
nested paths, named views, literal lazy imports, aliases and redirects after a proven app installation. Original event
sites enter the existing flow inspector and browser proxy matching. Unsupported dynamic/plugin behavior stays visible.
Svelte 4/5 links parsed local components, scoped snippets and legacy or modern browser callbacks. SvelteKit 2/3 adds
filesystem pages/layouts, loads, HTTP handlers and named POST actions, with static configuration and distinct execution
contexts. RequestEvent fetch and shared registrations keep the invoking application's ownership. Dynamic hooks/matchers
and unsupported syntax retain gaps. Astro 5/6/7 now links original components/layouts, pages, method exports,
static build operations and qualified Vue/Svelte/React islands. Prerendered files stay separate from live APIs;
dynamic configuration, middleware policies and generated URLs retain gaps. Bounded Nuxt conventions are next.

## Learn more

- [Getting started](https://codiluce.com/docs/) and [using the map](https://codiluce.com/docs/map/)
- [History](https://codiluce.com/docs/history/), [CLI & API](https://codiluce.com/docs/cli/) and
  [configuration](https://codiluce.com/docs/configuration/)
- [How it works](https://codiluce.com/docs/how-it-works/), the [technical reference](docs/reference.md) and the
  [architecture](docs/architecture-visualizer.md)

## Contributing

Codiluce is young and shaped by the teams who use it, so feedback counts as much as code.

- **Tell us what your team needs.** [Book a 30-minute call](https://calendly.com/mikeltorresugarte-ynlf/30min).
- **Report what it gets wrong.** [Open an issue](https://github.com/codiluce/codiluce/issues);
  `npx codiluce inspect diagnostics` is a good place to start. Remove private paths first.
- **Send code.** [CONTRIBUTING.md](CONTRIBUTING.md) explains how to run Codiluce from source and test it.

## License

[MIT](LICENSE)
