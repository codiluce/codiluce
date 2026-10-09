import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock } from '../../../components/CodeBlock';
import { DocsPager } from '../../../components/DocsNav';
import { StackStatus } from '../../../components/Stacks';
import { INSTALL, ISSUES_URL, VERSION } from '../../../lib/site';
import { DETECTED, PUBLISHED } from '../../../lib/stacks';

export const metadata: Metadata = {
  title: 'Languages & frameworks',
  description: 'Which languages and frameworks Codiluce analyzes, how deep it goes in each, and what stays a visible gap.',
};

interface Framework { id: string; name: string; logo?: string; versions?: string; reads: React.ReactNode; gaps?: React.ReactNode }
interface Ecosystem { id: string; name: string; languages: string[]; summary: React.ReactNode; frameworks: Framework[] }

const ECOSYSTEMS: Ecosystem[] = [
  {
    id: 'javascript', name: 'JavaScript & TypeScript', languages: ['typescript', 'javascript'],
    summary: <>One type-checked program per application, over its own files only (never <code>node_modules</code>): imports, components, functions, classes, calls, JSX renders, callbacks, and HTTP requests through <code>fetch</code>, axios and your own wrappers. npm, Yarn and pnpm workspaces resolve across packages. Vue, Svelte and Astro files expose their scripts at their original lines.</>,
    frameworks: [
      { id: 'react', name: 'React', reads: <>Components, JSX renders, handlers and callbacks passed as props, functions wrapped in <code>useCallback</code> or held in <code>useMemo</code>, and the requests each component makes.</>, gaps: 'Calls through untyped values stay counted, never guessed.' },
      { id: 'nextjs', name: 'Next.js', versions: 'App Router', reads: <>Pages with their layouts, templates and loading, error and not-found files; route handlers per exported HTTP method; dynamic, catch-all, group and parallel segments; server actions and navigation (<code>useRouter</code>, <code>redirect</code>, <code>notFound</code>).</>, gaps: 'The Pages Router, intercepted routes and rewrites.' },
      { id: 'express', name: 'Express', versions: '4 · 5', reads: <>App and router instances, nested and repeated <code>use</code> mounts, chained <code>route</code> verbs, path and handler arrays, registration helpers, with imported and inline handlers. GET includes HEAD.</>, gaps: 'Opaque regular expressions and paths built at runtime.' },
      { id: 'nestjs', name: 'NestJS', reads: <>Routes reachable from <code>NestFactory.create</code>: modules and controllers, controller and global prefixes, <code>RouterModule</code>, versions, Express or Fastify. Guards, pipes, interceptors and injected services become references.</>, gaps: 'Dynamic modules and custom composite decorators.' },
      { id: 'vue', name: 'Vue & Vue Router', versions: 'Vue 3 · Router 4–5', reads: 'Single-file components with their template components and event callbacks; route records with nested paths, named views, lazy imports, aliases and redirects.', gaps: 'Plugins and routes added at runtime.' },
      { id: 'nuxt', name: 'Nuxt', versions: '3 · 4', reads: 'Pages, components and Nitro server routes, linked to the requests that reach them.' },
      { id: 'svelte', name: 'Svelte & SvelteKit', versions: 'Svelte 4–5 · Kit 2–3', reads: 'Components, snippets and browser callbacks; filesystem pages and layouts, load functions, HTTP handlers and form actions, each in its own execution context.', gaps: 'Dynamic hooks and matchers.' },
      { id: 'astro', name: 'Astro', versions: '5–7', reads: 'Components and layouts, pages, endpoint method exports, and React, Vue or Svelte islands. Prerendered pages stay apart from live endpoints.', gaps: 'Middleware and generated URLs.' },
    ],
  },
  {
    id: 'php', name: 'PHP', languages: ['php'],
    summary: <>Namespaces, imports, classes, methods and inheritance in every PHP file; calls through <code>$this</code>, typed parameters and properties, <code>new</code> and <code>app(X::class)</code>. Framework analysis runs in Laravel applications.</>,
    frameworks: [
      { id: 'laravel', name: 'Laravel', reads: <>Routes registered from <code>bootstrap/app.php</code> with their groups, controllers and invokable handlers; Artisan commands and scheduled tasks; dispatched jobs; migrations replayed into tables, columns and foreign keys; Eloquent models with the tables they read and write.</>, gaps: 'Resource routes, conditional registration and routes from packages.' },
      { id: 'inertia', name: 'Inertia', reads: <>Visits, <code>useForm</code>, <code>&lt;Link&gt;</code> and <code>&lt;Form&gt;</code> become requests, and <code>Inertia::render</code> links each endpoint to its page component, so a flow runs from the click to the table.</> },
    ],
  },
  {
    id: 'python', name: 'Python', languages: ['python'],
    summary: 'Static imports across packages, namespace packages and source roots; local and imported calls and bounded re-exports. No Python interpreter runs.',
    frameworks: [
      { id: 'django', name: 'Django', versions: '5.2', reads: <>URLconfs from <code>ROOT_URLCONF</code> or configured entry points, <code>include</code> and namespaces, path converters and simple <code>re_path</code>; function views with their method decorators; class-based views such as <code>ListView</code> and <code>DetailView</code>.</>, gaps: 'Django REST Framework, the admin and internationalized URLs.' },
      { id: 'fastapi', name: 'FastAPI', versions: '0.115 · 0.141', reads: <>App and router decorators, <code>add_api_route</code>, <code>include_router</code> with prefixes and application factories; <code>Depends</code> and <code>Security</code> functions as references; response statuses.</>, gaps: 'Custom converters and dependency overrides.' },
      { id: 'flask', name: 'Flask', versions: '3.1', reads: <>App and blueprint routes, <code>add_url_rule</code>, blueprint registration and prefixes, <code>MethodView</code> classes and application factories; request hooks as references.</>, gaps: 'Extension routes and configuration loaded from files.' },
    ],
  },
  {
    id: 'go', name: 'Go', languages: ['go'],
    summary: 'Modules and workspaces, packages and build contexts, package-level symbols and calls. No Go toolchain runs.',
    frameworks: [
      { id: 'gin', name: 'Gin', reads: 'Engines and groups reachable from main, with their original handlers, closures and middleware in order.' },
      { id: 'echo', name: 'Echo', logo: 'go', versions: 'v4 · v5', reads: 'Routes and groups, original handlers and middleware, per major version.' },
      { id: 'fiber', name: 'Fiber', logo: 'go', versions: 'v2 · v3', reads: 'Apps, groups and mounts, original handlers and middleware, per major version.' },
      { id: 'chi', name: 'Chi', logo: 'go', versions: 'v5', reads: 'Routers, sub-routers, mounts and route groups with their handlers.' },
      { id: 'gorilla', name: 'Gorilla Mux', logo: 'go', reads: 'Routers and subrouters, path prefixes, host and query matchers.' },
      { id: 'nethttp', name: 'net/http', logo: 'go', reads: <><code>ServeMux</code> patterns, including methods and wildcards, and the default mux.</>, gaps: 'Routes set up conditionally or by unreviewed options keep their conditions.' },
    ],
  },
  {
    id: 'ruby', name: 'Ruby', languages: ['ruby'],
    summary: <>Literal <code>require</code> and <code>load</code>, scoped constants and direct method calls. No Ruby interpreter runs.</>,
    frameworks: [
      { id: 'rails', name: 'Ruby on Rails', reads: <>Routes from <code>config/routes.rb</code> (resources, namespaces, scopes, nested routes), controller actions and callbacks such as <code>before_action</code>, with Zeitwerk autoloading.</>, gaps: 'Routes drawn dynamically.' },
    ],
  },
  {
    id: 'jvm', name: 'Java & Kotlin', languages: ['java', 'kotlin'],
    summary: 'Maven reactors, Gradle projects and source roots; explicit, wildcard and static imports; scoped references and direct calls, with lambdas. No JVM, build or plugin runs.',
    frameworks: [
      { id: 'spring', name: 'Spring', versions: 'Spring 6.2–7.0 · Boot 3.5–4.0', reads: <>Spring MVC controllers and mapping annotations, class and method paths, component scans, servlet prefixes and path patterns; WebFlux functional routes in Java builders and the Kotlin <code>router</code> and <code>coRouter</code> DSLs.</>, gaps: 'Virtual dispatch, injection, profiles and custom configuration.' },
    ],
  },
  {
    id: 'dotnet', name: 'C#', languages: ['csharp'],
    summary: 'SDK-style projects and MSBuild compile items, project references, using directives and partial types; scoped references and direct calls, lambdas, local functions and top-level statements. No .NET toolchain runs.',
    frameworks: [
      { id: 'aspnetcore', name: 'ASP.NET Core', versions: '8–10', reads: <>Minimal APIs (<code>MapGet</code> and the rest, route groups, method groups) and MVC controllers (attribute and conventional routes, areas), with constraints, order and hosts.</>, gaps: 'Authorization, filters, middleware and custom binding.' },
    ],
  },
  {
    id: 'rust', name: 'Rust', languages: ['rust'],
    summary: <>Cargo packages and workspaces, targets, path dependencies, modules and <code>#[path]</code>, use trees, globs and re-exports, features and <code>cfg</code>; scoped references, direct calls and closures. No Cargo or rustc runs.</>,
    frameworks: [
      { id: 'axum', name: 'Axum', logo: 'rust', versions: '0.7 · 0.8', reads: 'Routers and method routers, nest and merge, fallbacks and layers, from the server started in main.' },
      { id: 'actix', name: 'Actix Web', versions: '4', reads: <>Apps, scopes, resources and services, <code>configure</code> functions, route attributes and guards.</> },
      { id: 'rocket', name: 'Rocket', versions: '0.5', reads: <>Route attributes, <code>routes!</code> lists, mounts and launch, with ranks and parameter guards.</>, gaps: 'Fairings, catchers and custom guards.' },
      { id: 'warp', name: 'Warp', logo: 'rust', versions: '0.3 · 0.4', reads: <>Path and method filters, typed captures and the <code>path!</code> macro, prefix composition and <code>map</code>, <code>then</code> and <code>and_then</code> handlers, in filter order, from the server started in main.</>, gaps: 'Custom extraction, recovery and wrappers.' },
    ],
  },
];

