'use client';
// The Explanations column: text from language models about this code, saved
// with the repository's index. An agent connected over MCP saves what it
// explains here; with an API key, questions are asked in the column itself.
// Pointing at a link lights what it names on the map (the camera stays put;
// off-screen code gets an arrow at the map's edge); clicking it opens it. An
// explanation is pinned to the commit it was written against, and says when
// the code it links changed since. While a connected agent works on one, the
// column shows it from the agent's first step, until it is saved.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { agentLabel, type AgentActivity, type ExplanationDetail, type ExplanationSummary, type ResolvedLink } from '@engine/explanations/model';
import { hrefForNode } from '@engine/explanations/links';
import type { NodeSummary } from '@engine/projection/dto';
import { relativeTime, shortSha, typeLabel } from '../lib/format';
import { workingAgents, workKey, type ContextChip } from '../lib/store';
import { useAtlas, useStore } from './context';
import { CopyButton, useAgentPrompt } from './ExplainActions';
import { Markdown, type LinkHandlers } from './Markdown';

export function ExplanationsPanel({ onClose }: { onClose: () => void }) {
  const store = useStore();
  const detail = useAtlas(state => state.explain.detail);
  const asking = useAtlas(state => state.explain.asking);
  const body = useRef<HTMLDivElement>(null);
  // A new answer streams in at the bottom: keep it in view.
  useEffect(() => { if (asking?.status === 'streaming' && body.current) body.current.scrollTop = body.current.scrollHeight; }, [asking?.text, asking?.tools.length, asking?.status]);
  const showAsking = asking && (asking.explanationId ? asking.explanationId === detail?.id : !detail);
  return (
    <>
      <div className="panel-header">
        {detail ? <button className="icon-button small" onClick={() => store.closeExplanation()} aria-label="Back to every explanation" title="Every explanation">←</button> : null}
        <h2>Explanations</h2>
        <button className="icon-button small" onClick={onClose} aria-label="Hide the explanations" title="Hide">⇤</button>
      </div>
      <div className="panel-body explain-body" ref={body}>
        {!showAsking && <AgentsAtWork compact={!!detail} />}
        {detail ? <Reader /> : !showAsking && <History />}
        {showAsking && <Asking />}
      </div>
      <Composer />
    </>
  );
}

