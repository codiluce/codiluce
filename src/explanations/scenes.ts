// Tours: an answer told in scenes. Each scene is a `##` section of the answer
// after a `<!-- codiluce:scene {…} -->` marker holding how it shows its code
// (map, diagram or flow), the links it shows and the arrows between them. The
// answer stays plain Markdown (GitHub reads it as is), and the turn parser
// ignores these markers. Pure, so the server and the browser split an answer
// the same way.
import { linksIn, parseLink } from './links.js';
import { SCENE_VIEWS, type Scene, type SceneArrow, type SceneSpec, type SceneView } from './model.js';

export const MAX_SCENES = 24;
export const MAX_SCENE_BOXES = 12;
const SCENE_MARKER = /^<!-- codiluce:scene(?:\s+(\{.*\}))?\s*-->[ \t]*$/gm;
/** Links a box can show: code, not commits, pull requests, features or the web. */
const BOX_KINDS = new Set(['path', 'flow', 'table']);

export interface SplitAnswer { intro: string; scenes: Scene[] }

/** An answer's intro and scenes (none when it was not written as a tour). */
export function scenesOf(text: string): SplitAnswer {
  const markers = [...text.matchAll(SCENE_MARKER)];
  if (!markers.length) return { intro: text.trim(), scenes: [] };
  const intro = text.slice(0, markers[0]!.index).trim();
  const scenes = markers.map((marker, index) => {
    const start = marker.index! + marker[0].length, end = markers[index + 1]?.index ?? text.length;
    const section = text.slice(start, end).trim();
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*(?:\n|$)/.exec(section);
    const title = heading ? heading[1]!.trim() : `Scene ${index + 1}`;
    const markdown = (heading ? section.slice(heading[0].length) : section).trim();
    return { ...specOf(marker[1]), title, markdown };
  });
  return { intro, scenes };
}

/** The answer's Markdown for an intro and scenes: what is stored, and what the full text reads. */
export function composeTour(intro: string | undefined, scenes: Scene[]): string {
  const parts = intro?.trim() ? [intro.trim()] : [];
  for (const scene of scenes) {
    const spec = cleanSpec(scene);
    // `--` cannot appear inside an HTML comment; JSON escapes it.
    const json = JSON.stringify(spec).replace(/--/g, '-\\u002d');
    parts.push(`<!-- codiluce:scene ${json} -->\n## ${oneLine(scene.title)}\n\n${scene.markdown.trim()}`);
  }
  return parts.join('\n\n');
}

/** The links a scene shows, in order: its focus (or its text's code links), then the ends of its arrows and its start. */
export function sceneHrefs(scene: Scene): string[] {
  const hrefs: string[] = [];
  const add = (href: string | undefined) => { const value = href?.trim(); if (value && !hrefs.includes(value)) hrefs.push(value); };
  if (scene.focus?.length) scene.focus.forEach(add);
  else for (const link of linksIn(scene.markdown)) { const parsed = parseLink(link.href); if (parsed && BOX_KINDS.has(parsed.kind) && !(parsed.kind === 'path' && parsed.target === '')) add(link.href); }
  for (const arrow of scene.arrows ?? []) { add(arrow.from); add(arrow.to); }
  add(scene.start);
  return hrefs;
}
/** Every link a scene names outside its text (to resolve and pin with the text's). */
export function sceneExtraHrefs(scene: Scene): string[] {
  return [...new Set([...scene.focus ?? [], ...(scene.arrows ?? []).flatMap(arrow => [arrow.from, arrow.to]), ...scene.start ? [scene.start] : [], ...scene.flow ? [scene.flow] : [], ...Object.keys(scene.captions ?? {})].map(href => href.trim()).filter(Boolean))];
}
export function sceneView(scene: SceneSpec): SceneView { return scene.flow && !scene.view ? 'flow' : scene.view ?? 'diagram'; }
export function canBeBox(href: string): boolean { const parsed = parseLink(href); return !!parsed && BOX_KINDS.has(parsed.kind); }

