/**
 * Writes the README graphics to docs/readme/, each for dark and light backgrounds:
 *   stacks-on-{dark,light}.svg             the featured frameworks and the languages, from lib/stacks.ts
 *   comprehension-gap-on-{dark,light}.svg  the comprehension gap, from lib/gap.ts, animated once with CSS and SMIL
 * GitHub shows them through <picture>, so its theme picks the variant. Text uses system fonts: an SVG shown as an
 * image cannot load web fonts.
 *
 *   npm run graphics
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAP_GHOSTS, GAP_MILESTONES, agentOutput, gapArea, gapLine, gapScale, humanComprehension, withCodiluce } from '../lib/gap.ts';
import { FRAMEWORKS, LANGUAGES, PUBLISHED, type Stack } from '../lib/stacks.ts';
import { VERSION } from '../lib/site.ts';

const site = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(site, '../docs/readme');
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace`;

type Theme = 'dark' | 'light';
const THEMES = {
  dark: { text: '#e6edf3', muted: '#8b949e', tile: '#161b22', border: '#30363d', axis: '#3d444d', agent: '#ff6a3d', human: '#3ddc97', gap: '#8b9cff', accent: '#ffbf47' },
  light: { text: '#1f2328', muted: '#59636e', tile: '#f6f8fa', border: '#d1d9e0', axis: '#c8d1da', agent: '#e8552b', human: '#13a865', gap: '#5468ff', accent: '#d99100' },
} as const;

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A logo from public/stacks nested at (x, y), recolored for light backgrounds when the stack says so. */
function logo(stack: Stack, x: number, y: number, size: number, theme: Theme): string {
  const source = readFileSync(path.join(site, 'public/stacks', `${stack.logo ?? stack.id}.svg`), 'utf8');
  const viewBox = source.match(/viewBox="([^"]+)"/)![1];
  let body = source.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>[\s\S]*?<\/title>/, '');
  if (theme === 'light' && stack.light) body = body.replace(/(<path fill=")[^"]+"/, `$1${stack.light}"`);
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${viewBox}">${body}</svg>`;
}

function status(published: boolean, x: number, y: number, theme: Theme): string {
  const c = THEMES[theme];
  return published
    ? `<circle cx="${x}" cy="${y}" r="3.5" fill="${c.accent}"/>`
    : `<circle cx="${x}" cy="${y}" r="3" fill="none" stroke="${c.muted}" stroke-width="1.3"/>`;
}

function stacksWall(theme: Theme): string {
  const c = THEMES[theme];
  const width = 880, gap = 10;
  const parts: string[] = [];
  const label = (text: string, y: number) => parts.push(`<text x="0" y="${y}" fill="${c.muted}" font-family="${MONO}" font-size="11" letter-spacing="1.2">${text}</text>`);

  label('FRAMEWORKS', 12);
  const columns = 7, tileW = (width - gap * (columns - 1)) / columns, tileH = 96;
  FRAMEWORKS.forEach((stack, i) => {
    const x = (i % columns) * (tileW + gap), y = 24 + Math.floor(i / columns) * (tileH + gap);
    parts.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${tileW - 1}" height="${tileH - 1}" rx="10" fill="${c.tile}" stroke="${c.border}"/>`);
    parts.push(logo(stack, x + (tileW - 34) / 2, y + 16, 34, theme));
    parts.push(`<text x="${x + tileW / 2}" y="${y + 76}" fill="${c.text}" font-family="${FONT}" font-size="13.5" font-weight="600" text-anchor="middle">${escape(stack.name)}</text>`);
    parts.push(status(PUBLISHED.has(stack.id), x + tileW - 12, y + 12, theme));
  });

  const top = 24 + 2 * tileH + gap + 34;
  label('LANGUAGES', top);
  const langW = (width - gap * (LANGUAGES.length - 1)) / LANGUAGES.length, langH = 70;
  LANGUAGES.forEach((stack, i) => {
    const x = i * (langW + gap), y = top + 12;
    parts.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${langW - 1}" height="${langH - 1}" rx="10" fill="${c.tile}" stroke="${c.border}"/>`);
    parts.push(logo(stack, x + (langW - 24) / 2, y + 12, 24, theme));
    parts.push(`<text x="${x + langW / 2}" y="${y + 56}" fill="${c.text}" font-family="${FONT}" font-size="12" font-weight="600" text-anchor="middle">${escape(stack.name)}</text>`);
    parts.push(status(PUBLISHED.has(stack.id), x + langW - 10, y + 10, theme));
  });

  const legend = top + 12 + langH + 30;
  parts.push(status(true, 4, legend - 4, theme));
  parts.push(`<text x="14" y="${legend}" fill="${c.muted}" font-family="${FONT}" font-size="12">In the npm release, v${VERSION}</text>`);
  parts.push(status(false, 196, legend - 4, theme));
  parts.push(`<text x="206" y="${legend}" fill="${c.muted}" font-family="${FONT}" font-size="12">On main: run it from source, ships in the next release</text>`);

  const height = legend + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Frameworks and languages Codiluce analyzes"><title>Frameworks and languages Codiluce analyzes</title>${parts.join('')}</svg>\n`;
}

function pill(text: string, x: number, y: number, color: string, theme: Theme, className: string): string {
  const c = THEMES[theme], w = 26 + text.length * 7.1;
  return `<g class="${className}"><rect x="${x}" y="${y - 14}" width="${w}" height="28" rx="14" fill="${color}" fill-opacity="${theme === 'dark' ? 0.12 : 0.1}" stroke="${color}" stroke-opacity="0.55"/>`
    + `<circle cx="${x + 13}" cy="${y}" r="4" fill="${color}"/><text x="${x + 23}" y="${y + 4.5}" fill="${c.text}" font-family="${FONT}" font-size="12.5">${text}</text></g>`;
}

