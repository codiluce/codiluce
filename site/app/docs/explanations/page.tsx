import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock } from '../../../components/CodeBlock';
import { DocsPager } from '../../../components/DocsNav';
import { Shot } from '../../../components/Shot';

export const metadata: Metadata = { title: 'Explanations', description: 'Ask your agent, or the map, to explain the code, and read the answer with every file, symbol and flow it names lit on the map.' };

const TOOLS = [
  { tool: 'overview', what: 'The applications, their frameworks, the size, the flows by kind, the features, and the link syntax.' },
  { tool: 'search', what: 'Files, folders, symbols, routes, endpoints, tables, commands and tasks by name or path.' },
  { tool: 'entity', what: 'One entity: its description and feature, its symbols or contents, the flows through it, its relationships, what it does outside the code, who changed it, and the explanations that link it.' },
  { tool: 'relations', what: 'Its imports, calls, renders, requests across the frontend and backend, reads and writes.' },
  { tool: 'flows, flow', what: 'Every flow by entry point, and one flow step by step: lanes for a request, command or task, steps with their conditions for a page.' },
  { tool: 'impact', what: 'The blast radius, with the chain of relations that reaches each entity and what the walk cannot see.' },
  { tool: 'history, commit', what: 'Recent commits, the commits that changed an entity, and what one commit or merged pull request changed.' },
  { tool: 'source', what: 'The indexed source of a file or symbol, numbered.' },
  { tool: 'publish_explanation', what: 'Check every link, then save the explanation for the map. update_explanation adds a follow-up or rewrites it.' },
];
const LINKS = [
  { link: 'app/Http/Kernel.php', what: 'a file' },
  { link: 'app/Http/', what: 'a folder (its files light up)' },
  { link: 'PageRepo.php#PageRepo.update', what: 'a symbol in its file' },
  { link: 'Kernel.php#L40-L62', what: 'lines of a file' },
  { link: 'flow:POST /api/orders', what: 'a flow, by where it starts' },
  { link: 'table:orders · commit:3fe7e5b · pr:42 · feature:billing', what: 'a table, a commit, a merged pull request, a feature' },
];

export default function ExplanationsDocs() {
  return (
    <>
      <p className="eyebrow">Docs</p>
      <h1>Explanations</h1>
      <p className="lede">
        Ask your agent, or the map itself, to explain the code. The answer is saved in the map&apos;s <strong>Explain</strong>
        {' '}column, where every file, symbol and flow it names is a link: point at it and that code lights up on the map,
        click it to open it.
      </p>

      <Shot
        src="/shots/explanations.webp"
        alt="An explanation of how BookStack saves a page, in the Explain column: its links name the controller, repository and revision code, which is lit on the map while the rest of the repository recedes."
        caption="An agent explained how BookStack saves a page. The code it links is lit on the map; the rest recedes."
      />

      <h2 id="agent" className="anchor">Connect your agent</h2>
      <p>
        Codiluce has an MCP server for agents. Add it once, from the repository:
      </p>
      <CodeBlock
        prompt
        code={[
          '# Claude Code',
          'claude mcp add codiluce -- npx -y codiluce mcp',
          '# Codex',
          'codex mcp add codiluce -- npx -y codiluce mcp',
        ].join('\n')}
      />
      <p>
        Or let <code>codiluce setup</code> do it: on the first <code>start</code> it finds Claude Code, Codex and Cursor and
        offers to connect them. Other clients take the same command (<code>npx</code> with <code>-y codiluce mcp</code>) in
        their MCP configuration; the <em>Connect your agent</em> panel in the column shows the exact command for your setup. Then ask in
        your own words, for example <em>&quot;Use Codiluce to explain how checkout works, and publish it&quot;</em>. Clients
        that support MCP prompts also get <code>explain-codebase</code>, <code>explain-flow</code>,
        {' '}<code>explain-commit</code>, <code>explain-pr</code>, <code>explain-path</code> and <code>explain-impact</code>.
      </p>
      <p>
        The agent starts from what the code provably does instead of reading files one by one. Its tools read the index:
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Tool</th><th>What it gives the agent</th></tr></thead>
          <tbody>{TOOLS.map(row => <tr key={row.tool}><td><code>{row.tool}</code></td><td>{row.what}</td></tr>)}</tbody>
        </table>
      </div>
      <p>
        <code>publish_explanation</code> checks every link against the index first. A path that names nothing comes back
        with the reason, and nothing is saved until the agent fixes it. The server reads the index and writes only
        explanations.
      </p>

      <h2 id="links" className="anchor">Links</h2>
      <p>
        Explanations are Markdown. Links name code by repository-relative paths, which is what models already know, and
        every tool result carries the link to copy:
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Link</th><th>Names</th></tr></thead>
          <tbody>{LINKS.map(row => <tr key={row.link}><td><code>{row.link}</code></td><td>{row.what}</td></tr>)}</tbody>
        </table>
      </div>

      <h2 id="reading" className="anchor">Reading on the map</h2>
      <ul>
        <li><strong>Point at a link</strong> and only what it names stays lit, outlined. The map does not move; an arrow at the edge points to code off screen.</li>
        <li><strong>Click it</strong> to open it: a file or symbol in the Code panel, a flow in the middle, a commit on the timeline.</li>
        <li><strong>Light on map</strong> lights everything the open explanation links while you read it.</li>
        <li><strong>Explained in</strong>, in the inspector, lists the explanations that link the selection, something inside it, or a folder holding it.</li>
        <li>Explanations about a commit or a pull request are marked on the timeline. Those about a flow show on the flow, and those about a file show in its inspector.</li>
      </ul>

      <h2 id="stale" className="anchor">When the code changes</h2>
      <p>
        Each explanation is pinned to the commit it was written against, with a fingerprint of everything it links. When a
        later index differs, it says how many linked items changed or disappeared, and how many commits it is behind.
        {' '}<strong>Refresh</strong> asks the model to check what changed and rewrite it; <strong>Copy refresh
        prompt</strong> does the same through your agent.
      </p>

      <h2 id="ask" className="anchor">Ask in the map</h2>
      <p>
        With an Anthropic or OpenAI key, the column asks a model directly, with the same tools and the same link check.
        {' '}<code>codiluce setup</code> asks for the key, checks it with the provider and keeps it in
        {' '}<code>~/.config/codiluce/credentials</code>, readable only by you and never inside the repository. A key in the
        environment works too, and no restart is needed.
      </p>
      <CodeBlock prompt code={'npx codiluce setup'} />
      <ul>
        <li>Type <code>@</code> to attach files and folders. <strong>+ Add to question</strong> in the inspector attaches the selection.</li>
        <li><strong>✦ Explain</strong> in the inspector, on a flow or on a commit starts the question for you. <strong>Copy prompt</strong> copies it for your agent instead.</li>
        <li>Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5, or GPT-6.1 Sol and GPT-6 Luna. Each question is capped at $0.50, and each answer records what it cost.</li>
        <li>The question, the attached code and what the tools return, including excerpts of source, are sent to the provider you choose. Nothing else leaves your machine.</li>
      </ul>
      <p>
        Explanations are Markdown files in <code>.codiluce/explanations/</code>: readable, diffable, and yours to keep or
        share. <code>serve --read-only</code> refuses asking, renaming and deleting. More in the <Link href="/docs/cli/#mcp">CLI
        docs</Link>.
      </p>

      <DocsPager current="/docs/explanations/" />
    </>
  );
}