/** Problems with scenes as given (before their links are resolved): what publishing refuses. */
export function sceneProblems(scenes: Scene[]): string[] {
  const problems: string[] = [];
  if (scenes.length > MAX_SCENES) problems.push(`At most ${MAX_SCENES} scenes (got ${scenes.length}); merge some`);
  scenes.forEach((scene, index) => {
    const name = `Scene ${index + 1}${scene.title ? ` (${scene.title})` : ''}`;
    if (!scene.title?.trim()) problems.push(`${name}: a title is required`);
    if (!scene.markdown?.trim()) problems.push(`${name}: its markdown is empty`);
    if (scene.view && !SCENE_VIEWS.includes(scene.view)) problems.push(`${name}: view must be one of ${SCENE_VIEWS.join(', ')}`);
    if (sceneView(scene) === 'flow' && !scene.flow) problems.push(`${name}: a flow scene needs flow (a flow: link, as the flows tool gives it)`);
    if (scene.flow && parseLink(scene.flow)?.kind !== 'flow') problems.push(`${name}: flow must be a flow: link (got ${scene.flow})`);
    for (const arrow of scene.arrows ?? []) {
      if (!arrow.label?.trim()) problems.push(`${name}: the arrow ${arrow.from} → ${arrow.to} needs a label (what the relationship is)`);
      for (const end of [arrow.from, arrow.to]) if (!canBeBox(end)) problems.push(`${name}: an arrow end must name code (a path, a flow: or a table: link), not ${end}`);
    }
    if (scene.start && !canBeBox(scene.start)) problems.push(`${name}: start must name code, not ${scene.start}`);
    const boxes = sceneHrefs(scene).filter(canBeBox).length;
    if (boxes > MAX_SCENE_BOXES) problems.push(`${name}: ${boxes} boxes; at most ${MAX_SCENE_BOXES} a scene, so split it (or set focus)`);
  });
  return problems;
}

/** Scenes as a tool or a request gives them (unknown fields dropped, types checked loosely). */
export function scenesInput(value: unknown): Scene[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error('scenes must be an array');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`scenes[${index}] must be an object`);
    const raw = item as Record<string, unknown>;
    return { ...specOf(raw), title: text(raw.title) ?? '', markdown: text(raw.markdown) ?? '' };
  });
}

function specOf(source: string | Record<string, unknown> | undefined): SceneSpec {
  let raw: Record<string, unknown> = {};
  if (typeof source === 'string') { try { const parsed = JSON.parse(source) as unknown; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>; } catch { /* a broken marker: a plain scene */ } }
  else if (source) raw = source;
  const spec: SceneSpec = {};
  if (typeof raw.view === 'string') spec.view = raw.view as SceneView;
  const focus = strings(raw.focus); if (focus) spec.focus = focus;
  const start = text(raw.start); if (start) spec.start = start;
  const flow = text(raw.flow); if (flow) spec.flow = flow;
  if (Array.isArray(raw.arrows)) spec.arrows = raw.arrows.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const arrow = item as Record<string, unknown>;
    const from = text(arrow.from), to = text(arrow.to);
    if (!from || !to) return [];
    return [{ from, to, label: text(arrow.label) ?? '', ...(arrow.undirected === true ? { undirected: true } : {}) } satisfies SceneArrow];
  });
  if (raw.captions && typeof raw.captions === 'object' && !Array.isArray(raw.captions)) {
    const captions = Object.fromEntries(Object.entries(raw.captions as Record<string, unknown>).flatMap(([key, value]) => typeof value === 'string' && value.trim() ? [[key, value.trim().slice(0, 80)]] : []));
    if (Object.keys(captions).length) spec.captions = captions;
  }
  return spec;
}
function cleanSpec(scene: Scene): SceneSpec {
  const spec = specOf(scene as unknown as Record<string, unknown>);
  if (spec.view === 'diagram') delete spec.view;
  if (spec.arrows && !spec.arrows.length) delete spec.arrows;
  return spec;
}
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function strings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.flatMap(item => typeof item === 'string' && item.trim() ? [item.trim()] : []);
  return items.length ? items : undefined;
}
function oneLine(value: string): string { return value.replace(/\s+/g, ' ').trim(); }