const LEVELS = [
  { level: 'Flows to the data', what: 'Pages, requests, handlers, calls and the tables they read and write, end to end.', where: 'React and Next.js with Laravel' },
  { level: 'Routes and handlers', what: 'Every registered route linked to the exact function that handles it, and the calls inside the language.', where: 'The frameworks on this page' },
  { level: 'Structure', what: 'Declarations, imports, references and direct calls, with source ranges.', where: 'TypeScript, JavaScript, PHP, Python, Go, Ruby, Java, Kotlin, C#, Rust' },
  { level: 'Map', what: 'Applications, folders and files with their languages, lines, Git metrics and history.', where: 'Every repository' },
];

function Logo({ id, size = 28 }: { id: string; size?: number }) {
  return <img src={`/stacks/${id}.svg`} alt="" width={size} height={size} loading="lazy" decoding="async" />;
}

export default function Stacks() {
  return (
    <>
      <p className="eyebrow">Docs</p>
      <h1>Languages &amp; frameworks</h1>
      <p className="lede">
        Codiluce maps every repository with its files, lines and Git history. How far it follows the code depends on the
        stack: the frameworks on this page get routes, handlers and calls, each linked to the source that proves it.
      </p>

      <div className="callout">
        <p>
          <strong>What ships where.</strong> The npm release (v{VERSION}) analyzes TypeScript, JavaScript, React, Next.js,
          Laravel and Inertia, marked <StackStatus published /> below. Everything marked <StackStatus published={false} /> is
          on the main branch: run Codiluce from a source checkout to use it today. It ships in the next npm release.
        </p>
      </div>
      <CodeBlock prompt code={INSTALL.source.join('\n')} />

      <h2 id="depth" className="anchor">How deep it goes</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Level</th><th>What you get</th><th>Where</th></tr></thead>
          <tbody>{LEVELS.map(row => <tr key={row.level}><td><strong>{row.level}</strong></td><td>{row.what}</td><td>{row.where}</td></tr>)}</tbody>
        </table>
      </div>
      <p>
        Every relationship carries its evidence: the analyzer, the file and the line. What an analyzer cannot prove, such as
        a route registered under a condition or a call through an untyped value, becomes a finding with the reason, never a
        guess. The inspector shows which analysis ran on each file.
      </p>

      {ECOSYSTEMS.map(ecosystem => (
        <section key={ecosystem.id} className="eco" aria-labelledby={`eco-${ecosystem.id}`}>
          <h2 id={`eco-${ecosystem.id}`} className="anchor eco-title">
            <span className="eco-logos" aria-hidden="true">{ecosystem.languages.map(id => <Logo key={id} id={id} size={26} />)}</span>
            {ecosystem.name}
            <StackStatus published={ecosystem.languages.some(id => PUBLISHED.has(id))} />
          </h2>
          <p>{ecosystem.summary}</p>
          <div className="fw-grid">
            {ecosystem.frameworks.map(framework => (
              <article key={framework.id} className="fw-card" id={framework.id}>
                <header className="fw-head">
                  <Logo id={framework.logo ?? framework.id} />
                  <div className="fw-title">
                    <h3>{framework.name}</h3>
                    {framework.versions ? <span className="fw-versions">{framework.versions}</span> : null}
                  </div>
                  <StackStatus published={PUBLISHED.has(framework.id)} />
                </header>
                <p>{framework.reads}</p>
                {framework.gaps ? <p className="fw-gaps"><span>Gaps</span>{framework.gaps}</p> : null}
              </article>
            ))}
          </div>
        </section>
      ))}

      <h2 id="detected" className="anchor">Detected and mapped</h2>
      <p>
        These frameworks are recognized from their manifests, so each application is named and drawn with its files, lines
        and Git metrics, but their code is not analyzed yet:
      </p>
      <ul className="detected-list">{DETECTED.map(name => <li key={name}>{name}</li>)}</ul>
      <p>
        The same goes for every other language, from Scala, F# and Swift to C, C++ and Objective-C. Missing yours?{' '}
        <a href={ISSUES_URL} target="_blank" rel="noreferrer">Open an issue</a> with a public repository that shows it, or{' '}
        <Link href="/#contribute">tell us what your team needs</Link>.
      </p>

      <p className="fine-print">
        Logos are trademarks of their owners, shown only to say which code Codiluce reads; no endorsement is implied. Logo
        artwork from <a href="https://simpleicons.org" target="_blank" rel="noreferrer">Simple Icons</a> (CC0)
        and <a href="https://devicon.dev" target="_blank" rel="noreferrer">Devicon</a> (MIT).
      </p>

      <DocsPager current="/docs/stacks/" />
    </>
  );
}