function gapChart(theme: Theme): string {
  const c = THEMES[theme];
  const width = 880, height = 340, plotW = 680;
  const scale = gapScale(plotW, height);
  const agent = gapLine(agentOutput, 0, 1, scale);
  const parts: string[] = [];
  parts.push(`<defs><linearGradient id="band" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.accent}" stop-opacity="0.28"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0.03"/></linearGradient>`
    + ['agent', 'human'].map(kind => `<linearGradient id="ghost-${kind}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${kind === 'agent' ? c.agent : c.human}" stop-opacity="0.05"/><stop offset="0.65" stop-color="${kind === 'agent' ? c.agent : c.human}" stop-opacity="0.25"/><stop offset="1" stop-color="${kind === 'agent' ? c.agent : c.human}" stop-opacity="0"/></linearGradient>`).join('')
    + '</defs>');
  parts.push(`<path d="M0 ${scale.axis}H${plotW}M${plotW - 8} ${scale.axis - 4}L${plotW} ${scale.axis}L${plotW - 8} ${scale.axis + 4}" stroke="${c.axis}" stroke-width="1.2" fill="none"/>`);
  GAP_MILESTONES.forEach(milestone => {
    const x = scale.x(milestone.x), w = 22 + milestone.label.length * 6.6;
    parts.push(`<g class="milestone" style="animation-delay:${(0.4 + milestone.x * 3.2).toFixed(2)}s"><path d="M${x} ${scale.axis}V${scale.y(agentOutput(milestone.x)) + 4}" stroke="${c.axis}" stroke-dasharray="3 4" fill="none"/>`
      + `<rect x="${x - w / 2}" y="${scale.axis + 12}" width="${w}" height="24" rx="12" fill="${c.tile}" stroke="${c.border}"/>`
      + `<text x="${x}" y="${scale.axis + 28}" fill="${c.muted}" font-family="${FONT}" font-size="12" text-anchor="middle">${milestone.label}</text></g>`);
  });
  GAP_GHOSTS.forEach(ghost => parts.push(`<path class="draw" pathLength="1" d="${gapLine(ghost.f, 0, ghost.end, scale, 90)}" stroke="url(#ghost-${ghost.kind})" stroke-width="1.2" fill="none"/>`));
  parts.push(`<path class="band" d="${gapArea(humanComprehension, withCodiluce, 1, scale)}" fill="url(#band)"/>`);
  parts.push(`<path class="draw" pathLength="1" d="${gapLine(humanComprehension, 0, 1, scale)}" stroke="${c.human}" stroke-width="2" fill="none" stroke-linecap="round"/>`);
  parts.push(`<path class="draw" pathLength="1" d="${agent}" stroke="${c.agent}" stroke-width="8" stroke-opacity="0.1" fill="none" stroke-linecap="round"/>`);
  parts.push(`<path class="draw" pathLength="1" d="${agent}" stroke="${c.agent}" stroke-width="2" fill="none" stroke-linecap="round"/>`);
  parts.push(`<path class="lift" pathLength="1" d="${gapLine(withCodiluce, 0, 1, scale)}" stroke="${c.accent}" stroke-width="2" fill="none" stroke-linecap="round"/>`);
  const end = { agent: scale.y(agentOutput(1)), human: scale.y(humanComprehension(1)), lifted: scale.y(withCodiluce(1)) };
  parts.push(`<path class="gap" d="M${scale.x(1)} ${end.agent + 6}V${end.human - 6}" stroke="${c.gap}" stroke-width="1.6" stroke-dasharray="4 5" fill="none"/>`);
  // Output keeps flowing along its curve, faster as it climbs.
  for (let i = 0; i < 6; i++) parts.push(`<circle r="2" fill="${c.agent}" opacity="0"><animate attributeName="opacity" values="0;0.9;0" dur="5s" begin="${3.6 + i * 0.83}s" repeatCount="indefinite"/><animateMotion dur="5s" begin="${3.6 + i * 0.83}s" repeatCount="indefinite" path="${agent}"/></circle>`);
  const lx = plotW + 22;
  parts.push(pill('Agent output', lx, end.agent, c.agent, theme, 'label'));
  parts.push(pill('Comprehension gap', lx, (end.agent + end.lifted) / 2, c.gap, theme, 'label'));
  parts.push(pill('With Codiluce', lx, end.lifted, c.accent, theme, 'label late'));
  parts.push(pill('Human comprehension', lx, end.human, c.human, theme, 'label'));
  const style = `<style>
.draw{animation:draw 3.4s ease-in-out both}
.lift{animation:draw 1.8s ease-in-out 4.4s both}
.band{animation:fade 1.8s ease 4.6s both}
.gap,.label{animation:fade .8s ease 3.3s both}
.late{animation-delay:5.6s}
.milestone{animation:fade .6s ease both}
@keyframes draw{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes fade{from{opacity:0}to{opacity:1}}
.draw,.lift{stroke-dasharray:1}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>`;
  const title = 'The comprehension gap is widening: agent output grows exponentially while human comprehension barely rises. With Codiluce, comprehension follows the output.';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}"><title>${title}</title>${style}${parts.join('')}</svg>\n`;
}

mkdirSync(out, { recursive: true });
for (const theme of ['dark', 'light'] as const) {
  writeFileSync(path.join(out, `stacks-on-${theme}.svg`), stacksWall(theme));
  writeFileSync(path.join(out, `comprehension-gap-on-${theme}.svg`), gapChart(theme));
}
console.log(`Wrote README graphics to ${path.relative(process.cwd(), out) || '.'}`);
