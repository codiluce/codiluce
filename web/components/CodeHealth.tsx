'use client';
import { useEffect, useState } from 'react';
import type { Entity } from '@engine/core/graph';
import type { NodeSummary } from '@engine/projection/dto';
import { spreadRank, type FileHealth, type HealthFunction, type HealthMetric, type RepositoryHealth } from '@engine/analysis/metrics/health';
import { compactNumber } from '../lib/format';
import { useAtlas, useStore } from './context';

const LANGUAGE: Record<string, string> = { typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', go: 'Go', php: 'PHP' };
const ROWS: { metric: HealthMetric; label: string; unit?: string; comparison: string; title: string }[] = [
  { metric: 'complexity', label: 'Complexity', comparison: 'higher than', title: 'Cyclomatic complexity: 1 plus each decision (if, else if, loop, case, catch, ternary, && and ||)' },
  { metric: 'nesting', label: 'Nesting', comparison: 'deeper than', title: 'Deepest nesting of ifs, loops, switches and tries, counting the callbacks around them' },
  { metric: 'codeLines', label: 'Length', unit: 'lines of code', comparison: 'longer than', title: 'Lines holding code: not blank lines, comments or lines with only brackets' },
  { metric: 'parameters', label: 'Parameters', comparison: 'more than', title: 'Declared parameters (not self, cls or a Go receiver)' },
];
/** Functions ranking above this share of their language are flagged. */
const FLAG = 0.9;
const WORST_SHOWN = 5;

/** The repository's spread of each metric, fetched once per analysis run. */
const spreads = new Map<string, Promise<RepositoryHealth | undefined>>();
function useRepositoryHealth(): RepositoryHealth | undefined {
  const store = useStore();
  const rootId = useAtlas(state => state.meta?.root.id), runId = useAtlas(state => state.meta?.run.id);
  const [health, setHealth] = useState<{ key: string; value?: RepositoryHealth }>();
  const key = `${runId}:${rootId}`;
  useEffect(() => {
    if (!rootId) return;
    let live = true, request = spreads.get(key);
    if (!request) { request = store.api.entity(rootId).then(root => root.metadata.codeHealth as RepositoryHealth | undefined, () => undefined); spreads.set(key, request); }
    void request.then(value => { if (live) setHealth({ key, value }); });
    return () => { live = false; };
  }, [store, key, rootId]);
  return health?.key === key ? health.value : undefined;
}

/** How a value compares with its language's functions outside tests, when it stands out. */
function Rank({ health, language, metric, value, comparison, flaggedOnly }: { health?: RepositoryHealth; language?: string; metric: HealthMetric; value: number; comparison: string; flaggedOnly?: boolean }) {
  const spread = language ? health?.languages[language] : undefined;
  if (!spread || spread.functions < 20) return null;
  const rank = spreadRank(spread[metric], value);
  if (rank < (flaggedOnly ? FLAG : 0.5)) return null;
  const text = `${comparison} ${Math.floor(rank * 100)}%`;
  return rank >= FLAG ? <span className="chip warning" title={`Compared with the ${spread.functions.toLocaleString('en')} ${LANGUAGE[language!] ?? language} functions of this repository, outside tests`}>{text}</span> : <span className="absent"> · {text}</span>;
}

/** Code health of the selection: a function's own numbers, or a file's worst functions. */
export function CodeHealthSection({ node, entity }: { node: NodeSummary; entity: Entity }) {
  const health = useRepositoryHealth();
  const metrics = entity.metrics, language = entity.language ?? node.language;
  if (node.type === 'file') return <FileHealthSection entity={entity} health={health} />;
  if (metrics?.complexity === undefined) {
    const kind = entity.metadata.declarationKind;
    if (!['function', 'method', 'component', 'test'].includes(entity.type)) return null;
    if (entity.metadata.anonymous === true || kind === 'closure') return <section className="section"><h4>Code health</h4><p className="absent">Counted in the function around it: an anonymous function is part of the code that writes it.</p></section>;
    return null;
  }
  const spread = language ? health?.languages[language] : undefined;
  return (
    <section className="section">
      <h4>Code health</h4>
      <dl className="facts">
        {ROWS.map(row => <RowValue key={row.metric} row={row} value={metrics[row.metric]} health={health} language={language} />)}
      </dl>
      {spread && spread.functions >= 20 && <p className="absent" style={{ margin: '6px 0 0' }}>Compared with the {spread.functions.toLocaleString('en')} {LANGUAGE[language!] ?? language} functions of this repository, outside tests.</p>}
    </section>
  );
}
function RowValue({ row, value, health, language }: { row: typeof ROWS[number]; value?: number; health?: RepositoryHealth; language?: string }) {
  if (value === undefined) return null;
  return <><dt title={row.title}>{row.label}</dt><dd>{compactNumber(value)}{row.unit ? ` ${row.unit}` : ''} <Rank health={health} language={language} metric={row.metric} value={value} comparison={row.comparison} /></dd></>;
}

function FileHealthSection({ entity, health }: { entity: Entity; health?: RepositoryHealth }) {
  const store = useStore();
  const file = entity.metadata.health as FileHealth | undefined, metrics = entity.metrics;
  if (!file) return null;
  if ('skipped' in file) return <section className="section"><h4>Code health</h4><p className="absent">Not measured: {file.skipped}.</p></section>;
  const open = (item: HealthFunction) => item.symbol ? void store.select(item.symbol, { fly: true }) : void store.openSource({ entity: entity.id, start: item.startLine, end: item.endLine }, `${item.name} · ${entity.name}:${item.startLine}`);
  return (
    <section className="section">
      <h4>Code health {metrics?.functions !== undefined && <span className="chip"><span className="count">{metrics.functions} function{metrics.functions === 1 ? '' : 's'}</span></span>}</h4>
      <dl className="facts">
        {metrics?.codeLines !== undefined && <><dt title="Lines holding code: not blank lines, comments or lines with only brackets">Lines of code</dt><dd>{compactNumber(metrics.codeLines)}</dd></>}
      </dl>
      {file.worst.length > 0 && <>
        <h4 style={{ marginTop: 10 }}>Most complex</h4>
        <ul className="list">
          {file.worst.slice(0, WORST_SHOWN).map(item => (
            <li key={`${item.startLine}:${item.name}`} className="row">
              <div className="row-main">
                <div className="row-title"><span className="label mono">{item.name}</span> <Rank health={health} language={entity.language} metric="complexity" value={item.complexity} comparison="higher than" flaggedOnly /></div>
                <div className="row-sub" title={`${item.parameters} parameter${item.parameters === 1 ? '' : 's'}; lines ${item.startLine}–${item.endLine}`}>complexity {item.complexity} · nesting {item.nesting} · {item.codeLines} lines · line {item.startLine}</div>
              </div>
              <div className="row-actions"><button className="button small" onClick={() => open(item)} title={item.symbol ? 'Select this function' : 'Read its code (an anonymous function, not a symbol)'}>{item.symbol ? 'Select' : 'Source'}</button></div>
            </li>
          ))}
        </ul>
      </>}
    </section>
  );
}
