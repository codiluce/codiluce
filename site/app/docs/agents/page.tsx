import type { Metadata } from 'next';
import Link from 'next/link';
import { CodeBlock } from '../../../components/CodeBlock';
import { DocsPager } from '../../../components/DocsNav';
import { Shot } from '../../../components/Shot';
import { INSTALL, NEXT_RELEASE } from '../../../lib/site';

export const metadata: Metadata = { title: 'Agents', description: 'Watch your coding agents work on the map: each session is a character that hops to the files it reads and edits, as it happens, and finished sessions replay from their transcripts.' };

export default function AgentsDocs() {
  return (
    <>
      <p className="eyebrow">Docs</p>
      <h1>Agents</h1>
      <p className="lede">
        Follow your coding agents on the map. Every connected session is a little character: it hops to each file it reads
        or edits, as it happens, and steps beside the map to think, run commands or wait for you. Open <strong>Agents</strong>
        {' '}beside the map to read the sessions, search past ones and replay them.
      </p>

      {NEXT_RELEASE.includes('characters') ? (
        <div className="callout">
          <p>
            <strong>Next release.</strong> The characters, session replays and the twelve harness adapters are on the main
            branch and reach the npm package with the next release. To try them today, run Codiluce from a clone:
          </p>
        </div>
      ) : null}
      {NEXT_RELEASE.includes('characters') ? <CodeBlock prompt code={INSTALL.source.join('\n')} /> : null}

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
        Agents learn about Codiluce through their hooks. Twelve harness families have adapters: Claude Code, Codex, Cursor,
        OpenCode, Pi, GitHub Copilot, Gemini CLI, Cline, Google Antigravity, Windsurf / Devin Desktop, OpenClaw and Hermes.
        Claude Code and Codex are established; the others are newer, so confirm delivery with your installed version.
        From the repository, preview what an adapter writes, then apply it:
      </p>
      <CodeBlock
        prompt
        code={[
          'npx codiluce harness setup --agent claude-code',
          'npx codiluce harness setup --agent claude-code --apply',
        ].join('\n')}
      />
      <p>
        Setup merges the MCP configuration and the activity hooks (or plugin) into the files that harness reads, keeping
        the entries you have. Add <code>--repo PATH</code> for another repository or worktree. In the map,{' '}
        <strong>Agents → Agent connections</strong> shows the same configuration for each harness and runtime, whether it
        was found, whether Codex trusts it (review new hooks with <code>/hooks</code>), and when the last hook arrived; run
        any action in your agent to confirm delivery.
      </p>

      <h2 id="see" className="anchor">What you see</h2>
      <Shot
        src="/shots/agents.webp"
        alt="Three agent sessions on BookStack's map: Claude Code split into three copies on the files it reads at once, Codex on the search code and Cursor on an uploads controller, each outlined in its session's color; the Agents list beside the map shows the same colored squares."
        caption="Three sessions at once on BookStack: Claude Code reads three files in parallel, so it splits into three. The squares match the list."
      />
      <ul>
        <li><strong>A character per session</strong>, on the map itself, in 3D or in the 2D plan. It hops to the file it reads, edits or searches (a search outlines the folder it searched), and stands on a closed folder&apos;s roof when the file is inside it. It steps beside the map for what is about no file: thinking, writing the reply, planning, the web, a command, waiting for your permission.</li>
        <li><strong>Copies for parallel work.</strong> Files read or edited at the same time split the character: a copy goes to each file and comes back when its call completes.</li>
        <li><strong>A colored square</strong> over each character marks its session; the same square marks the session in the Agents list. Characters on one block stand side by side: that signals overlap, not a proven conflict.</li>
        <li><strong>Sessions</strong>, with their title and status: running, waiting, idle (a turn ended, not the session), finished. A running session lists the files of its current turn, newest first, with its square beside those its characters stand on now.</li>
        <li><strong>Focus.</strong> Open a session to keep only its characters on the map; point at a session in the list to dim the others.</li>
        <li><strong>Click a path</strong> to reveal that file on the map, even one hidden from the map. If the file was added after the last analysis, this click updates the index first.</li>
      </ul>
      <p>
        The map itself is not dimmed while agents work. <strong>Show agents on the map</strong> turns the characters off and
        on. They belong to the working tree, so they are hidden while you look at a past commit in History.
      </p>

      <h2 id="sessions" className="anchor">Past sessions and replays</h2>
      <p>
        <strong>Import / refresh history</strong> saves the transcripts your harnesses keep for this repository on your
        machine. Search them by message or title, filter them by agent or by a file or folder they read, edited or added,
        and read them beside the map.
      </p>
      <p>
        <strong>Replay on the map</strong>, in a finished session, plays it again alone on the map, sped up: prompts are
        thinking, tool calls hop to the files they named, and the reply that ends a turn is written beside the map.
        Calls made together split the character as they did. Stretches of commands that named no file go by quickly, and a
        replay lasts at most 90 seconds (the latest steps of a long session).
      </p>

      <h2 id="observed" className="anchor">What is observed, and what is not</h2>
      <p>
        Only what an agent&apos;s hooks report, with a session behind it. There is no file-system watcher, so a change no hook
        reported is not attributed to anyone.
      </p>
      <ul>
        <li>File reads and edits, patches (including both paths of a move) and the folders that searches name carry their paths.</li>
        <li>A few literal shell reads (<code>cat</code>, <code>head</code>, <code>tail</code>, <code>sed -n</code>) and simple <code>rg</code> or <code>grep</code> searches are read as such. Pipelines, scripts and unfamiliar commands stay plain commands, with no file claimed: an agent that reads fifty files from one Python script stays beside the map, running a command.</li>
        <li>Known test commands are shown as test runs.</li>
        <li>A search marks the folder it searched, not every file it matched.</li>
        <li>A started action is an attempt; only its completion confirms it.</li>
      </ul>

      <h2 id="privacy" className="anchor">Privacy</h2>
      <p>
        The hook forwards each event to the map on your own machine and sends nothing back to the agent. Codiluce keeps paths,
        search queries, tool names, session titles and statuses, in memory only: at most 500 events and 100 sessions, gone when
        the map stops. Prompts, transcripts, file contents, patch bodies and command output are discarded on arrival. No API key
        or model is involved. <code>serve --read-only</code> turns activity off. Imported session history is a separate,
        explicit step: the transcripts are saved on your machine, in the repository&apos;s <code>.codiluce/</code> state, and
        never sent anywhere.
      </p>

      <DocsPager current="/docs/agents/" />
    </>
  );
}
