'use client';
import { useEffect, useRef } from 'react';
import type { Archetype, NodeSummary } from '@engine/projection/dto';
import { ISO_X, ISO_Y } from '../lib/camera';
import { compactNumber } from '../lib/format';
import { ARCHETYPE_LABELS, drawShape, shapeHeight, shapeTheme } from '../lib/shapes';
import { PaletteCache, paletteKey, themeById, type Hsl } from '../lib/themes';
import { useAtlas } from './context';

const BASIS = { indexed: 'from the index', convention: 'by convention', language: 'by language' } as const;

/** An archetype's shape, drawn small in the current theme (for the inspector and the help). */
export function ArchetypeIcon({ kind, color, width = 44, height = 40 }: { kind: Archetype; color?: Hsl; width?: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const theme = themeById(useAtlas(state => state.themeId));
  useEffect(() => {
    const canvas = ref.current, ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    const side = 8, H = shapeHeight(kind, side, 160);
    // Fit the footprint (side × side) and its height into the canvas, centered.
    const spanX = side * 2 * ISO_X, spanY = side * 2 * ISO_Y + H, s = Math.min((width - 4) / spanX, (height - 4) / spanY);
    const ox = width / 2, oy = (height - spanY * s) / 2 + H * s;
    const base = color ?? new PaletteCache(theme).base('file', 3);
    drawShape({ ctx, s, ox, oy, T: shapeTheme(theme) }, kind, { x: 0, y: 0, z: 0, w: side, d: side, H, c: base, t: 0, hot: 0, seed: 7 });
  }, [kind, color, width, height, theme]);
  return <canvas ref={ref} className="archetype-icon" style={{ width, height }} aria-hidden />;
}

/** The selection's archetype: its shape, what it is, and why it got it. */
export function ArchetypeChip({ node }: { node: NodeSummary }) {
  const theme = themeById(useAtlas(state => state.themeId));
  const shapes = useAtlas(state => state.shapes);
  const archetype = node.archetype;
  if (!archetype) return null;
  const label = ARCHETYPE_LABELS[archetype.kind];
  return (
    <div className="archetype-chip" title={shapes ? undefined : 'Building shapes are off in Settings'}>
      <ArchetypeIcon kind={archetype.kind} color={new PaletteCache(theme).base(paletteKey(node), node.depth)} />
      <div>
        <div className="archetype-name">{label.name} <span className="muted">· {label.shape}</span></div>
        {archetype.reason && <div className="archetype-reason">{archetype.reason} <span className="muted">({BASIS[archetype.basis]})</span></div>}
      </div>
    </div>
  );
}

/** An area's blocks by kind, most first: what its roof shows on the map, in full. */
export function ArchetypeHoldings({ node }: { node: NodeSummary }) {
  const counts = node.archetypeCounts;
  if (!counts?.length) return null;
  const where = node.type === 'repository' ? 'repository' : node.type === 'application' ? 'application' : node.kind === 'group' ? 'district' : 'folder';
  return (
    <section className="section archetype-holdings">
      <h4>Kinds of block in this {where}</h4>
      <ul className="coverage-keys">
        {counts.map(({ kind, count }) => (
          <li key={kind} title={`${ARCHETYPE_LABELS[kind].name}: drawn as a ${ARCHETYPE_LABELS[kind].shape}`}>
            <ArchetypeIcon kind={kind} width={24} height={22} />{ARCHETYPE_LABELS[kind].name}<span className="count">{compactNumber(count)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Every archetype with its shape: the map's legend for building shapes. */
export function ArchetypeLegend() {
  return (
    <div className="archetype-legend">
      {(Object.keys(ARCHETYPE_LABELS) as Archetype[]).map(kind => (
        <div key={kind} className="archetype-legend-item"><ArchetypeIcon kind={kind} width={38} height={34} /><span><b>{ARCHETYPE_LABELS[kind].name}</b> {ARCHETYPE_LABELS[kind].shape}</span></div>
      ))}
    </div>
  );
}
