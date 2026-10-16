'use client';
// A diagram of code: boxes (files, folders, symbols, tables, flows) in
// columns along their arrows, a light band per folder, and labelled arrows
// that may carry evidence chips. It knows nothing of tours: a tour scene, and
// later Impact, hand it boxes and arrows. Boxes keep their key, so a new
// picture slides the shared ones to their new places; given `origins` (where
// their blocks are on the map, in client pixels), boxes rise from there into
// the diagram, and with `leaving`, sink back.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { layoutDiagram, type DiagramLayout, type DiagramNode } from '../lib/diagram-layout';
import type { ScreenRect } from '../lib/map-morph';

export interface DiagramPart { id: string; title: string; kind: string; caption?: string; state?: 'ok' | 'changed' | 'missing'; note?: string }
export interface DiagramBox extends DiagramPart {
  /** The band it sits in (a folder path; `''`: none). */
  group: string;
  subtitle?: string;
  /** What sits inside it (a file's symbols); arrows may end on them. */
  parts?: DiagramPart[];
  /** A fixed column (otherwise from the arrows). */
  column?: number;
}
export interface DiagramArrow { id: string; from: string; to: string; label: string; directed: boolean; chips?: { text: string; title?: string }[] }
export interface CodeDiagramProps {
  boxes: DiagramBox[]; arrows: DiagramArrow[];
  start?: string;
  groupLabel?: (group: string) => string;
  /** Where boxes rise from (client pixels, by box or part ID). */
  origins?: ReadonlyMap<string, ScreenRect>;
  /** Sink back to `origins`, then call `onLeft`. */
  leaving?: boolean;
  onLeft?: () => void;
  /** A box or part under the pointer (undefined: none). */
  onHover?: (id: string | undefined) => void;
  onSelect?: (id: string) => void;
  className?: string;
  label?: string;
}

const BOX_W = 236, HEAD = 62, CAPTION = 18, PART = 26, PARTS_PAD = 8;
const RISE_MS = 680, STAGGER_MS = 45;

/** A label's size as drawn (140px wide at most, 11.5px text, chips below), estimated. */
function labelSize(arrow: DiagramArrow): { w: number; h: number } {
  const width = Math.min(140, arrow.label.length * 6.1 + 12);
  const lines = Math.max(1, Math.ceil(arrow.label.length * 6.1 / 128));
  return { w: Math.max(width, arrow.chips?.length ? 60 : 0), h: lines * 15 + 4 + (arrow.chips?.length ? 18 : 0) };
}
function boxHeight(box: DiagramBox): number { return HEAD + (box.caption ? CAPTION : 0) + (box.parts?.length ? PARTS_PAD + box.parts.length * PART : 0); }
function partOffset(box: DiagramBox, index: number): number { return HEAD + (box.caption ? CAPTION : 0) + PARTS_PAD / 2 + index * PART + PART / 2; }

