'use client';
import type { Entity, Evidence } from '@engine/core/graph';
import type { AggregateGroup, NodeSummary, RelationItem } from '@engine/projection/dto';
import { compactNumber, percent, relationPhrase, typeLabel } from '../lib/format';
import { isContainer, type AtlasStore } from '../lib/store';
import { themeById } from '../lib/themes';
import { useAtlas, useStore } from './context';
import { TypeBadge } from './TypeBadge';

export function Inspector({ onClose }: { onClose: () => void }) {
  const selection = useAtlas(state => state.selection);
  const evidence = useAtlas(state => state.evidence);
  return (
    <>
      <div className="panel-header">
        <h2>Inspector</h2>
        <button className="icon-button small" onClick={onClose} aria-label="Collapse inspector">⇥</button>
      </div>
      <div className="panel-body" aria-live="polite">
        {!selection ? <Overview /> : <Selection />}
      </div>
      {evidence && <EvidenceView />}
    </>
  );
}
function Overview() {
  const meta = useAtlas(state => state.meta);
  const store = useStore();
  if (!meta) return <p className="absent">Waiting for the index…</p>;
  const root = meta.root;
  const severities = Object.fromEntries(meta.diagnosticSeverities.map(item => [item.severity, item.count]));
  return (
    <div>
      <div className="inspector-title">
        <TypeBadge type="repository" />
        <h3>{meta.run.repositoryName}</h3>
      </div>
      <dl className="facts">
        <dt>Files</dt><dd>{compactNumber(root.stats.files)}</dd>
        <dt>Symbols</dt><dd>{compactNumber(root.stats.symbols)}</dd>
        <dt>Routes &amp; endpoints</dt><dd>{compactNumber(root.stats.endpoints)}</dd>
        <dt>Measured lines</dt><dd>{compactNumber(root.stats.measuredLoc)}{root.stats.unmeasuredFiles ? <span className="absent"> · {root.stats.unmeasuredFiles} files not measured</span> : null}</dd>
        <dt>Commit</dt><dd className="mono">{meta.run.commitSha ?? <span className="absent">no Git metadata</span>}{meta.run.dirty ? ' (working tree has uncommitted changes)' : ''}</dd>
        <dt>Unresolved</dt><dd>{['error', 'warning', 'info'].filter(key => severities[key]).map(key => `${severities[key]} ${key}`).join(' · ') || 'none'}</dd>
      </dl>
      <p className="note">Search with <kbd>/</kbd>, or zoom into the map: applications open into directories, then files, then symbols. Selecting an entity shows its indexed relationships and the evidence behind each one.</p>
      <div className="inspector-actions">
        <button className="button" onClick={() => void store.select(root.id, { fly: true })}>Repository connections</button>
      </div>
    </div>
  );
}
const FACT_LABELS: Record<string, string> = {
  qualifiedName: 'Qualified name', signature: 'Signature', exported: 'Exported', default: 'Default export', role: 'Role', serverAction: 'Server action',
  visibility: 'Visibility', static: 'Static', extends: 'Extends', method: 'HTTP method', routePath: 'Route path', framework: 'Framework', routeFile: 'Route file',
  api: 'API route file', registration: 'Registration', middleware: 'Middleware', constraintsUnresolved: 'Unevaluated constraints', handlerKind: 'Handler kind',
  routeName: 'Route name', controller: 'Controller', controllerMethod: 'Controller method', extension: 'Extension', bytes: 'Size', contentHash: 'Content hash',
  analysisSkipped: 'Not analyzed', serverModule: '"use server" module',
};
function formatValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (key === 'bytes' && typeof value === 'number') return `${compactNumber(value)} bytes`;
  if (key === 'contentHash' && typeof value === 'string') return `${value.slice(0, 16)}… (sha256 at index time)`;
  if (Array.isArray(value)) return value.length ? value.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(', ') : '—';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function Selection() {
  const store = useStore();
  const selection = useAtlas(state => state.selection)!;
  const node = selection.node, entity = selection.entity;
  if (!node) return selection.entityStatus === 'error' ? <p className="note error">Could not load this entity: {selection.error}</p> : <p className="absent">Locating…</p>;
  const container = isContainer(node);
  const sourceable = node.kind === 'entity' && !!node.path && !container;
  return (
    <div>
      <div className="inspector-title">
        <TypeBadge type={node.type} role={node.role} kind={node.kind} />
        <h3>{node.name}</h3>
        {node.qualifiedName && node.qualifiedName !== node.name && <span className="qualified mono">{node.qualifiedName}</span>}
        {node.path && <span className="qualified mono">{node.path}{node.sourceRange ? `:${node.sourceRange.startLine}–${node.sourceRange.endLine}` : ''}</span>}
      </div>
      <div className="inspector-actions">
        {sourceable && <button className="button primary small" onClick={() => void store.openSource({ entity: node.id }, `${typeLabel(node.type, node.role)} ${node.name}`)}>Open source</button>}
        <button className="button small" onClick={() => store.navigator?.flyTo(node, { mode: container ? 'enter' : 'focus' })}>Zoom to</button>
        <FlowAddButton id={node.id} kind={node.kind} />
      </div>
      {node.kind === 'group' && <p className="note">{node.explanation}</p>}
      {(node.type === 'api_endpoint' || node.type === 'route') && <p className="note">Shown in the <strong>Routes &amp; endpoints</strong> district of its application. That district is only a spatial grouping; the canonical parent is the application.</p>}
      {selection.entityStatus === 'error' && <p className="note error">{selection.error}</p>}
      <Facts node={node} entity={entity} />
      <HttpCalls selectionId={node.id} file={selection.file} />
      <Diagnostics />
      {container ? <Aggregate node={node} /> : <Relations node={node} />}
      {entity && <EntityEvidence entity={entity} store={store} />}
      {entity && Object.keys(entity.metadata).length > 0 && (
        <details className="section">
          <summary>All metadata</summary>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(entity.metadata, null, 2).slice(0, 20000)}</pre>
        </details>
      )}
    </div>
  );
}
function FlowAddButton({ id, kind }: { id: string; kind: string }) {
  const store = useStore();
  const drafting = useAtlas(state => !!state.flows.draft);
  if (!drafting || kind !== 'entity') return null;
  return <button className="button small" onClick={() => store.addDraftStep(id)}>Add to flow</button>;
}
function Facts({ node, entity }: { node: NodeSummary; entity?: Entity }) {
  const container = isContainer(node);
  const metadata = entity?.metadata ?? {};
  const keys = Object.keys(FACT_LABELS).filter(key => metadata[key] !== undefined && metadata[key] !== null && !(key === 'qualifiedName' && metadata[key] === node.name) && !(Array.isArray(metadata[key]) && !(metadata[key] as unknown[]).length) && !(metadata[key] === false && ['serverAction', 'serverModule', 'constraintsUnresolved', 'static'].includes(key)));
  return (
    <section className="section">
      <h4>Facts</h4>
      <dl className="facts">
        {node.language && <><dt>Language</dt><dd>{node.language}</dd></>}
        {node.sourceRange && <><dt>Source range</dt><dd>lines {node.sourceRange.startLine}–{node.sourceRange.endLine}</dd></>}
        {!container && node.kind === 'entity' && <><dt>Lines (metric)</dt><dd>{entity?.metrics?.loc !== undefined ? compactNumber(entity.metrics.loc) : node.loc !== undefined ? compactNumber(node.loc) : <span className="absent">not measured</span>}</dd></>}
        {container && <>
          <dt>Files</dt><dd>{compactNumber(node.stats.files)}</dd>
          <dt>Symbols</dt><dd>{compactNumber(node.stats.symbols)}</dd>
          {node.stats.endpoints > 0 && <><dt>Routes &amp; endpoints</dt><dd>{compactNumber(node.stats.endpoints)}</dd></>}
          <dt>Measured lines</dt><dd>{node.stats.files - node.stats.unmeasuredFiles > 0 ? compactNumber(node.stats.measuredLoc) : <span className="absent">not measured</span>}{node.stats.unmeasuredFiles > 0 && node.stats.files > node.stats.unmeasuredFiles ? <span className="absent"> · excludes {node.stats.unmeasuredFiles} unmeasured file{node.stats.unmeasuredFiles === 1 ? '' : 's'}</span> : null}</dd>
        </>}
        {node.type === 'file' && node.stats.symbols > 0 && <><dt>Symbols</dt><dd>{node.stats.symbols}</dd></>}
        {keys.map(key => <FactRow key={key} label={FACT_LABELS[key]!} value={formatValue(key, metadata[key])} />)}
        {Array.isArray(metadata.exports) && (metadata.exports as unknown[]).length > 0 && <><dt>Export statements</dt><dd>{(metadata.exports as unknown[]).length}</dd></>}
        {Array.isArray(metadata.externalImports) && (metadata.externalImports as string[]).length > 0 && <><dt>External imports</dt><dd className="mono">{[...new Set(metadata.externalImports as string[])].join(', ')}</dd></>}
        {node.type === 'file' && <><dt>Git history</dt><dd className="absent">not indexed</dd></>}
      </dl>
      {node.childCount > 0 && node.kind === 'entity' && node.childCount > 3000 && <p className="note">Only the first 3,000 children are loaded on the map.</p>}
    </section>
  );
}
function FactRow({ label, value }: { label: string; value: string }) { return <><dt>{label}</dt><dd className={value.length > 40 ? 'mono' : undefined}>{value}</dd></>; }
interface HttpRequest { callerId: string; method?: string; url?: string; expression: string; line?: number; resolution: 'literal' | 'unresolved' }
function HttpCalls({ selectionId, file }: { selectionId: string; file?: Entity }) {
  const store = useStore();
  const requests = ((file?.metadata.httpRequests as HttpRequest[] | undefined) ?? []).filter(request => request.callerId === selectionId);
  if (!requests.length || !file) return null;
  return (
    <section className="section">
      <h4>HTTP calls in this symbol</h4>
      <ul className="list">
        {requests.map((request, index) => (
          <li key={index} className={`row diagnostic ${request.resolution === 'literal' ? 'info' : ''}`}>
            <div className="row-main">
              <div className="row-title"><span className="label mono">{request.method ?? '?'} {request.expression}</span></div>
              <div className="row-sub">{request.resolution === 'literal' ? 'Literal URL — see relationships for a match, or findings if it stayed unmatched' : 'Unresolved: the URL is built dynamically, so no endpoint is linked'}{request.line ? ` · line ${request.line}` : ''}</div>
            </div>
            {request.line && <div className="row-actions"><button className="button small" onClick={() => void store.openSource({ entity: file.id, start: Math.max(1, request.line! - 12), end: request.line! + 12 }, `HTTP call · ${file.name}:${request.line}`)}>Source</button></div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
function Diagnostics() {
  const store = useStore();
  const diagnostics = useAtlas(state => state.diagnostics);
  const data = diagnostics.data;
  if (diagnostics.status === 'loading') return <section className="section"><h4>Unresolved findings</h4><p className="absent">Loading…</p></section>;
  if (diagnostics.status === 'error') return <section className="section"><h4>Unresolved findings</h4><p className="note error">{diagnostics.error}</p></section>;
  if (!data || data.total === 0) return null;
  return (
    <details className="section" open={data.total <= 5 ? true : undefined}>
      <summary>Unresolved findings <span className="chip"><span className="count">{data.total}</span></span></summary>
      <div className="filters">{data.codes.map(code => <span key={code.code + code.severity} className="chip">{code.code} <span className="count">{code.count}</span></span>)}</div>
      <ul className="list">
        {data.items.map(item => (
          <li key={item.id} className={`row diagnostic ${item.severity}`}>
            <div className="row-main">
              <div className="row-title"><span className="label">{item.code}</span><span className="type-badge">{item.severity}</span></div>
              <div className="row-sub" title={item.reason}>{item.reason}</div>
              {item.file && <div className="row-sub mono">{item.file}{item.line ? `:${item.line}` : ''}{item.nodeName ? ` · ${item.nodeName}` : ''}</div>}
            </div>
            {item.file && <div className="row-actions"><button className="button small" onClick={() => void store.openSource({ diagnostic: item.id }, `${item.code} · ${item.file}${item.line ? `:${item.line}` : ''}`)}>Source</button></div>}
          </li>
        ))}
      </ul>
      {data.hasMore && <p className="absent">Showing {data.items.length} of {data.total}.</p>}
    </details>
  );
}
function hiddenVia(store: AtlasStore, item: { other: NodeSummary; otherAncestors: string[] }): string | undefined {
  if (!store.visibility || store.visibility(item.other.id)) return undefined;
  for (let i = item.otherAncestors.length - 1; i >= 0; i--) if (store.visibility(item.otherAncestors[i]!)) return store.scene.nodes.get(item.otherAncestors[i]!)?.name ?? 'an ancestor';
  return 'off-screen';
}
function Relations({ node }: { node: NodeSummary }) {
  const store = useStore();
  const relations = useAtlas(state => state.relations);
  useAtlas(state => state.view.zoom);
  const evidenceId = useAtlas(state => state.evidence?.relationId);
  const theme = themeById(useAtlas(state => state.themeId));
  const types = [...new Set(relations.typeCounts.map(item => item.type))];
  const count = (type: string, direction?: string) => relations.typeCounts.filter(item => item.type === type && (!direction || item.direction === direction)).reduce((sum, item) => sum + item.count, 0);
  const totalAll = relations.typeCounts.reduce((sum, item) => sum + item.count, 0);
  const groups = (['outgoing', 'self', 'incoming'] as const).map(direction => ({ direction, items: relations.items.filter(item => item.direction === direction) })).filter(group => group.items.length);
  return (
    <section className="section">
      <h4>Relationships {relations.status === 'ready' && <span className="chip"><span className="count">{totalAll}</span></span>}</h4>
      {relations.status === 'ready' && totalAll === 0 && <p className="note">No indexed relationships besides containment. Calls, renders and database access are not extracted yet, so their absence here is not evidence that none exist.</p>}
      {totalAll > 0 && (
        <>
          <div className="segmented" role="group" aria-label="Direction">
            {(['both', 'outgoing', 'incoming'] as const).map(direction => <button key={direction} aria-pressed={relations.direction === direction} onClick={() => store.setRelationFilter({ direction })}>{direction === 'both' ? 'Both' : direction === 'outgoing' ? 'Outgoing →' : '← Incoming'}</button>)}
          </div>
          <div className="filters" role="group" aria-label="Relationship types">
            <button className="chip" aria-pressed={!relations.type} onClick={() => store.setRelationFilter({ type: null })}>All types</button>
            {types.map(type => <button key={type} className="chip" aria-pressed={relations.type === type} onClick={() => store.setRelationFilter({ type: relations.type === type ? null : type })}><span className="line" style={{ width: 10, height: 3, borderRadius: 2, background: theme.relation[type] ?? theme.fallbackRelation }} />{type} <span className="count">{count(type)}</span></button>)}
          </div>
        </>
      )}
      {relations.status === 'loading' && relations.items.length === 0 && <p className="absent">Loading relationships…</p>}
      {relations.status === 'error' && <p className="note error">{relations.error}</p>}
      {relations.items.length > 0 && <button className="button small" style={{ marginBottom: 8 }} onClick={() => store.navigator?.fitNodes([node, ...relations.items.filter(item => !relations.type || item.type === relations.type).map(item => item.other)])}>Fit selection and connections on the map</button>}
      {groups.map(group => (
        <div key={group.direction} style={{ marginBottom: 8 }}>
          <div className="direction" style={{ margin: '6px 0 4px' }}>{group.direction === 'outgoing' ? `Outgoing → from ${node.name}` : group.direction === 'incoming' ? `← Incoming to ${node.name}` : 'Self'}</div>
          <ul className="list">{group.items.map(item => <RelationRow key={item.id} item={item} emphasized={item.id === evidenceId} selectedName={node.name} />)}</ul>
        </div>
      ))}
      {relations.hasMore && <button className="button small" onClick={() => store.loadMoreRelations()} disabled={relations.status === 'loading'}>Load more ({relations.items.length} of {relations.total})</button>}
    </section>
  );
}
function RelationRow({ item, emphasized, selectedName }: { item: RelationItem; emphasized: boolean; selectedName: string }) {
  const store = useStore();
  const theme = themeById(useAtlas(state => state.themeId));
  const color = theme.relation[item.type] ?? theme.fallbackRelation;
  const via = hiddenVia(store, item);
  const from = item.direction === 'incoming' ? item.other.name : selectedName, to = item.direction === 'incoming' ? selectedName : item.other.name;
  return (
    <li className={`row${emphasized ? ' emphasized' : ''}`}>
      <div className="row-main">
        <div className="row-title">
          <span className="relation-phrase" style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }} title={`Graph relation: ${item.type} (${item.direction})`}>{relationPhrase(item.type, item.direction)}</span>
          <span className="label" title={item.other.name}>{item.other.name}</span>
        </div>
        <div className="row-sub">{typeLabel(item.other.type, item.other.role)}{item.other.path ? ` · ${item.other.path}` : ''}{typeof item.metadata?.specifier === 'string' ? ` · “${item.metadata.specifier}”` : ''}</div>
        {via && <div className="row-sub" style={{ color: 'var(--warning)' }}>{via === 'off-screen' ? 'Endpoint is off-screen' : `Not drawn at this zoom; the edge ends at ${via}`}</div>}
      </div>
      <div className="row-actions">
        <button className="button small" onClick={() => void store.select(item.other.id, { fly: true })} aria-label={`Go to ${item.other.name}`}>Go</button>
        <button className="button small" onClick={() => void store.openEvidence(item.id, { from, to, type: item.type })} aria-label={`Why is ${from} connected to ${to}?`}>Why?</button>
      </div>
    </li>
  );
}
function Aggregate({ node }: { node: NodeSummary }) {
  const store = useStore();
  const aggregate = useAtlas(state => state.aggregate);
  const filter = useAtlas(state => state.relations.type);
  const theme = themeById(useAtlas(state => state.themeId));
  const data = aggregate.data;
  if (aggregate.status === 'loading') return <section className="section"><h4>Connections</h4><p className="absent">Aggregating relationships…</p></section>;
  if (aggregate.status === 'error') return <section className="section"><h4>Connections</h4><p className="note error">{aggregate.error}</p></section>;
  if (!data) return null;
  const types = [...new Set(data.groups.map(group => group.type))];
  const groups = data.groups.filter(group => !filter || group.type === filter);
  const drill = aggregate.drill;
  return (
    <section className="section">
      <h4>Connections across this boundary <span className="chip"><span className="count">{data.totalCrossing}</span></span></h4>
      {data.internal.length > 0 && <p className="absent" style={{ margin: '0 0 6px' }}>Inside: {data.internal.map(item => `${compactNumber(item.count)} ${item.type}`).join(' · ')}</p>}
      {data.totalCrossing === 0 && <p className="note">No indexed relationship crosses this boundary.{node.type === 'application' ? ' Cross-application HTTP requests are only linked when the URL is literal and its origin is proven; unresolved calls are listed under findings.' : ''}</p>}
      {types.length > 1 && (
        <div className="filters" role="group" aria-label="Relationship types">
          <button className="chip" aria-pressed={!filter} onClick={() => store.setRelationFilter({ type: null })}>All</button>
          {types.map(type => <button key={type} className="chip" aria-pressed={filter === type} onClick={() => store.setRelationFilter({ type: filter === type ? null : type })}>{type}</button>)}
        </div>
      )}
      {groups.length > 0 && <button className="button small" style={{ marginBottom: 8 }} onClick={() => store.navigator?.fitNodes([node, ...groups.map(group => group.anchor)])}>Fit area and connected areas</button>}
      <ul className="list">
        {groups.map(group => {
          const color = theme.relation[group.type] ?? theme.fallbackRelation;
          const active = drill?.group === group;
          return (
            <li key={`${group.direction}${group.type}${group.anchor.id}`}>
              <div className={`row${active ? ' emphasized' : ''}`}>
                <div className="row-main">
                  <div className="row-title">
                    <span className="direction">{group.direction === 'outgoing' ? '→' : '←'}</span>
                    <span className="relation-phrase" style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}>{group.type}</span>
                    <span className="label">{group.anchor.name}</span>
                  </div>
                  <div className="row-sub">{group.count} relationship{group.count === 1 ? '' : 's'} · {group.anchor.kind === 'group' ? 'district' : typeLabel(group.anchor.type)}{group.anchor.path ? ` · ${group.anchor.path}` : ''}</div>
                </div>
                <div className="row-actions">
                  <button className="button small" onClick={() => void store.drillAggregate(active ? undefined : group)} aria-expanded={active}>{active ? 'Hide' : 'List'}</button>
                  <button className="button small" onClick={() => void store.select(group.anchor.id, { fly: true })} aria-label={`Go to ${group.anchor.name}`}>Go</button>
                </div>
              </div>
              {active && drill && <DrillList group={group} />}
            </li>
          );
        })}
      </ul>
      {data.truncated && <p className="absent">Showing the 200 largest groups.</p>}
    </section>
  );
}
function DrillList({ group }: { group: AggregateGroup }) {
  const store = useStore();
  const drill = useAtlas(state => state.aggregate.drill);
  if (!drill || drill.group !== group) return null;
  return (
    <ul className="list" style={{ margin: '4px 0 6px 14px' }}>
      {drill.items.map(item => {
        const from = item.direction === 'incoming' ? item.other.name : item.inside.name, to = item.direction === 'incoming' ? item.inside.name : item.other.name;
        return (
          <li key={item.id} className="row">
            <div className="row-main">
              <div className="row-title"><span className="label">{from} → {to}</span></div>
              <div className="row-sub">{item.type} · {item.direction === 'incoming' ? item.other.path : item.inside.path}</div>
            </div>
            <div className="row-actions">
              <button className="button small" onClick={() => void store.select(item.inside.id, { fly: true })}>Inside</button>
              <button className="button small" onClick={() => void store.openEvidence(item.id, { from, to, type: item.type })}>Why?</button>
            </div>
          </li>
        );
      })}
      {drill.status === 'loading' && <li className="absent">Loading…</li>}
      {drill.status === 'error' && <li className="note error">{drill.error}</li>}
      {drill.page?.hasMore && <li><button className="button small" onClick={() => void store.drillAggregate(group, true)}>Load more ({drill.items.length} of {drill.page.total})</button></li>}
    </ul>
  );
}
function EvidenceList({ facts, open }: { facts: Evidence[]; open: (index: number, fact: Evidence) => void }) {
  return (
    <ul className="list">
      {facts.map((fact, index) => (
        <li key={index} className="evidence-card">
          <header>
            <strong>{fact.source}</strong>
            <span className="confidence" title="Analyzer confidence">{percent(fact.confidence)} confidence</span>
          </header>
          <div className="row-sub">{fact.analyzer} v{fact.analyzerVersion}</div>
          {fact.explanation && <div>{fact.explanation}</div>}
          {fact.file ? (
            <div className="evidence-location">
              <span className="mono">{fact.file}{fact.line ? `:${fact.line}${fact.endLine && fact.endLine !== fact.line ? `–${fact.endLine}` : ''}` : ''}</span>
              <button className="button small" onClick={() => open(index, fact)}>Open source</button>
            </div>
          ) : <div className="absent">No source location recorded</div>}
        </li>
      ))}
    </ul>
  );
}
function EntityEvidence({ entity, store }: { entity: Entity; store: AtlasStore }) {
  return (
    <details className="section">
      <summary>Why does this entity exist? <span className="chip"><span className="count">{entity.evidence.length}</span></span></summary>
      <EvidenceList facts={entity.evidence} open={(index, fact) => void store.openSource({ entity: entity.id, evidence: index }, `Evidence · ${fact.file}${fact.line ? `:${fact.line}` : ''}`)} />
    </details>
  );
}
function EvidenceView() {
  const store = useStore();
  const evidence = useAtlas(state => state.evidence)!;
  const relation = evidence.relation;
  return (
    <div className="evidence-overlay" role="dialog" aria-modal="false" aria-labelledby="evidence-title" onKeyDown={event => { if (event.key === 'Escape') store.closeEvidence(); }}>
      <div className="panel-header">
        <h2 id="evidence-title">Why is this connected?</h2>
        <button className="icon-button small" onClick={() => store.closeEvidence()} aria-label="Close evidence" autoFocus>✕</button>
      </div>
      <div className="panel-body">
        {evidence.context && <p style={{ marginTop: 0 }}><strong>{evidence.context.from}</strong> <span className="relation-phrase" style={{ background: 'var(--chip)' }}>{evidence.context.type}</span> <strong>{evidence.context.to}</strong></p>}
        {evidence.status === 'loading' && <p className="absent">Loading evidence…</p>}
        {evidence.status === 'error' && <p className="note error">{evidence.error}</p>}
        {relation && (
          <>
            <p className="note">This relationship is in the graph because of the records below. Open each one to see the supporting source.{relation.type === 'handles' ? ' A handles relationship points from an endpoint to the code that handles it.' : ''}</p>
            {relation.metadata && Object.keys(relation.metadata).length > 0 && <dl className="facts" style={{ marginBottom: 10 }}>{Object.entries(relation.metadata).map(([key, value]) => <FactRow key={key} label={key} value={formatValue(key, value)} />)}</dl>}
            <EvidenceList facts={relation.evidence} open={(index, fact) => void store.openSource({ relation: relation.id, evidence: index }, `Evidence for ${relation.type} · ${fact.file}${fact.line ? `:${fact.line}` : ''}`)} />
          </>
        )}
      </div>
    </div>
  );
}
