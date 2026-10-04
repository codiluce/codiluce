'use client';
import { Fragment } from 'react';
import type { Entity, Evidence } from '@engine/core/graph';
import type { AggregateGroup, ChangeFacet, DiagnosticItem, NodeChange, NodeSummary, RelationItem } from '@engine/projection/dto';
import { compactNumber, percent, relationPhrase, relativeTime, shortSha, typeLabel } from '../lib/format';
import { entryOf, isContainer, type AtlasStore } from '../lib/store';
import { themeById } from '../lib/themes';
import { useAtlas, useStore } from './context';
import { TypeBadge } from './TypeBadge';
import { CallSitesSection, CommitImpactChip, EffectsSection, ImpactSection } from './Analysis';

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
  if (meta.comparison) return <ComparisonOverview />;
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
        <dt>Snapshot</dt><dd>{meta.snapshot.kind === 'commit' ? 'Historical commit (read from Git objects)' : 'Live working-tree index'}</dd>
        <dt>Unresolved</dt><dd>{['error', 'warning', 'info'].filter(key => severities[key]).map(key => `${severities[key]} ${key}`).join(' · ') || 'none'}</dd>
      </dl>
      {meta.snapshot.kind === 'commit' && <CommitCard sha={meta.snapshot.commitSha} />}
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
        <AnalysisButtons node={node} />
      </div>
      {node.kind === 'group' && <p className="note">{node.explanation}</p>}
      {(node.type === 'api_endpoint' || node.type === 'route') && <p className="note">Shown in the <strong>Routes &amp; endpoints</strong> district of its application. That district is only a spatial grouping; the canonical parent is the application.</p>}
      {node.type === 'database_table' && <p className="note">Declared by the application's migrations, replayed in order: the schema they intend, not the live database. Shown in the <strong>Database</strong> district; the canonical parent is the application.</p>}
      {selection.entityStatus === 'error' && <p className="note error">{selection.error}</p>}
      {node.change?.status === 'removed' && <p className="note">This entity existed in the baseline and was removed. It is shown as a ghost where it used to be; its facts below are from the baseline.</p>}
      {selection.change && <ChangeSection node={node} />}
      <ImpactSection node={node} />
      <Facts node={node} entity={entity} />
      {node.type === 'database_table' && entity && <TableSection entity={entity} />}
      <HttpCalls selectionId={node.id} file={selection.file} />
      {entity && <EffectsSection entity={entity} />}
      {entity && <CallSitesSection entity={entity} />}
      <Diagnostics />
      {container ? <Aggregate node={node} /> : <Relations node={node} />}
      {selection.timeline && <EntityTimeline />}
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
/** Blast radius toggle, and "what happens from here" for entities that run code or serve requests. */
function AnalysisButtons({ node }: { node: NodeSummary }) {
  const store = useStore();
  const impactOpen = useAtlas(state => state.impact.open && state.impact.forId === node.id);
  const stepsAnchor = useAtlas(state => state.steps?.anchor);
  const runs = node.kind === 'entity' && !['repository', 'application', 'directory', 'file', 'database_table'].includes(node.type);
  return (
    <>
      <button className="button small" aria-pressed={impactOpen} onClick={() => impactOpen ? store.hideImpact() : void store.showImpact(node.id)} title="What depends on this, hop by hop">{impactOpen ? 'Hide impact' : 'Impact'}</button>
      {runs && <button className="button small" aria-pressed={stepsAnchor === node.id} onClick={() => stepsAnchor === node.id ? store.closeSteps() : void store.openSteps(node.id)} title="What this sets in motion: handlers, requests, endpoints and effects">What happens from here</button>}
    </>
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
        {!container && node.kind === 'entity' && node.type !== 'database_table' && <><dt>Lines (metric)</dt><dd>{entity?.metrics?.loc !== undefined ? compactNumber(entity.metrics.loc) : node.loc !== undefined ? compactNumber(node.loc) : <span className="absent">not measured</span>}</dd></>}
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
        {node.type === 'file' && <GitMetrics entity={entity} />}
      </dl>
      {node.childCount > 0 && node.kind === 'entity' && node.childCount > 3000 && <p className="note">Only the first 3,000 children are loaded on the map.</p>}
    </section>
  );
}
interface TableColumn { name: string; type: string; nullable?: boolean; unique?: boolean; primary?: boolean; default?: string }
/** Columns and foreign keys of a table, as its migrations declare them. */
function TableSection({ entity }: { entity: Entity }) {
  const store = useStore();
  const columns = (entity.metadata.columns as TableColumn[] | undefined) ?? [];
  const keys = (entity.metadata.foreignKeys as { column: string; table: string; references: string; onDelete?: string }[] | undefined) ?? [];
  const migrations = (entity.metadata.migrations as string[] | undefined) ?? [];
  return (
    <section className="section">
      <h4>Columns <span className="chip"><span className="count">{columns.length}</span></span></h4>
      {entity.metadata.origin === 'altered' && <p className="note warning">Migrations alter this table, but none of the indexed ones creates it: its full column list is not known.</p>}
      {entity.metadata.conditional === true && <p className="note">Some columns are added under a condition in a migration (e.g. <span className="mono">if (!Schema::hasColumn(…))</span>).</p>}
      <dl className="facts columns">
        {columns.map(column => <Fragment key={column.name}><dt className="mono">{column.name}</dt><dd><span className="mono">{column.type}</span>{[column.primary && 'primary', column.unique && 'unique', column.nullable && 'nullable', column.default !== undefined && `default ${column.default}`, keys.some(key => key.column === column.name) && 'foreign key'].filter(Boolean).map(flag => <span key={String(flag)} className="chip">{flag}</span>)}</dd></Fragment>)}
      </dl>
      {keys.length > 0 && <>
        <h4 style={{ marginTop: 10 }}>Foreign keys</h4>
        <ul className="list">{keys.map(key => <li key={key.column} className="row"><div className="row-main"><div className="row-title mono">{key.column} → {key.table}.{key.references}</div>{key.onDelete && <div className="row-sub">on delete {key.onDelete}</div>}</div></li>)}</ul>
      </>}
      {migrations.length > 0 && <>
        <h4 style={{ marginTop: 10 }}>Migrations <span className="chip"><span className="count">{migrations.length}</span></span></h4>
        <ul className="list">{migrations.map(file => { const index = entity.evidence.findIndex(fact => fact.file === file); return <li key={file} className="row"><div className="row-main"><div className="row-sub mono">{file.split('/').at(-1)}</div></div>{index >= 0 && <div className="row-actions"><button className="button small" onClick={() => void store.openSource({ entity: entity.id, evidence: index }, `Migration · ${file.split('/').at(-1)}`)}>Source</button></div>}</li>; })}</ul>
      </>}
    </section>
  );
}
/** Per-file Git metrics (committed history of the working-tree index). */
function GitMetrics({ entity }: { entity?: Entity }) {
  const metrics = entity?.metrics;
  if (!entity) return null;
  if (metrics?.commits === undefined) return <><dt>Git history</dt><dd className="absent">not measured (no commit of this file in the indexed history)</dd></>;
  return <>
    <dt>Commits</dt><dd>{compactNumber(metrics.commits)}</dd>
    <dt>Authors</dt><dd>{metrics.authors ?? '—'}</dd>
    <dt>Churn</dt><dd title="Lines added plus lines deleted, over every commit that changed the file">{metrics.churn !== undefined ? `${compactNumber(metrics.churn)} lines` : '—'}</dd>
    {metrics.lastChangedAt && <><dt>Last changed</dt><dd>{relativeTime(metrics.lastChangedAt)}{metrics.lastCommit ? <span className="absent mono"> · {shortSha(metrics.lastCommit)}</span> : null}</dd></>}
  </>;
}
function FactRow({ label, value }: { label: string; value: string }) { return <><dt>{label}</dt><dd className={value.length > 40 ? 'mono' : undefined}>{value}</dd></>; }
interface HttpRequest { callerId: string; method?: string; url?: string; expression: string; line?: number; resolution: 'literal' | 'proven-base' | 'template' | 'unresolved' | 'wrapper'; wrapper?: string; instance?: string; callSites?: { resolved: number; unresolved: number } }
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
              <div className="row-sub">{request.resolution === 'literal' ? 'Literal URL — see relationships for a match, or findings if it stayed unmatched' : request.resolution === 'proven-base' ? `Built from a proven base: ${request.url ?? ''} — see relationships (Why? lists every hop), or findings if no endpoint matched` : request.resolution === 'template' ? `Relative URL with dynamic segments: ${request.url ?? ''} — linked only when the page making it is served by the endpoint's own application; otherwise see findings` : request.resolution === 'wrapper' ? (request.wrapper ? `Through the HTTP wrapper ${request.wrapper}(): ${request.url ?? ''} — see relationships for the endpoint it reaches` : `This symbol is an HTTP wrapper: its URL or method comes from its parameters, so each call site is resolved as a request of its caller (${request.callSites?.resolved ?? 0} resolved, ${request.callSites?.unresolved ?? 0} not)`) : 'Unresolved: the request could not be proven (its URL or method is dynamic; see findings for the reason), so no endpoint is linked'}{request.line ? ` · line ${request.line}` : ''}</div>
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
              <div className="row-title">{item.change && <ChangeBadge status="added" text="new" />}<span className="label">{item.code}</span><span className="type-badge">{item.severity}</span></div>
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
      {relations.status === 'ready' && totalAll === 0 && <p className="note">No indexed relationships besides containment. Only calls the analyzers could resolve are relationships: calls through callbacks, props or untyped values are counted under call sites instead, so this is not evidence that nothing is connected.</p>}
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
    <li className={`row${emphasized ? ' emphasized' : ''}${item.change === 'removed' ? ' removed-row' : ''}`}>
      <div className="row-main">
        <div className="row-title">
          {item.change && <ChangeBadge status={item.change} />}
          <span className="relation-phrase" style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }} title={`Graph relation: ${item.type} (${item.direction})`}>{relationPhrase(item.type, item.direction)}</span>
          <span className="label" title={item.other.name}>{item.other.name}</span>
        </div>
        <div className="row-sub">{typeLabel(item.other.type, item.other.role)}{item.other.path ? ` · ${item.other.path}` : ''}{typeof item.metadata?.specifier === 'string' ? ` · “${item.metadata.specifier}”` : ''}{siteSummary(item.metadata)}</div>
        {via && <div className="row-sub" style={{ color: 'var(--warning)' }}>{via === 'off-screen' ? 'Endpoint is off-screen' : `Not drawn at this zoom; the edge ends at ${via}`}</div>}
      </div>
      <div className="row-actions">
        <button className="button small" onClick={() => void store.select(item.other.id, { fly: true })} aria-label={`Go to ${item.other.name}`}>Go</button>
        <button className="button small" onClick={() => void store.openEvidence(item.id, { from, to, type: item.type })} aria-label={`Why is ${from} connected to ${to}?`}>Why?</button>
      </div>
    </li>
  );
}
/** `· 3 call sites · onClick` from a resolved relationship's metadata. */
function siteSummary(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return '';
  const parts: string[] = [];
  const sites = typeof metadata.sites === 'number' ? metadata.sites : undefined;
  const forms = Array.isArray(metadata.forms) ? metadata.forms as string[] : [];
  if (sites && sites > 1) parts.push(`${sites} sites`);
  if (forms.includes('new')) parts.push('constructs');
  if (forms.includes('handler') || forms.includes('callback')) parts.push(forms.includes('handler') ? 'as a handler' : 'as a callback');
  if (Array.isArray(metadata.events) && metadata.events.length) parts.push((metadata.events as string[]).join(', '));
  if (metadata.resolution === 'proven-base') parts.push('base URL proven');
  else if (metadata.resolution === 'same-origin') parts.push('same origin');
  return parts.length ? ` · ${parts.join(' · ')}` : '';
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
      {data.totalCrossing === 0 && <p className="note">No indexed relationship crosses this boundary.{node.type === 'application' ? ' Cross-application HTTP requests are only linked when the URL\'s origin is proven: a literal configured origin, or a base built from one or from an environment variable declared in apiOriginEnv. Unresolved calls are listed under findings.' : ''}</p>}
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

// History -------------------------------------------------------------------------
const STATUS_TEXT: Record<string, string> = { added: 'Added', removed: 'Removed', modified: 'Modified', moved: 'Moved', unchanged: 'Unchanged' };
const FACET_TEXT: Record<ChangeFacet, string> = {
  source: 'source text changed', definition: 'declared facts changed', signature: 'signature changed', type: 'kind changed', size: 'size changed',
  renamed: 'renamed or relocated', reparented: 'moved to another parent', relations: 'relationships changed', diagnostics: 'findings changed',
};
const LINEAGE_TEXT: Record<string, string> = {
  'git-rename': 'Git rename detection', 'directory-rename': 'a directory rename implied by renamed files', 'qualified-name': 'the same qualified name',
  body: 'an identical body under another name', name: 'the same name in the same (mapped) place',
};
export function ChangeBadge({ status, text }: { status: string; text?: string }) {
  return <span className={`change-badge ${status}`}>{text ?? STATUS_TEXT[status]?.toLowerCase() ?? status}</span>;
}
function describe(change: NodeChange): string {
  return change.facets.map(facet => FACET_TEXT[facet]).join(' · ');
}
function ChangeSection({ node }: { node: NodeSummary }) {
  const store = useStore();
  const change = useAtlas(state => state.selection?.change);
  const meta = useAtlas(state => state.meta);
  const data = change?.data;
  const status = node.change?.status ?? 'unchanged';
  const baseline = meta?.comparison?.baseline;
  const at = (ref: { kind: string; commitSha?: string } | undefined) => ref?.kind === 'commit' ? shortSha(ref.commitSha) : 'working tree';
  return (
    <section className={`section change-section ${status}`} aria-label="Changes versus the baseline">
      <h4>Change since <span className="mono" style={{ textTransform: 'none', letterSpacing: 0 }}>{at(baseline)}</span> <ChangeBadge status={status} /></h4>
      {node.change && node.change.facets.length > 0 && <p className="change-facets">{describe(node.change)}</p>}
      {!node.change && <p className="absent" style={{ margin: '0 0 6px' }}>Identical in both snapshots{node.changes ? ', but entities inside it changed' : ''}.</p>}
      {node.change?.previousPath && <p className="change-from">{status === 'moved' ? 'Moved from' : 'Was at'} <span className="mono">{node.change.previousPath}</span></p>}
      {node.change?.previousName && <p className="change-from">Renamed from <strong>{node.change.previousName}</strong></p>}
      {node.change?.lineage && <p className="absent" style={{ margin: '0 0 6px' }}>Identity followed through {LINEAGE_TEXT[node.change.lineage] ?? node.change.lineage}; the canonical ID changed.</p>}
      {node.changes && <p className="change-from">Inside: {(['added', 'modified', 'moved', 'removed'] as const).filter(key => node.changes![key]).map(key => <span key={key} className={`change-count ${key}`}>{compactNumber(node.changes![key])} {key}</span>)}</p>}
      {change?.status === 'loading' && <p className="absent">Loading the comparison…</p>}
      {change?.status === 'error' && <p className="note error">{change.error}</p>}
      {data && (
        <>
          <div className="inspector-actions">
            {data.sourceDiff && <button className="button small primary" onClick={() => void store.openDiff(node.id, `${typeLabel(node.type, node.role)} ${node.name}`)}>Source diff</button>}
            {data.before && data.sourceDiff && status !== 'removed' && <button className="button small" onClick={() => void store.openSource({ entity: data.before!.entity.id, side: 'baseline' }, `Before · ${node.name} @ ${at(data.before!.snapshot)}`)}>Before</button>}
          </div>
          {(data.metadata.length > 0 || data.metrics.before !== data.metrics.after || data.before?.parent?.id !== data.after?.parent?.id) && status !== 'added' && status !== 'removed' && (
            <dl className="facts change-facts">
              {data.before?.parent?.id !== data.after?.parent?.id && data.before && data.after && <><dt>Parent</dt><dd><span className="before">{data.before.parent?.name ?? '—'}</span> → <span className="after">{data.after.parent?.name ?? '—'}</span></dd></>}
              {data.metrics.before !== data.metrics.after && <><dt>Lines</dt><dd><span className="before">{data.metrics.before ?? '—'}</span> → <span className="after">{data.metrics.after ?? '—'}</span></dd></>}
              {data.metadata.map(item => <MetadataChange key={item.key} item={item} />)}
            </dl>
          )}
          {(data.relations.added.length > 0 || data.relations.removed.length > 0) && (
            <div className="change-group">
              <div className="direction">Relationships <span className="added">+{data.relations.added.length}</span> <span className="removed">−{data.relations.removed.length}</span></div>
              <ul className="list">{[...data.relations.added, ...data.relations.removed].slice(0, 60).map(item => <RelationRow key={`${item.change}${item.id}`} item={item} emphasized={false} selectedName={node.name} />)}</ul>
            </div>
          )}
          {(data.diagnostics.added.length > 0 || data.diagnostics.removed.length > 0) && (
            <div className="change-group">
              <div className="direction">Findings <span className="added">+{data.diagnostics.added.length} new</span> <span className="removed">−{data.diagnostics.removed.length} resolved</span></div>
              <ul className="list">{[...data.diagnostics.added.map(item => ({ item, kind: 'added' })), ...data.diagnostics.removed.map(item => ({ item, kind: 'removed' }))].slice(0, 40).map(({ item, kind }) => <DiagnosticChange key={`${kind}${item.id}`} item={item} kind={kind} />)}</ul>
            </div>
          )}
          {data.evidenceChanged && <p className="absent" style={{ margin: '6px 0 0' }}>Evidence changed ({data.before?.evidenceCount} → {data.after?.evidenceCount} records).</p>}
        </>
      )}
    </section>
  );
}
function MetadataChange({ item }: { item: { key: string; before?: unknown; after?: unknown } }) {
  const format = (value: unknown) => value === undefined ? '—' : typeof value === 'string' ? (item.key === 'contentHash' ? `${value.slice(0, 10)}…` : value) : typeof value === 'boolean' ? (value ? 'yes' : 'no') : JSON.stringify(value);
  const label = item.key === 'contentHash' ? 'Source hash' : FACT_LABELS[item.key] ?? item.key;
  const before = format(item.before), after = format(item.after);
  const long = before.length + after.length > 60;
  return <><dt>{label}</dt><dd className={long ? 'mono change-long' : 'mono'}><span className="before">{before}</span>{long ? <br /> : ' '}→ <span className="after">{after}</span></dd></>;
}
function DiagnosticChange({ item, kind }: { item: DiagnosticItem; kind: string }) {
  const store = useStore();
  return (
    <li className={`row diagnostic ${item.severity}${kind === 'removed' ? ' removed-row' : ''}`}>
      <div className="row-main">
        <div className="row-title"><ChangeBadge status={kind} text={kind === 'added' ? 'new' : 'resolved'} /><span className="label">{item.code}</span></div>
        <div className="row-sub" title={item.reason}>{item.reason}</div>
      </div>
      {item.file && kind === 'added' && <div className="row-actions"><button className="button small" onClick={() => void store.openSource({ diagnostic: item.id }, `${item.code} · ${item.file}${item.line ? `:${item.line}` : ''}`)}>Source</button></div>}
    </li>
  );
}
/** When this entity appeared, changed and disappeared on the indexed timeline. */
function EntityTimeline() {
  const store = useStore();
  const timeline = useAtlas(state => state.selection?.timeline);
  const data = useAtlas(state => state.timeline.data);
  const target = useAtlas(state => state.timeline.target);
  const history = timeline?.data;
  return (
    <details className="section" open>
      <summary>History of this entity {history && <span className="chip"><span className="count">{history.points.length}</span></span>}</summary>
      {timeline?.status === 'loading' && <p className="absent">Loading…</p>}
      {timeline?.status === 'error' && <p className="note error">{timeline.error}</p>}
      {history && history.points.length === 0 && <p className="absent">Not present in any indexed commit under this identity (it may be new in the working tree, or its ID changed; comparisons follow renames).</p>}
      {history && history.points.length > 0 && (
        <>
          <p className="absent" style={{ margin: '0 0 6px' }}>Present in {history.present} of {history.indexedSnapshots} indexed commits. Follows this ID; renames show up in comparisons.</p>
          <ul className="list entity-history">
            {[...history.points].reverse().map(point => {
              const entry = data?.entries.find(item => item.sha === point.sha);
              const current = entry?.snapshot?.id === target;
              return (
                <li key={point.sha + point.status} className={`row${current ? ' emphasized' : ''}`}>
                  <div className="row-main">
                    <div className="row-title"><ChangeBadge status={point.status === 'introduced' || point.status === 'reintroduced' ? 'added' : point.status} text={point.status} /><span className="mono">{shortSha(point.sha)}</span><span className="label" title={entry?.subject}>{entry?.subject ?? ''}</span></div>
                    <div className="row-sub">{entry ? new Date(entry.authoredAt).toLocaleDateString() : ''}{entry ? ` · ${entry.authorName}` : ''}{point.path ? ` · ${point.path}` : ''}</div>
                  </div>
                  <div className="row-actions"><button className="button small" disabled={current} onClick={() => void store.setTarget(point.snapshotId)}>View</button></div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </details>
  );
}
function CommitCard({ sha }: { sha?: string }) {
  const data = useAtlas(state => state.timeline.data);
  const entry = data?.entries.find(item => item.sha === sha);
  if (!entry) return null;
  return (
    <section className="section">
      <h4>Commit</h4>
      <dl className="facts">
        <dt>Subject</dt><dd>{entry.subject}</dd>
        <dt>Author</dt><dd>{entry.authorName} · {new Date(entry.authoredAt).toLocaleString()}</dd>
        <dt>Parents</dt><dd className="mono">{entry.parents.map(parent => shortSha(parent)).join(', ') || 'none (root commit)'}{entry.merge ? ' · merge commit' : ''}</dd>
        {entry.pullRequest && <><dt>Pull request</dt><dd>#{entry.pullRequest.number}{entry.pullRequest.title ? ` ${entry.pullRequest.title}` : ''} <span className="absent">({entry.pullRequest.source === 'github' ? 'GitHub' : 'inferred from the commit message, unverified'})</span></dd></>}
        {entry.snapshot?.stats.substitutedApplications && <><dt>Applications</dt><dd>{Object.entries(entry.snapshot.stats.substitutedApplications).map(([name, at]) => `${name} lived at ${at}/`).join(', ')}</dd></>}
        {entry.snapshot?.stats.applicationSource === 'detected' && <><dt>Applications</dt><dd>autodetected at this commit: {entry.snapshot.stats.applications.join(', ') || 'none'}</dd></>}
      </dl>
    </section>
  );
}
/** Comparison overview: what changed, by kind, with every changed entity one click away. */
function ComparisonOverview() {
  const store = useStore();
  const meta = useAtlas(state => state.meta)!;
  const timeline = useAtlas(state => state.timeline);
  const changes = timeline.changes;
  const comparison = meta.comparison!;
  const summary = comparison.summary;
  const at = (ref: { kind: string; commitSha?: string; id: string }) => ref.kind === 'commit' ? `${shortSha(ref.commitSha)} ${entryOf(timeline.data, ref.id)?.subject ?? ''}` : 'Working tree (live index)';
  const statusCounts = changes.page?.statusCounts ?? {};
  return (
    <div>
      <div className="inspector-title">
        <span className="type-badge">Comparison</span>
        <h3>{meta.run.repositoryName}</h3>
      </div>
      <dl className="facts">
        <dt>From</dt><dd className="mono">{at(comparison.baseline)}</dd>
        <dt>To</dt><dd className="mono">{at(meta.snapshot)}</dd>
        <dt>Entities</dt><dd>{(['added', 'modified', 'moved', 'removed'] as const).map(key => <span key={key} className={`change-count ${key}`}>{compactNumber(summary.entities[key])} {key}</span>)}</dd>
        <dt>Files</dt><dd>+{summary.files.added} ~{summary.files.modified} →{summary.files.moved} −{summary.files.removed} · lines {compactNumber(summary.files.locBefore)} → {compactNumber(summary.files.locAfter)}</dd>
        <dt>Relationships</dt><dd><span className="added">+{summary.relations.added}</span> <span className="removed">−{summary.relations.removed}</span>{summary.relations.byType.length ? <span className="absent"> · {summary.relations.byType.slice(0, 4).map(row => `${row.type} +${row.added}/−${row.removed}`).join(', ')}</span> : null}</dd>
        <dt>Findings</dt><dd><span className="added">+{summary.diagnostics.added} new</span> <span className="removed">−{summary.diagnostics.removed} resolved</span></dd>
        <dt>Reach</dt><dd><CommitImpactChip /> <span className="absent">dependents of what changed (click to show on the map)</span></dd>
        {summary.lineage.mapped > 0 && <><dt>Identity</dt><dd>{summary.lineage.mapped} entities followed across renames <span className="absent">({Object.entries(summary.lineage.byReason).map(([reason, count]) => `${count} ${reason}`).join(', ')})</span></dd></>}
      </dl>
      {comparison.analyzerMismatch && <p className="note warning">These snapshots were analyzed by different analyzer versions. Reindex the working tree (or re-run history index) so differences come from the code only.</p>}
      {summary.applications.length > 0 && (
        <section className="section">
          <h4>Applications</h4>
          <ul className="list">{summary.applications.map(app => <li key={app.id} className="row"><div className="row-main"><div className="row-title"><ChangeBadge status={app.status} /><span className="label">{app.name}</span></div>{app.previousName && <div className="row-sub">was {app.previousName}</div>}</div><div className="row-actions"><button className="button small" onClick={() => void store.select(app.id, { fly: true })}>Go</button></div></li>)}</ul>
        </section>
      )}
      {summary.interfaces.length > 0 && (
        <details className="section" open={summary.interfaces.length <= 12 ? true : undefined}>
          <summary>Routes &amp; endpoints <span className="chip"><span className="count">{summary.interfaces.length}</span></span></summary>
          <ul className="list">{summary.interfaces.map(item => <li key={item.id} className="row"><div className="row-main"><div className="row-title"><ChangeBadge status={item.status} /><span className="label mono">{item.name}</span></div>{item.previousName && <div className="row-sub">was {item.previousName}</div>}</div><div className="row-actions"><button className="button small" onClick={() => void store.select(item.id, { fly: true })}>Go</button></div></li>)}</ul>
        </details>
      )}
      <section className="section">
        <h4>Changed entities {changes.page && <span className="chip"><span className="count">{changes.page.total}</span></span>}</h4>
        <div className="filters" role="group" aria-label="Filter changes">
          <button className="chip" aria-pressed={!changes.filter} onClick={() => void store.loadChanges(undefined)}>All</button>
          {(['added', 'modified', 'moved', 'removed'] as const).map(key => <button key={key} className={`chip status-${key}`} aria-pressed={changes.filter === key} onClick={() => void store.loadChanges(changes.filter === key ? undefined : key)} disabled={!summary.entities[key]}>{key} <span className="count">{statusCounts[key] ?? summary.entities[key]}</span></button>)}
        </div>
        {changes.status === 'loading' && changes.items.length === 0 && <p className="absent">Loading changes…</p>}
        {changes.status === 'error' && <p className="note error">{changes.error}</p>}
        <ul className="list">
          {changes.items.map(item => (
            <li key={item.id} className={`row${item.change?.status === 'removed' ? ' removed-row' : ''}`}>
              <div className="row-main">
                <div className="row-title"><ChangeBadge status={item.change?.status ?? 'unchanged'} /><TypeBadge type={item.type} role={item.role} /><span className="label" title={item.name}>{item.name}</span></div>
                <div className="row-sub" title={item.path ?? item.breadcrumb}>{item.change?.previousPath ? `${item.change.previousPath} → ` : ''}{item.path ?? item.breadcrumb}{item.change?.facets.length ? ` · ${describe(item.change)}` : ''}</div>
              </div>
              <div className="row-actions"><button className="button small" onClick={() => void store.select(item.id, { fly: true })} aria-label={`Go to ${item.name}`}>Go</button></div>
            </li>
          ))}
        </ul>
        {changes.page?.hasMore && <button className="button small" style={{ marginTop: 6 }} onClick={() => void store.loadChanges(changes.filter, true)} disabled={changes.status === 'loading'}>Load more ({changes.items.length} of {changes.page.total})</button>}
      </section>
    </div>
  );
}