function History() {
  const store = useStore();
  const list = useAtlas(state => state.explain.list);
  const [query, setQuery] = useState('');
  const items = list.data?.items ?? [];
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length ? items.filter(item => words.every(word => `${item.title} ${item.excerpt} ${item.subject.label ?? ''}`.toLowerCase().includes(word))) : items;
  return (
    <div className="explain-history">
      {list.status === 'error' && <p className="note error">{list.error}</p>}
      {list.status === 'loading' && !list.data && <div className="rf-loading"><span className="rf-spark" />Reading the explanations…</div>}
      {list.data && !items.length && <EmptyState />}
      {items.length > 0 && (
        <>
          {items.length > 6 && <><label className="sr-only" htmlFor="explain-query">Filter explanations</label><input id="explain-query" className="text-input rf-query" placeholder="Filter explanations…" value={query} onChange={event => setQuery(event.target.value)} /></>}
          <ul className="explain-list">
            {shown.map(item => <HistoryItem key={item.id} item={item} onOpen={() => void store.openExplanation(item.id)} />)}
          </ul>
          {words.length > 0 && !shown.length && <p className="absent">No explanation matches.</p>}
          <details className="section connect-agent"><summary>Connect your agent</summary><ConnectAgent /></details>
        </>
      )}
    </div>
  );
}
function HistoryItem({ item, onOpen }: { item: ExplanationSummary; onOpen: () => void }) {
  const stale = item.stale.changed + item.stale.missing;
  return (
    <li>
      <button className="explain-item" onClick={onOpen}>
        <span className="explain-item-title">{item.title}</span>
        <span className="explain-item-meta">
          <SubjectBadge subject={item.subject} />
          <span>{item.agent ?? (item.source === 'chat' ? item.model ?? 'chat' : item.source)}</span>
          <span>{relativeTime(item.updatedAt)}</span>
          {item.links > 0 && <span>{item.links} link{item.links === 1 ? '' : 's'}</span>}
          {stale > 0 && <span className="chip warning" title={`${item.stale.changed} linked item${item.stale.changed === 1 ? '' : 's'} changed and ${item.stale.missing} disappeared since it was written`}>{stale} changed</span>}
        </span>
        {item.excerpt && <span className="explain-item-excerpt">{item.excerpt}</span>}
      </button>
    </li>
  );
}
function SubjectBadge({ subject }: { subject: ExplanationSummary['subject'] }) {
  const text = { overview: 'Codebase', flow: 'Flow', commit: 'Commit', pr: 'PR', entity: 'Code', question: 'Question' }[subject.kind];
  return <span className={`subject-badge s-${subject.kind}`} title={subject.label ?? subject.ref}>{text}</span>;
}
function EmptyState() {
  const canAsk = useAtlas(state => !!state.explain.setup?.models.some(model => model.available));
  return (
    <div className="explain-empty">
      <p><strong>Ask about the code; read the answer on the map.</strong> Every file, folder, symbol and flow an answer names is a link: point at it to light it on the map, click it to open it.</p>
      <p className="note">{canAsk ? 'Ask below, or use ✦ Explain in the inspector, on a flow or on a commit.' : 'Ask your agent (Claude Code, Codex, Cursor…): connect it to Codiluce once, and what it explains is saved here.'}</p>
      <ConnectAgent open />
    </div>
  );
}
/** How to connect an agent over MCP, with a first prompt to try. */
function ConnectAgent({ open = false }: { open?: boolean }) {
  const setup = useAtlas(state => state.explain.setup);
  const agents = useAtlas(state => state.explain.agents);
  const prompt = useAgentPrompt();
  if (!setup) return null;
  const json = JSON.stringify({ mcpServers: { codiluce: { command: setup.mcp.command, args: setup.mcp.args } } }, null, 2);
  const connected = [...new Set(agents.map(agent => agentLabel(agent.agent)))];
  return (
    <div className="connect">
      {open && <h4>Connect your agent</h4>}
      {connected.length > 0 && <p className="agent-connected" role="status"><span className="dot" aria-hidden="true" /><span>{connected.join(', ')} {connected.length === 1 ? 'is' : 'are'} connected: what {connected.length === 1 ? 'it explains' : 'they explain'} shows here as {connected.length === 1 ? 'it works' : 'they work'}.</span></p>}
      <p className="note">Claude Code, in a terminal:</p>
      <div className="command-row"><code className="mono">{setup.mcp.claude}</code><CopyButton text={setup.mcp.claude} /></div>
      <p className="note">Codex:</p>
      <div className="command-row"><code className="mono">{setup.mcp.codex}</code><CopyButton text={setup.mcp.codex} /></div>
      <details><summary className="note">Cursor and other MCP clients (mcp.json)</summary><div className="command-row"><pre className="mono">{json}</pre><CopyButton text={json} /></div></details>
      <p className="note">Then ask it, for example:</p>
      <div className="command-row"><span>Explain this codebase as a whole…</span><CopyButton text={() => prompt({ kind: 'overview' })} label="Copy prompt" /></div>
      <p className="note">Its tools read Codiluce's index (flows, impact, history, source); <code>publish_explanation</code> checks every link, then saves the answer in <code>.codiluce/explanations/</code>, where this column shows it.</p>
    </div>
  );
}

