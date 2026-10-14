'use client';
// Explanation text, rendered from its Markdown. Links that name code light it
// on the map while the pointer (or focus) is on them and open it on click;
// links that resolve to nothing are struck through with the reason; external
// links open in a new tab. Code blocks are highlighted like the Code panel.
import { useMemo, type ReactNode } from 'react';
import type { ResolvedLink } from '@engine/explanations/model';
import { parseMarkdown, type Block, type Inline } from '../lib/markdown';
import { typeLabel } from '../lib/format';

export interface LinkHandlers {
  resolve(href: string): ResolvedLink | undefined;
  hover(link: ResolvedLink | undefined): void;
  follow(link: ResolvedLink): void;
  /** Links not resolved yet (an answer being written): drawn as code names, not as links. */
  pending?: boolean;
}
export function Markdown({ text, links }: { text: string; links: LinkHandlers }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="markdown">{blocks.map((block, index) => <BlockView key={index} block={block} links={links} />)}</div>;
}
function BlockView({ block, links }: { block: Block; links: LinkHandlers }): ReactNode {
  switch (block.kind) {
    case 'heading': { const Tag = `h${Math.min(6, block.level + 2)}` as 'h3'; return <Tag className={`md-h${block.level}`}><Inlines nodes={block.children} links={links} /></Tag>; }
    case 'paragraph': return <p><Inlines nodes={block.children} links={links} /></p>;
    case 'rule': return <hr />;
    case 'code': return <pre className="md-code" data-language={block.language || undefined}><code>{block.text}</code></pre>;
    case 'quote': return <blockquote>{block.children.map((child, index) => <BlockView key={index} block={child} links={links} />)}</blockquote>;
    case 'list': {
      const items = block.items.map((item, index) => <li key={index}>{item.length === 1 && item[0]!.kind === 'paragraph' ? <Inlines nodes={item[0]!.children} links={links} /> : item.map((child, inner) => <BlockView key={inner} block={child} links={links} />)}</li>);
      return block.ordered ? <ol start={block.start !== 1 ? block.start : undefined}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'table': return (
      <div className="md-table"><table>
        <thead><tr>{block.head.map((cell, index) => <th key={index} style={{ textAlign: block.align[index] }}><Inlines nodes={cell} links={links} /></th>)}</tr></thead>
        <tbody>{block.rows.map((row, index) => <tr key={index}>{row.map((cell, inner) => <td key={inner} style={{ textAlign: block.align[inner] }}><Inlines nodes={cell} links={links} /></td>)}</tr>)}</tbody>
      </table></div>
    );
  }
}
function Inlines({ nodes, links }: { nodes: Inline[]; links: LinkHandlers }) {
  return <>{nodes.map((node, index) => <InlineView key={index} node={node} links={links} />)}</>;
}
function InlineView({ node, links }: { node: Inline; links: LinkHandlers }): ReactNode {
  switch (node.kind) {
    case 'text': return node.text;
    case 'break': return <br />;
    case 'code': return <code>{node.text}</code>;
    case 'strong': return <strong><Inlines nodes={node.children} links={links} /></strong>;
    case 'em': return <em><Inlines nodes={node.children} links={links} /></em>;
    case 'del': return <del><Inlines nodes={node.children} links={links} /></del>;
    case 'link': return <CodeLink href={node.href} links={links}><Inlines nodes={node.children} links={links} /></CodeLink>;
  }
}
function CodeLink({ href, links, children }: { href: string; links: LinkHandlers; children: ReactNode }) {
  if (/^(https?:|mailto:)/i.test(href)) return <a href={href} target="_blank" rel="noreferrer noopener" className="md-external">{children}</a>;
  if (links.pending) return <span className="xlink pending" title={href}>{children}</span>;
  const link = links.resolve(href);
  if (!link) return <span className="xlink unknown" title={href}>{children}</span>;
  if (link.status === 'missing') return <span className="xlink missing" title={`Not in the index: ${link.reason ?? href}`}>{children}</span>;
  const what = link.kind === 'commit' || link.kind === 'pr' ? `${link.kind === 'pr' ? 'Pull request' : 'Commit'} ${link.sha?.slice(0, 10) ?? ''}${link.label ? ` · ${link.label}` : ''}` : link.kind === 'feature' ? `Feature ${link.label ?? ''}` : link.kind === 'flow' ? `Flow ${link.label ?? link.name ?? ''}` : `${typeLabel(link.type ?? 'file')} ${link.path ?? link.name ?? ''}${link.lines ? `:${link.lines.start}${link.lines.end !== link.lines.start ? `–${link.lines.end}` : ''}` : ''}`;
  const changed = link.status === 'changed' ? ' · changed since this was written' : '';
  return (
    <a href={`#${encodeURIComponent(href)}`} className={`xlink ${link.kind}${link.status === 'changed' ? ' changed' : ''}`} title={`${what}${changed}\nClick to open it`}
      onMouseEnter={() => links.hover(link)} onMouseLeave={() => links.hover(undefined)} onFocus={() => links.hover(link)} onBlur={() => links.hover(undefined)}
      onClick={event => { event.preventDefault(); links.follow(link); }}>
      {children}
    </a>
  );
}