export function CodeDiagram({ boxes, arrows, start, groupLabel, origins, leaving, onLeft, onHover, onSelect, className, label }: CodeDiagramProps) {
  const layouts = useMemo(() => {
    const nodes: DiagramNode[] = boxes.map(box => ({ id: box.id, group: box.group, w: BOX_W, h: boxHeight(box), ...(box.column !== undefined ? { column: box.column } : {}), ...(box.parts?.length ? { ports: Object.fromEntries(box.parts.map((part, index) => [part.id, partOffset(box, index)])) } : {}) }));
    const edges = arrows.map(arrow => ({ id: arrow.id, from: arrow.from, to: arrow.to, directed: arrow.directed, label: labelSize(arrow) }));
    return (['right', 'down'] as const).map(direction => layoutDiagram(nodes, edges, { direction, ...(start ? { start } : {}) }));
  }, [boxes, arrows, start]);
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number; left: number; top: number }>();
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => { const rect = element.getBoundingClientRect(); setSize({ w: rect.width, h: rect.height, left: rect.left, top: rect.top }); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Left to right, unless top to bottom fits the frame clearly better; fitted, never much larger than life.
  const fit = (candidate: DiagramLayout) => size ? Math.min(1.15, (size.w - 32) / candidate.width, (size.h - 32) / candidate.height) : 1;
  const layout = fit(layouts[1]!) > fit(layouts[0]!) * 1.12 ? layouts[1]! : layouts[0]!;
  const scale = Math.max(0.3, fit(layout));
  const offset = size ? { x: Math.max(16, (size.w - layout.width * scale) / 2), y: Math.max(16, (size.h - layout.height * scale) / 2) } : { x: 16, y: 16 };

  // Rise: boxes first drawn where their blocks are, then released into place on the next frame.
  const [risen, setRisen] = useState(!origins?.size);
  useEffect(() => {
    if (risen || !size) return;
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setRisen(true)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [risen, size]);
  // New boxes of a later picture rise too: they start at their origin once, then settle.
  const known = useRef(new Set<string>());
  const [settled, setSettled] = useState(0);
  const fresh = boxes.filter(box => !known.current.has(box.id)).map(box => box.id);
  useEffect(() => {
    if (!risen || !fresh.length) return;
    const frameId = requestAnimationFrame(() => { for (const id of fresh) known.current.add(id); setSettled(value => value + 1); });
    return () => cancelAnimationFrame(frameId);
  });
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => onLeft?.(), RISE_MS + 80);
    return () => clearTimeout(timer);
  }, [leaving, onLeft]);

  const placed = new Map(layout.nodes.map(node => [node.id, node]));
  // Where a box would be drawn on screen once placed, and the transform that puts it at its origin instead.
  const away = (id: string, w: number, h: number, x: number, y: number): CSSProperties | undefined => {
    const origin = origins?.get(id);
    if (!origin || !size) return undefined;
    const tx = (origin.x - size.left - offset.x) / scale - x, ty = (origin.y - size.top - offset.y) / scale - y;
    return { transform: `translate(${tx}px, ${ty}px) scale(${Math.max(0.05, origin.w / scale / w)}, ${Math.max(0.05, origin.h / scale / h)})`, opacity: 0.25 };
  };
  const hasOrigin = (id: string) => !!origins?.get(id);
  const shown = risen && !leaving;
  void settled;
  return (
    <div ref={frame} className={`code-diagram${shown ? ' shown' : ''}${leaving ? ' leaving' : ''}${className ? ` ${className}` : ''}`} role="figure" aria-label={label ?? 'Diagram'}>
      {size && <div className="cd-plane" style={{ width: layout.width, height: layout.height, transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}>
        {layout.bands.filter(band => band.group).map(band => (
          <div key={band.group} className="cd-band" style={{ left: band.x, top: band.y, width: band.w, height: band.h }}>
            <span className="cd-band-label mono" title={band.group}>{groupLabel?.(band.group) ?? `${band.group}/`}</span>
          </div>
        ))}
        <svg className="cd-arrows" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map(edge => {
            const arrow = arrows.find(item => item.id === edge.id)!;
            const head = 8, a = edge.angle;
            const points = `${edge.end.x},${edge.end.y} ${edge.end.x - head * Math.cos(a) + (head / 2) * Math.sin(a)},${edge.end.y - head * Math.sin(a) - (head / 2) * Math.cos(a)} ${edge.end.x - head * Math.cos(a) - (head / 2) * Math.sin(a)},${edge.end.y - head * Math.sin(a) + (head / 2) * Math.cos(a)}`;
            return (
              <g key={edge.id} className={`cd-arrow${arrow.chips?.length ? ' evidenced' : ''}${edge.directed ? '' : ' undirected'}`}>
                <path d={edge.path} />
                {edge.directed && <polygon points={points} />}
              </g>
            );
          })}
        </svg>
        {layout.edges.map(edge => {
          const arrow = arrows.find(item => item.id === edge.id)!;
          return (
            <div key={edge.id} className="cd-arrow-label" style={{ left: edge.label.x, top: edge.label.y }}>
              <span className="cd-arrow-text">{arrow.label}</span>
              {arrow.chips?.map(chip => <span key={chip.text} className="cd-chip" title={chip.title}>{chip.text}</span>)}
            </div>
          );
        })}
        {boxes.map((box, index) => {
          const node = placed.get(box.id);
          if (!node) return null;
          // Not yet in place: before the rise, while leaving, and for a box new to this picture (one frame).
          const away$ = !risen || !!leaving || !known.current.has(box.id);
          const atOrigin = away$ && hasOrigin(box.id);
          const style: CSSProperties = { left: node.x, top: node.y, width: node.w, height: node.h, transitionDelay: `${leaving ? 0 : index * STAGGER_MS}ms`, ...(atOrigin ? away(box.id, node.w, node.h, node.x, node.y) : {}) };
          const fading = away$ && !hasOrigin(box.id);
          return (
            <div key={box.id} className={`cd-box s-${box.state ?? 'ok'}${fading ? ' fading' : ''}${away$ && !leaving ? ' held' : ''}`} style={style} title={box.note}>
              <button className="cd-box-head" onMouseEnter={() => onHover?.(box.id)} onMouseLeave={() => onHover?.(undefined)} onFocus={() => onHover?.(box.id)} onBlur={() => onHover?.(undefined)} onClick={() => onSelect?.(box.id)} disabled={box.state === 'missing'}>
                <span className="cd-kind">{box.kind}</span>
                <span className="cd-title">{box.title}</span>
                {box.subtitle && <span className="cd-subtitle mono">{box.subtitle}</span>}
              </button>
              {box.caption && <span className="cd-caption">{box.caption}</span>}
              {box.parts?.length ? (
                <ul className="cd-parts">
                  {box.parts.map(part => (
                    <li key={part.id}>
                      <button className={`cd-part s-${part.state ?? 'ok'}`} title={part.note ?? part.caption} onMouseEnter={() => onHover?.(part.id)} onMouseLeave={() => onHover?.(undefined)} onFocus={() => onHover?.(part.id)} onBlur={() => onHover?.(undefined)} onClick={() => onSelect?.(part.id)} disabled={part.state === 'missing'}>
                        <span className="cd-kind">{part.kind}</span> <span className="cd-part-title">{part.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>}
    </div>
  );
}
