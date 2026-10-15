import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock } from '../../../components/CodeBlock';
import { DocsPager } from '../../../components/DocsNav';
import { INSTALL, NEXT_RELEASE } from '../../../lib/site';

export const metadata: Metadata = { title: 'Agents', description: 'Watch Claude Code and Codex sessions work on the map: every file they read, edit or search lights up in the session’s color, as it happens.' };

export default function AgentsDocs() {
  return (
    <>
      <p className="eyebrow">Docs</p>
      <h1>Agents</h1>
      <p className="lede">
        Follow your coding agents on the map. Open <strong>Agents</strong> beside it to see every Claude Code and Codex session
        at work: each file they read, edit or search lights up in the session&apos;s color, as it happens.
      </p>

      {NEXT_RELEASE.includes('agents') ? (
        <div className="callout">
          <p>
            <strong>Next release.</strong> Agents is on the main branch and reaches the npm package with the next release. To
            try it today, run Codiluce from a clone of the repository:
          </p>
        </div>
      ) : null}
      {NEXT_RELEASE.includes('agents') ? <CodeBlock prompt code={INSTALL.source.join('\n')} /> : null}

      <p>
        Agents is about what your agents <em>do</em>. To have one <em>explain</em> the code on the map, connect it over MCP: see
        {' '}<Link href="/docs/explanations/">Explanations</Link>. The two work side by side.
      </p>

      <h2 id="connect" className="anchor">Connect an agent</h2>
      <p>
        Agents learn about Codiluce through their hooks. Start the map for the repository, then open <strong>Agents → Agent
        connections</strong> in the panel&apos;s footer. Choose Codex or Claude Code, copy the configuration and merge its
        {' '}<code>hooks</code> entries into the agent&apos;s settings, keeping the ones you have:
      </p>
      <ul>
        <li><strong>Claude Code:</strong> <code>.claude/settings.local.json</code> in the repository. Restart Claude Code if the running session does not pick up the settings.</li>
        <li><strong>Codex:</strong> <code>.codex/hooks.json</code> in the repository. Review and trust the hooks with <code>/hooks</code>; hooks must be enabled in Codex.</li>
      </ul>
      <p>The command line prints the same configuration:</p>
      <CodeBlock
        prompt
        code={[
          'npx codiluce activity hooks --agent claude-code',
          'npx codiluce activity hooks --agent codex',
        ].join('\n')}
      />
      <p>
        Add <code>--repo PATH</code> for another repository or worktree, and <code>--state-dir PATH</code> if the map uses a
        custom state directory. Codiluce never changes your agents&apos; configuration itself. The connections window says
        whether a configuration was found, whether Codex trusts it, and when the last hook arrived; run any action in your agent
        to confirm delivery.
      </p>

      <h2 id="see" className="anchor">What you see</h2>
      <ul>
        <li><strong>Sessions</strong>, with their title and status: running, waiting, idle (a turn ended, not the session), finished. A status no hook has confirmed for five minutes shows as unknown.</li>
        <li><strong>Recent activity</strong>: each read, edit, search, command and test run, newest first. Select a session to see only its activity, on the list and on the map.</li>
        <li><strong>Marks on the map</strong>: the file an agent touched is outlined in its session&apos;s color with what it did, and the mark fades over 30 seconds. A search outlines the folder it searched, dashed. Zoomed out, marks gather on the closed folder that holds them.</li>
        <li><strong>Two sessions on one file</strong> show both marks. That signals overlap, not a proven conflict.</li>
        <li><strong>Click a path</strong> in the feed to reveal that file on the map, even one hidden from the map. If the file was added after the last analysis, this click updates the index first.</li>
      </ul>
      <p>
        <strong>Show activity on the map</strong> turns the marks off and on. Marks belong to the working tree, so they are
        hidden while you look at a past commit in History.
      </p>

      <h2 id="observed" className="anchor">What is observed, and what is not</h2>
      <p>
        Only what an agent&apos;s hooks report, with a session behind it. There is no file-system watcher, so a change no hook
        reported is not attributed to anyone.
      </p>
      <ul>
        <li>File reads and edits, patches (including both paths of a move) and the folders that searches name carry their paths.</li>
        <li>A few literal shell reads (<code>cat</code>, <code>head</code>, <code>tail</code>, <code>sed -n</code>) and simple <code>rg</code> or <code>grep</code> searches are read as such. Pipelines, scripts and unfamiliar commands stay plain commands, with no file claimed.</li>
        <li>Known test commands are shown as test runs.</li>
        <li>A search marks the folder it searched, not every file it matched.</li>
        <li>A started action is an attempt; only its completion confirms it.</li>
      </ul>

      <h2 id="privacy" className="anchor">Privacy</h2>
      <p>
        The hook forwards each event to the map on your own machine and sends nothing back to the agent. Codiluce keeps paths,
        search queries, tool names, session titles and statuses, in memory only: at most 500 events and 100 sessions, gone when
        the map stops. Prompts, transcripts, file contents, patch bodies and command output are discarded on arrival. No API key
        or model is involved. <code>serve --read-only</code> turns activity off.
      </p>

      <DocsPager current="/docs/agents/" />
    </>
  );
}