function useLinkHandlers(detail: ExplanationDetail | undefined): LinkHandlers {
  const store = useStore();
  return useMemo(() => {
    const byHref = new Map(detail?.links.map(link => [link.href, link]) ?? []);
    return {
      resolve: href => byHref.get(href) ?? byHref.get(`<${href}>`) ?? byHref.get(href.trim()),
      hover: link => store.hoverLink(link),
      follow: link => void store.followLink(link),
    };
  }, [detail, store]);
}
function Reader() {
  const store = useStore();
  const state = useAtlas(s => s.explain.detail)!;
  const lens = useAtlas(s => s.explain.lens);
  const data = state.data;
  const links = useLinkHandlers(data);
  const [renaming, setRenaming] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);
  // Leaving the reader: nothing stays lit by a link the pointer left.
  useEffect(() => () => store.hoverLink(undefined), [store]);
  if (state.status === 'error') return <p className="note error">{state.error}</p>;
  if (!data) return <div className="rf-loading"><span className="rf-spark" />Opening the explanation…</div>;
  const linked = data.links.filter(link => link.status !== 'external');
  const firstAnswer = data.turns.findIndex(turn => turn.role === 'answer');
  return (
    <article className="explain-reader" aria-label={data.title}>
      {renaming !== undefined ? (
        <form className="rename" onSubmit={event => { event.preventDefault(); void store.renameExplanation(data.id, renaming); setRenaming(undefined); }}>
          <input className="text-input" value={renaming} autoFocus onChange={event => setRenaming(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setRenaming(undefined); }} aria-label="Title" />
          <button className="button tiny primary" type="submit">Save</button>
        </form>
      ) : <h3 className="explain-title">{data.title}</h3>}
      <div className="explain-meta">
        <SubjectBadge subject={data.subject} />
        {data.subject.label && data.subject.kind !== 'question' && data.subject.kind !== 'overview' && <span className="mono subject-ref" title={data.subject.ref}>{data.subject.label}</span>}
        <span title={new Date(data.updatedAt).toLocaleString()}>{data.agent ? `by ${data.agent}` : data.source === 'agent' ? 'by an agent' : data.source === 'chat' ? 'asked here' : 'written by hand'}{data.model ? ` · ${data.model}` : ''} · {relativeTime(data.updatedAt)}</span>
        {data.cost !== undefined && <span title="What the answers cost (US dollars)">${data.cost.toFixed(data.cost < 0.1 ? 3 : 2)}</span>}
      </div>
      <Staleness data={data} />
      <div className="explain-tools">
        <label className="toggle small" title="Light everything this explanation links on the map; the rest recedes"><input type="checkbox" checked={lens} onChange={event => store.setExplanationLens(event.target.checked)} /> Light on map{linked.length ? ` (${data.footprint.ids.length})` : ''}</label>
        <CopyButton text={() => toMarkdown(data)} label="Copy Markdown" title="The explanation as Markdown, with its links (repository-relative paths)" />
        <button className="button tiny" onClick={() => setRenaming(data.title)}>Rename</button>
        {confirming ? <span className="confirm"><button className="button tiny danger" onClick={() => void store.deleteExplanation(data.id)}>Delete it</button><button className="button tiny" onClick={() => setConfirming(false)}>Keep</button></span>
          : <button className="button tiny" onClick={() => setConfirming(true)} title={`Delete ${data.file} from the state directory`}>Delete</button>}
      </div>
      {data.turns.map((turn, index) => turn.role === 'question'
        ? <div key={index} className="explain-question"><span className="who">Question</span><p>{turn.text}</p></div>
        : (
          <section key={index} className="explain-answer">
            <Markdown text={index === firstAnswer ? withoutTitle(turn.text, data.title) : turn.text} links={links} />
            {(turn.model || turn.commit) && <p className="model-note" title="Generated text: the links were checked against the index, the sentences were not. Facts are in the inspector.">AI{turn.model ? ` · ${turn.model}` : ''}{turn.commit ? ` · written at ${shortSha(turn.commit)}` : ''}{turn.cost !== undefined ? ` · $${turn.cost.toFixed(3)}` : ''}</p>}
          </section>
        ))}
      {linked.length > 0 && (
        <details className="section linked-code">
          <summary>Linked code <span className="chip"><span className="count">{linked.length}</span></span></summary>
          <ul className="linked-list">
            {linked.map(link => <LinkedRow key={link.href} link={link} links={links} />)}
          </ul>
        </details>
      )}
    </article>
  );
}
function LinkedRow({ link, links }: { link: ResolvedLink; links: LinkHandlers }) {
  const label = link.kind === 'commit' || link.kind === 'pr' ? `${link.kind === 'pr' ? 'PR' : 'commit'} ${link.sha?.slice(0, 8) ?? link.href}` : link.kind === 'flow' ? link.label ?? link.name : link.kind === 'feature' ? link.label : link.path ? `${link.path}${link.type && !['file', 'directory', 'application'].includes(link.type) ? ` · ${link.name}` : ''}` : link.href;
  return (
    <li className={`linked-row ${link.status}`}>
      {link.status === 'missing' ? <span className="xlink missing" title={link.reason}>{link.href}</span> : (
        <button className="link-button" onMouseEnter={() => links.hover(link)} onMouseLeave={() => links.hover(undefined)} onFocus={() => links.hover(link)} onBlur={() => links.hover(undefined)} onClick={() => links.follow(link)}>
          <span className="type">{link.kind === 'path' || link.kind === 'table' ? typeLabel(link.type ?? 'file') : link.kind}</span> {label}
        </button>
      )}
      {link.status === 'changed' && <span className="chip warning">changed</span>}
      {link.status === 'missing' && <span className="chip warning">gone</span>}
    </li>
  );
}
/** Pinned to a commit: whether the code it links changed since, and how to bring it up to date. */
function Staleness({ data }: { data: ExplanationDetail }) {
  const store = useStore();
  const canAsk = useAtlas(state => !!state.explain.setup?.models.some(model => model.available) && !state.explain.setup.readOnly);
  const asking = useAtlas(state => state.explain.asking?.status === 'streaming');
  const prompt = useAgentPrompt();
  const { stale } = data;
  const changed = stale.changed + stale.missing;
  const since = stale.commitsSince ? ` · ${stale.commitsSince} commit${stale.commitsSince === 1 ? '' : 's'} since` : '';
  if (!changed) return data.commit ? <p className="pinned-note" title={data.commit}>Written at {shortSha(data.commit)}{since}{stale.moved ? '; nothing it links changed since.' : '.'}</p> : null;
  return (
    <div className="note warning stale-note" role="status">
      <p><strong>{changed} of {stale.linked} linked item{stale.linked === 1 ? '' : 's'} changed</strong>{stale.missing ? ` (${stale.missing} no longer exist${stale.missing === 1 ? 's' : ''})` : ''} since this was written at {data.commit ? shortSha(data.commit) : 'an earlier index'}{since}. It may be out of date.</p>
      <div className="stale-actions">
        {canAsk && <button className="button tiny primary" disabled={asking} onClick={() => void store.ask({ refresh: true })} title="Ask the model to check what changed and rewrite it">Refresh</button>}
        <CopyButton text={() => prompt({ kind: 'refresh', id: data.id, label: data.title })} label="Copy refresh prompt" title="A prompt for your agent: read this explanation, check what changed, rewrite it" />
      </div>
    </div>
  );
}
function Asking() {
  const store = useStore();
  const asking = useAtlas(state => state.explain.asking)!;
  const pending = useMemo<LinkHandlers>(() => ({ resolve: () => undefined, hover: () => undefined, follow: () => undefined, pending: true }), []);
  return (
    <section className="explain-asking" aria-live="polite">
      {asking.question && <div className="explain-question"><span className="who">Question</span><p>{asking.question}</p>{asking.context.length > 0 && <div className="chips">{asking.context.map(chip => <span key={chip.href} className="chip context-chip">{chip.label}</span>)}</div>}</div>}
      {asking.refresh && <p className="note">Checking what changed and rewriting the explanation…</p>}
      {asking.tools.length > 0 && (
        <ul className="asking-tools">
          {asking.tools.slice(-6).map((tool, index) => <li key={index} className="mono">{tool}</li>)}
          {asking.tools.length > 6 && <li className="absent">{asking.tools.length - 6} earlier</li>}
        </ul>
      )}
      {asking.note && <p className="note">{asking.note}</p>}
      {asking.text ? <div className="explain-answer streaming"><Markdown text={asking.text} links={pending} /></div> : asking.status === 'streaming' && <div className="rf-loading"><span className="rf-spark" />{asking.tools.length ? 'Reading the code…' : `Asking ${asking.model ?? 'the model'}…`}</div>}
      {asking.status === 'streaming'
        ? <button className="button tiny" onClick={() => store.stopAsking()}>Stop</button>
        : <div className="note error"><p>{asking.error}</p><button className="button tiny" onClick={() => store.dismissAskError()}>Back to the question</button></div>}
    </section>
  );
}

