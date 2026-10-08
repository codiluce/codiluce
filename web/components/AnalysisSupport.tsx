import { Fragment } from 'react';
import { ANALYSIS_FEATURES, type FileAnalysis, type SupportStatus } from '@engine/analysis/facts';

const LABELS = { structure: 'Declarations', imports: 'Imports', references: 'Code connections', framework: 'Framework behavior', effects: 'Effects', guards: 'Branch conditions' };
const STATUS: Record<SupportStatus, string> = { supported: 'Available', partial: 'Partial', unsupported: 'Unavailable', disabled: 'Disabled', failed: 'Failed' };

export function AnalysisSupport({ analysis }: { analysis?: FileAnalysis }) {
  if (!analysis) return null;
  const reasons = [...new Set(ANALYSIS_FEATURES.map(feature => analysis.features[feature].reason).filter((reason): reason is string => !!reason))];
  return (
    <section className="section" aria-label="Analysis coverage">
      <h4>Analysis coverage</h4>
      <dl className="facts">
        {ANALYSIS_FEATURES.map(feature => {
          const outcome = analysis.features[feature];
          return <Fragment key={feature}><dt>{LABELS[feature]}</dt><dd title={outcome.reason}>{STATUS[outcome.status]}</dd></Fragment>;
        })}
      </dl>
      {['supported', 'partial'].includes(analysis.features.structure.status) && analysis.features.references.status === 'unsupported' && <p className="note">Declarations are indexed. Calls and flows are not measured for this file.</p>}
      {reasons.length > 0 && <details><summary>Limits and findings</summary>{reasons.map(reason => <p className="note" key={reason}>{reason}</p>)}</details>}
    </section>
  );
}
