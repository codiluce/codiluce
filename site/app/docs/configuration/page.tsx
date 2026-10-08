import type { Metadata } from 'next';
import { CodeBlock } from '../../../components/CodeBlock';
import { DocsPager } from '../../../components/DocsNav';

export const metadata: Metadata = { title: 'Configuration', description: 'Applications, API origins, ignore patterns and the languages and frameworks Codiluce detects.' };

const ECOSYSTEMS = [
  { eco: 'node', manifests: 'package.json' },
  { eco: 'php', manifests: 'composer.json' },
  { eco: 'python', manifests: 'pyproject.toml, requirements*.txt, Pipfile, setup.py, manage.py' },
  { eco: 'ruby', manifests: 'Gemfile, *.gemspec' },
  { eco: 'go', manifests: 'go.mod' },
  { eco: 'rust', manifests: 'Cargo.toml' },
  { eco: 'jvm', manifests: 'pom.xml, build.gradle(.kts), build.sbt' },
  { eco: 'dotnet', manifests: '*.csproj, *.fsproj, *.vbproj' },
  { eco: 'swift / xcode', manifests: 'Package.swift, *.xcodeproj' },
  { eco: 'native', manifests: 'CMakeLists.txt, meson.build' },
  { eco: 'shopify', manifests: 'layout/theme.liquid' },
];

export default function ConfigurationDocs() {
  return (
    <>
      <p className="eyebrow">Docs</p>
      <h1>Configuration</h1>
      <p className="lede">
        Most repositories need none. The first start detects your applications and writes them
        to <code>.codiluce/config.yml</code>, which you can then adjust.
      </p>

      <h2 id="detection" className="anchor">Detection</h2>
      <p>
        A directory is an application when a manifest there declares one. Codiluce looks two levels deep, so a monorepo with
        {' '}<code>frontend/</code> and <code>backend/</code> is found as two applications. An application may contain another.
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Ecosystem</th><th>Manifests</th></tr></thead>
          <tbody>
            {ECOSYSTEMS.map(row => (
              <tr key={row.eco}><td><code>{row.eco}</code></td><td>{row.manifests}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Each manifest also names the frameworks an application is built on. TypeScript and JavaScript are analyzed down to
        calls and requests in any application, and supported frameworks down to routes, commands and tables. Every file in
        a known language is named, measured and highlighted: TypeScript, JavaScript, PHP, Python, Go, Rust, Java, Kotlin,
        Scala, C#, F#, VB.NET, Ruby, C, C++, Objective-C, Swift, Vue, Svelte, Astro, Liquid and Razor.
      </p>

      <h2 id="config" className="anchor">config.yml</h2>
      <CodeBlock
        title=".codiluce/config.yml"
        code={[
          'repository:',
          '  name: example-repository',
          '  # Optional stable namespace shared across renamed or relocated checkouts:',
          '  # id: my-example-repository',
          'applications:',
          '  - name: frontend',
          '    path: frontend',
          '    frameworks: [react]',
          '  - name: backend',
          '    path: backend',
          '    frameworks: [express]',
          '    apiOrigins:',
          '      - https://api.example.test',
          '    # Environment variables the frontend reads its API base URL from:',
          '    apiOriginEnv:',
          '      - API_BASE_URL',
          'ignore:',
          '  - "**/custom-generated/**"',
          'maxFileBytes: 1048576',
        ].join('\n')}
      />
      <ul>
        <li><strong>applications</strong>: explicit applications replace detection. Paths are relative to the repository and must stay inside it. Configured frameworks come first; the first one says what the application is.</li>
        <li><strong>apiOrigins</strong>: the absolute origins an application answers on. A frontend request to one of them is linked to that application’s routes.</li>
        <li><strong>apiOriginEnv</strong>: the environment variables your code reads its API base URL from. This is an assumption you declare, so every request linked through one carries it as evidence.</li>
        <li><strong>ignore</strong>: extra patterns (<code>*</code>, <code>**</code>, <code>?</code>) on top of safe defaults. Git-ignored files are skipped too, and so are symlinks, secret-like files, generated output and binaries.</li>
        <li><strong>repository.id</strong>: keeps entity identities stable when two repositories share a name. Changing it changes every ID.</li>
      </ul>

      <h2 id="requests" className="anchor">How requests are linked</h2>
      <p>
        A request URL is linked to an endpoint only when every value its base can take is proven. The analyzer follows
        template literals, concatenation, constants (also imported ones), class properties, local functions,
        {' '}<code>new URL(…)</code>, <code>||</code>, <code>??</code> and conditionals, through axios instances and wrapper
        functions, down to a configured origin or a declared variable.
      </p>
      <p>
        A dynamic value may fill a whole path segment (<code>{'users/${id}'}</code> matches only a route parameter) or sit in
        the query string. Anything else, such as a forgotten <code>http://localhost:8000</code> or an undeclared variable,
        stays an <code>unresolved-http-call</code> finding whose reason names it.
      </p>

      <div className="callout">
        <p>
          <strong>Keep state private.</strong> The state directory holds paths, symbols and routes of your code. Keep it in
          {' '}<code>.codiluce/</code> and add that to <code>.gitignore</code>, or put it outside the repository
          with <code>--state-dir</code>. Share only sanitized configuration.
        </p>
      </div>

      <DocsPager current="/docs/configuration/" />
    </>
  );
}