/** Agents connected over MCP working on an explanation: shown after an explicit explanation start or prompt until they save it. */
function AgentsAtWork({ compact }: { compact: boolean }) {
  const store = useStore();
  const agents = useAtlas(state => state.explain.agents);
  const dismissed = useAtlas(state => state.explain.dismissed);
  const working = useMemo(() => workingAgents({ agents, dismissed }), [agents, dismissed]);
  const now = useNow(working.length > 0);
  if (!working.length) return null;
  if (compact) {
    const first = working[0]!;
    return (
      <div className="agent-banner" role="status">
        <span className="agent-pulse" aria-hidden="true" />
        <span className="agent-banner-text">{working.length > 1 ? `${working.length} agents are working` : `${agentLabel(first.agent)} is explaining`}{working.length === 1 && first.work?.title ? `: ${first.work.title}` : '…'}</span>
        <button className="button tiny" onClick={() => store.closeExplanation()} title="Back to every explanation, where its steps show">Show</button>
      </div>
    );
  }
  return <>{working.map(agent => <AgentCard key={workKey(agent)} agent={agent} now={now} onHide={() => store.dismissAgentWork(agent)} />)}</>;
}
function AgentCard({ agent, now, onHide }: { agent: AgentActivity; now: number; onHide: () => void }) {
  const work = agent.work!;
  const label = agentLabel(agent.agent);
  const last = work.steps.at(-1);
  const quiet = now - Date.parse(last?.at ?? work.startedAt);
  const saving = !!last && /^(publish|update)_explanation\b/.test(last.text);
  // A long pause after reading usually means it is writing (the whole answer arrives in one call).
  const status = saving ? 'Saving the explanation…' : !last ? 'Starting…' : quiet > 15_000 ? `Waiting for an explanation update… · last step ${duration(quiet)} ago` : 'Reading the code…';
  return (
    <section className="agent-work" aria-label={`${label} is working`}>
      <div className="agent-work-head">
        <span className="agent-pulse" aria-hidden="true" />
        <strong>{label} is explaining</strong>
        <span className="agent-work-time" title={`Since ${new Date(work.startedAt).toLocaleTimeString()}`}>{duration(now - Date.parse(work.startedAt))}</span>
        <button className="icon-button small" onClick={onHide} aria-label="Hide" title="Hide this (what it saves still shows here)">×</button>
      </div>
      {work.title && <p className="agent-work-title">{work.title}</p>}
      {work.question && <div className="explain-question"><span className="who">Question</span><p>{work.question}</p></div>}
      {work.steps.length > 0 && (
        <ul className="asking-tools" aria-label="Steps so far">
          {work.count > work.steps.length && <li className="absent">{work.count - work.steps.length} earlier</li>}
          {work.steps.slice(-6).map((step, index) => <li key={`${step.at}-${index}`} className="mono">{step.text}</li>)}
        </ul>
      )}
      <div className="rf-loading" aria-live="polite"><span className="rf-spark" />{status}</div>
    </section>
  );
}
/** The clock, ticking each second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}
function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

/** The question box: text, the code it is about (chips; @ adds one), the model, and asking here or copying for an agent. */
function Composer() {
  const store = useStore();
  const draft = useAtlas(state => state.explain.draft);
  const setup = useAtlas(state => state.explain.setup);
  const detail = useAtlas(state => state.explain.detail?.data);
  const streaming = useAtlas(state => state.explain.asking?.status === 'streaming');
  const area = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<{ query: string; start: number; items: NodeSummary[]; index: number } | undefined>();
  const reveal = useAtlas(state => state.explain.reveal);
  useEffect(() => { if (reveal) area.current?.focus(); }, [reveal]);
  const models = setup?.models ?? [];
  const available = models.filter(model => model.available);
  const canAsk = available.length > 0 && !setup?.readOnly;
  // @ followed by a few letters searches the index; choosing a result attaches it.
  useEffect(() => {
    if (!mention || mention.query.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      store.api.search(mention.query, undefined, controller.signal).then(page => setMention(current => current && current.query === mention.query ? { ...current, items: page.items.slice(0, 8), index: 0 } : current)).catch(() => undefined);
    }, 140);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [mention?.query, store]);
  const onChange = (text: string, caret: number) => {
    store.setDraft({ text });
    const before = text.slice(0, caret);
    const at = /(?:^|\s)@([^\s@]{0,60})$/.exec(before);
    setMention(at ? { query: at[1]!, start: caret - at[1]!.length - 1, items: mention && mention.query === at[1] ? mention.items : [], index: 0 } : undefined);
  };
  const choose = (node: NodeSummary) => {
    const href = hrefForNode(node);
    if (!href || !mention) return;
    const text = draft.text.slice(0, mention.start) + draft.text.slice(mention.start + mention.query.length + 1);
    store.setDraft({ text });
    store.addContext({ href, label: node.type === 'directory' ? `${node.name}/` : node.name });
    setMention(undefined);
    area.current?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention?.items.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setMention({ ...mention, index: (mention.index + (event.key === 'ArrowDown' ? 1 : mention.items.length - 1)) % mention.items.length }); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); choose(mention.items[mention.index]!); return; }
      if (event.key === 'Escape') { event.preventDefault(); setMention(undefined); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (canAsk && !streaming) void store.ask(); }
  };
  const agentText = () => {
    const context = draft.context.map(chip => `- [${chip.label}](${chip.href})`).join('\n');
    return `${draft.text.trim() || 'Explain this code.'}${context ? `\n\nIt is about:\n${context}` : ''}\n\nUse the Codiluce MCP tools to answer (start with \`overview\` or \`entity\`), and save the answer with \`publish_explanation\`${detail ? ` (or add it to the explanation "${detail.title}" with \`update_explanation\`, id "${detail.id}")` : ''}. Link every file, folder, symbol and flow you mention, copying the \`link\` values the tools return.${setup ? `\n(If the Codiluce tools are not connected yet: ${setup.mcp.claude})` : ''}`;
  };
  return (
    <div className="composer">
      {draft.context.length > 0 && (
        <div className="chips" aria-label="Attached code">
          {draft.context.map((chip: ContextChip) => <span key={chip.href} className="chip context-chip" title={chip.href}>{chip.label}<button className="chip-remove" onClick={() => store.removeContext(chip.href)} aria-label={`Remove ${chip.label}`}>×</button></span>)}
        </div>
      )}
      <div className="composer-box">
        <textarea ref={area} className="text-input" rows={3} value={draft.text} disabled={setup?.readOnly}
          placeholder={setup?.readOnly ? 'This map is read-only' : detail ? 'Ask a follow-up… (@ adds a file or folder)' : 'Ask about the code… (@ adds a file or folder)'}
          onChange={event => onChange(event.target.value, event.target.selectionStart)} onKeyDown={onKey} aria-label="Question" />
        {mention && mention.items.length > 0 && (
          <ul className="mention-menu" role="listbox" aria-label="Attach">
            {mention.items.map((item, index) => (
              <li key={item.id} role="option" aria-selected={index === mention.index}>
                <button onMouseDown={event => { event.preventDefault(); choose(item); }}><span className="type">{typeLabel(item.type, item.role)}</span> {item.name}<span className="mono path">{item.path && item.path !== item.name ? item.path : ''}</span></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="composer-actions">
        {canAsk ? (
          <>
            <label className="sr-only" htmlFor="chat-model">Model</label>
            <select id="chat-model" className="select small" value={draft.model ?? ''} onChange={event => store.setDraft({ model: event.target.value })}>
              {models.map(model => <option key={model.id} value={model.id} disabled={!model.available}>{model.label}{model.available ? '' : ' (no key)'}{model.note && model.available ? ` · ${model.note}` : ''}</option>)}
            </select>
            <button className="button small primary" disabled={streaming || !draft.text.trim()} onClick={() => void store.ask()} title={`Asks ${draft.model ?? 'the model'}, at most $${setup!.maxCost.toFixed(2)} a question. Your question, the attached code and the excerpts it reads are sent to ${available.find(model => model.id === draft.model)?.provider === 'openai' ? 'OpenAI' : 'Anthropic'}.`}>{detail ? 'Ask follow-up' : 'Ask'}</button>
          </>
        ) : setup && !setup.readOnly ? <span className="absent" title={`Read from the environment, or from:\n${setup.keyFiles.join('\n')}`}>To ask here, run <code>codiluce setup</code> in a terminal, or add ANTHROPIC_API_KEY or OPENAI_API_KEY to <code>{setup.keyFiles[0]}</code></span> : null}
        <CopyButton text={agentText} label="Copy for agent" className="button small" title="Copy this question as a prompt for your agent connected to Codiluce over MCP" />
      </div>
      {canAsk && <p className="composer-note">Sent to {available.find(model => model.id === draft.model)?.provider === 'openai' ? 'OpenAI' : 'Anthropic'} with the code the model reads · up to ${setup!.maxCost.toFixed(2)} a question</p>}
    </div>
  );
}

/** The explanation as one Markdown document (questions as quotes). */
function toMarkdown(data: ExplanationDetail): string {
  const parts = [`# ${data.title}`];
  for (const turn of data.turns) parts.push(turn.role === 'question' ? turn.text.split('\n').map(line => `> ${line}`).join('\n') : turn.text.replace(/^#\s+.*\n+/, ''));
  parts.push(`_${data.agent ?? data.model ?? 'Codiluce'}${data.commit ? `, at commit ${data.commit.slice(0, 10)}` : ''}_`);
  return parts.join('\n\n');
}
/** An answer without its first heading when that heading is the explanation's title (shown above it already). */
function withoutTitle(text: string, title: string): string {
  const match = /^\s*#{1,3}\s+(.+?)\s*#*\s*(?:\n|$)/.exec(text);
  const plain = (value: string) => value.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').trim().toLowerCase();
  return match && plain(match[1]!) === plain(title) ? text.slice(match[0].length) : text;
}
