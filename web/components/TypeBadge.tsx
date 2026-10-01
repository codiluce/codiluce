'use client';
import { typeLabel } from '../lib/format';
import { themeById } from '../lib/themes';
import { useAtlas } from './context';

export function TypeBadge({ type, role, kind }: { type: string; role?: string; kind?: 'entity' | 'group' }) {
  const theme = themeById(useAtlas(state => state.themeId));
  const base = theme.entity[type] ?? theme.fallbackEntity;
  return (
    <span className="type-badge">
      <span className="type-dot" style={{ background: `hsl(${base.h} ${base.s}% ${base.l}%)` }} aria-hidden />
      {kind === 'group' ? 'Projection district' : typeLabel(type, role)}
    </span>
  );
}
