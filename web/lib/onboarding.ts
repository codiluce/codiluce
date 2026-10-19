// The onboarding tour: a guided walk on the user's own repository
// (docs/design/onboarding-tour.md). The core tour follows one thread through
// the code, a file the server picks (`/api/projection/onboarding`): where it
// is, finding it, its code, the flow it is part of, what depends on it and how
// it changed. Chapters show the rest. Each stop invites the user to use one
// control, ringed on screen; using it, or Next, does what it says on their
// code. A stop with nothing to show says why and how to turn it on.
//
// Stops are data: the store moves through them, the Onboarding component
// draws them. In code this is "onboarding": "tour" already names explanation
// tours (TourStage) and the flow on the map.
import type { OnboardingResult } from '@engine/projection/dto';
import { relativeTime } from './format';
import type { AtlasState, AtlasStore, ColorMode } from './store';

export const ONBOARDING_KEY = 'codiluce:onboarding';
export type ChapterKey = 'people' | 'agents' | 'explain' | 'features' | 'color' | 'settings';
export type TourKey = 'core' | ChapterKey;
export const CHAPTERS: { key: ChapterKey; title: string; text: string }[] = [
  { key: 'people', title: 'People & PRs', text: 'Who changed which code, and the pull requests on it' },
  { key: 'agents', title: 'Agents', text: 'Coding agents at work on the map, and their sessions replayed' },
  { key: 'explain', title: 'Explain', text: 'Questions about the code, answered with links that light it' },
  { key: 'features', title: 'Features', text: 'What the product does, once the code is described' },
  { key: 'color', title: 'Color by', text: 'Complexity, hotspots and flow coverage over the map' },
  { key: 'settings', title: 'Settings', text: 'Themes, the 2D plan or 3D, building shapes' },
];
const TOURS = new Set<string>(['core', ...CHAPTERS.map(chapter => chapter.key)]);
/** `?tour` starts the core tour, `?tour=people` a chapter; anything else, nothing. */
export function tourParam(search: string): TourKey | undefined {
  const params = new URLSearchParams(search);
  if (!params.has('tour')) return undefined;
  const value = params.get('tour') || 'core';
  return TOURS.has(value) ? value as TourKey : undefined;
}
/** The address without `?tour`, so a reload does not start it again. */
export function withoutTourParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('tour');
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/** What this browser remembers: the welcome card was answered, and the chapters taken. */
export interface OnboardingSaved { seen: boolean; chapters: ChapterKey[] }
type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
export function readSaved(storage: Storage | undefined): OnboardingSaved {
  try {
    const saved = JSON.parse(storage?.getItem(ONBOARDING_KEY) ?? '{}') as { seen?: unknown; chapters?: unknown };
    const chapters = Array.isArray(saved.chapters) ? saved.chapters.filter((key): key is ChapterKey => CHAPTERS.some(chapter => chapter.key === key)) : [];
    return { seen: !!saved.seen, chapters };
  } catch { return { seen: false, chapters: [] }; }
}
export function writeSaved(storage: Storage | undefined, saved: OnboardingSaved): void {
  try { storage?.setItem(ONBOARDING_KEY, JSON.stringify({ seen: saved.seen ? 1 : 0, chapters: saved.chapters })); } catch { /* remembering is optional */ }
}

/** What a stop's words and checks read: the thread, the state now, and the state when its invite showed. */
export interface StopContext { thread: OnboardingResult; state: AtlasState; start: AtlasState; focused?: string }
/**
 * One stop. Its words are plain text with **bold** and `code`. `target` is the
 * control the card stands beside and rings (`data-onboarding`). `prepare`
 * makes what the stop is about true (Next and Back apply it again, after the
 * user wandered off); `done` sees the user do what the invite asks; `show` is
 * what that does, or Next does for them. A stop without `show` has one beat.
 */
export interface Stop {
  key: string; title: string; target: string;
  /** Where the card stands: below the target (the default), or right of it when what opens below must stay visible (search results). */
  side?: 'right';
  invite(context: StopContext): string;
  prepare?(store: AtlasStore, thread: OnboardingResult): Promise<void> | void;
  done?(context: StopContext): boolean;
  show?: { run(store: AtlasStore, thread: OnboardingResult): Promise<void> | void; text(context: StopContext): string };
  /** Nothing to show: why, and how to turn it on (the card says this instead, and the stop has one beat). */
  missing?(context: StopContext): string | undefined;
}

const plural = (count: number, word: string, many = `${word}s`) => `${count.toLocaleString('en')} ${count === 1 ? word : many}`;
/** "1 file depends", "3 files depend". */
const depend = (count: number, word: string) => `${plural(count, word)} ${count === 1 ? 'depends' : 'depend'}`;
/** A reason from the server as a sentence of its own. */
const sentence = (text: string) => /[.!?]$/.test(text) ? text : `${text}.`;
const fileName = (thread: OnboardingResult) => thread.thread.file?.name ?? 'this file';
/** Select the thread's file unless it is selected (without adding to Back and Forward). */
async function selectFile(store: AtlasStore, thread: OnboardingResult): Promise<void> {
  const file = thread.thread.file;
  if (file && store.getState().selection?.id !== file.id) await store.select(file.id, { fly: true, recordHistory: false });
}
const leftOpen = (state: AtlasState, tab: AtlasState['panels']['tab']) => state.panels.left && state.panels.tab === tab;
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const MAP: Stop = {
  key: 'map', title: 'The map', target: 'map',
  invite: ({ thread }) => `This is **${thread.repository}**: every folder is a place and every file a block, sized by its code. Scroll to zoom, drag to move, and double-click a folder to step into it.`,
  // No `done`: exploring the map is the point, so only Next moves on (a camera that settles must not either).
  show: {
    run: (store, thread) => { const folder = thread.thread.folder; if (folder) return store.select(folder.id, { fly: true, recordHistory: false }); store.navigator?.fitAll(); },
    text: ({ thread }) => {
      const folder = thread.thread.folder;
      return folder
        ? `**${folder.name}** holds ${plural(folder.files, 'file')} of the ${thread.counts.files.toLocaleString('en')}. Folders open as you zoom in, and the Inspector on the right describes what is selected.`
        : `Folders open as you zoom in, and the Inspector on the right describes what is selected. **F** fits the whole repository again.`;
    },
  },
};
const SEARCH: Stop = {
  key: 'search', title: 'Search', target: 'search', side: 'right',
  invite: () => 'Looking for something by name? Press **/** and type: files, symbols, routes, tables.',
  done: ({ focused }) => focused === 'search',
  show: {
    run: (store, thread) => { if (thread.thread.file) store.requestSearch(thread.thread.file.name); },
    text: ({ thread }) => `There is **${fileName(thread)}**. **Enter** selects the first result on the map; a result's buttons open it as a flow or its impact.`,
  },
  missing: ({ thread }) => thread.thread.file ? undefined : 'Nothing is indexed yet: search finds the files, symbols, routes and tables of the index.',
};
const CODE: Stop = {
  key: 'code', title: 'Inspector and code', target: 'code',
  prepare: selectFile,
  invite: ({ thread }) => {
    const dependents = thread.thread.file?.dependents ?? 0;
    return `**${fileName(thread)}** is selected. The Inspector lists what it uses and what uses it${dependents ? ` (${depend(dependents, 'file')} on it)` : ''}, and the rest of the map recedes. Click **Code** to read it.`;
  },
  done: ({ state }) => !!state.code,
  show: { run: store => store.openCode(), text: () => 'Code shows the source beside the Inspector and follows what you select: a file whole, or a symbol in its file with its lines marked.' },
  missing: ({ thread }) => thread.thread.file ? undefined : 'Nothing is indexed yet: the Inspector and Code show what you select on the map.',
};
const FLOWS: Stop = {
  key: 'flows', title: 'Flows', target: 'flows',
  // The flow takes the middle: the code steps aside (it comes back when the tour ends, if it was open).
  prepare: async (store, thread) => { if (store.getState().code) store.closeCode(); await selectFile(store, thread); },
  invite: ({ thread }) => thread.thread.flow ? `Which flows pass through **${fileName(thread)}**? Click **Flows**.` : 'Flows are what the code does, from an entry point on. Click **Flows**.',
  done: ({ state }) => leftOpen(state, 'flows'),
  show: {
    run: async (store, thread) => {
      const { file, flow } = thread.thread;
      store.setPanels({ left: true, tab: 'flows' });
      await store.showFlows({ entity: flow && file ? { id: file.id, name: file.name } : null });
      if (flow) await store.openCatalogFlow(flow);
    },
    text: ({ thread }) => {
      const flow = thread.thread.flow;
      if (!flow) return `The Flows panel lists all ${plural(thread.counts.flows, 'flow')} by entry point: pages, requests, commands and scheduled tasks.`;
      return `It is part of **${flow.title ?? flow.name}**: ${plural(flow.files, 'file')} in ${plural(flow.folders, 'folder')}${flow.tables ? `, down to ${plural(flow.tables, 'table')}` : ''}. The middle shows it on the map, in lanes and as an outline; the panel lists every flow through the file.`;
    },
  },
  missing: ({ thread }) => thread.counts.flows ? undefined : 'No entry points were found here. Flows start at the routes, endpoints, pages, commands and scheduled tasks of the languages and frameworks Codiluce reads (codiluce.com/docs/stacks).',
};
const IMPACT: Stop = {
  key: 'impact', title: 'Impact', target: 'impact',
  prepare: selectFile,
  invite: ({ thread }) => `What would a change to **${fileName(thread)}** affect? Click **Impact**.`,
  done: ({ state }) => state.center === 'impact' && state.impact.open,
  show: {
    run: (store, thread) => { const file = thread.thread.file; if (file) return store.showImpact(file.id); },
    text: ({ thread }) => {
      const impact = thread.thread.impact;
      const reach = impact?.total ? `${depend(impact.total, 'place')} on it, up to ${plural(impact.hops, 'hop')} away, listed by hop (or by app, feature or folder) and lit on the map.` : 'Nothing indexed depends on it: a change stays here.';
      return `${reach} **Uncommitted changes** does the same for what you are editing now.`;
    },
  },
  missing: ({ thread }) => thread.thread.file ? undefined : 'Nothing is indexed yet: Impact shows what depends on what you select.',
};
const HISTORY: Stop = {
  key: 'history', title: 'History', target: 'history',
  invite: () => 'How did it get here? Click **History**.',
  done: ({ state }) => state.timeline.open,
  show: {
    run: async (store, thread) => {
      // From the oldest of the file's latest commits, the history plays forward.
      const oldest = thread.thread.history?.recent.at(-1)?.sha;
      await store.openTimeline({ mode: 'git', ...(oldest ? { files: oldest.slice(0, 12) } : {}) });
      if (!reducedMotion()) void store.play();
    },
    text: ({ thread, state }) => {
      const history = thread.thread.history, latest = history?.recent[0];
      const preparing = state.timeline.evolution.status === 'loading' ? ` (Preparing the time-lapse${state.timeline.evolution.progress ? `: ${Math.round(state.timeline.evolution.progress * 100)}%` : ''}.)` : '';
      const lead = history && latest ? `**${fileName(thread)}** changed in ${plural(history.commits, 'commit')}, last ${relativeTime(latest.authoredAt)} by ${history.people.find(person => person.key === latest.people[0])?.name ?? history.people[0]?.name ?? 'someone'}. ` : '';
      return `${lead}The map plays the history from there, commit by commit: drag the timeline to scrub, and **[** and **]** step through the commits.${preparing}`;
    },
  },
  missing: ({ thread }) => thread.available.history ? undefined : `History reads the repository's Git commits. ${sentence(thread.available.historyReason ?? 'There are none here')}`,
};

const PEOPLE: Stop[] = [
  {
    key: 'people-inspector', title: 'Who changed it', target: 'inspector', prepare: selectFile,
    invite: ({ thread }) => {
      const history = thread.thread.history;
      if (!history) return `The Inspector says who changed what you select, and when.`;
      const names = history.people.map(person => person.name);
      return `The Inspector says who changed **${fileName(thread)}**: ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}, in ${plural(history.commits, 'commit')}.`;
    },
  },
  {
    key: 'people-panel', title: 'People', target: 'people',
    invite: () => 'Click **People** for everyone who changed the code.',
    done: ({ state }) => leftOpen(state, 'people'),
    show: {
      run: async (store, thread) => { store.setPanels({ left: true, tab: 'people' }); const person = thread.thread.history?.people[0]; if (person) await store.revealPeople(person.key); else await store.ensurePeople(); },
      text: ({ thread }) => { const person = thread.thread.history?.people[0]; return `${person ? `Selecting **${person.name}** lights the files they changed and dims the rest.` : 'Selecting a person lights the files they changed and dims the rest.'} The window at the top sets how far back the figures go.`; },
    },
  },
  {
    key: 'pulls', title: 'Pull requests', target: 'pulls',
    invite: () => 'Click **PRs** for the pull requests: open work, and what was merged.',
    done: ({ state }) => leftOpen(state, 'pulls'),
    show: {
      run: async store => {
        store.setPanels({ left: true, tab: 'pulls' });
        await store.ensurePulls();
        const data = store.getState().pulls.data, pull = data?.open[0] ?? data?.merged[0];
        if (pull) await store.revealPulls(pull.id);
      },
      text: ({ state }) => {
        const data = state.pulls.data, pull = data?.open[0] ?? data?.merged[0];
        if (!pull) return 'No pull requests in this window. Branches not merged yet show here, and with `--pr-metadata github` the pull requests open on GitHub.';
        return `**${pull.title}** ${pull.state === 'merged' ? 'was merged' : 'is open'}${pull.files ? `, changing ${plural(pull.files, 'file')}` : ''}: its files light up, with its commits, people and blast radius.`;
      },
    },
  },
];
const AGENTS: Stop = {
  key: 'agents', title: 'Agents', target: 'agents',
  invite: () => 'Coding agents can work on the map. Click **Agents**.',
  done: ({ state }) => state.journal.open.includes('conversations'),
  show: {
    run: store => store.showAgents(),
    text: ({ state }) => {
      const sessions = state.agents.snapshot?.sessions.length ?? 0;
      const lead = sessions ? `${plural(sessions, 'session')} so far: each shows as a colored square on the map, at the files it reads and edits.` : 'No agent is connected yet. `npx codiluce harness list` names the agents Codiluce connects to, and `npx codiluce harness setup --agent NAME --apply` connects one: its sessions then show here and on the map, at the files it reads and edits.';
      return `${lead} Saved sessions replay on the map, step by step.`;
    },
  },
};
const EXPLAIN: Stop = {
  key: 'explain', title: 'Explain', target: 'explain',
  invite: () => 'Questions about the code get answers with links that light it. Click **Explain**.',
  done: ({ state }) => state.explain.open,
  show: {
    run: store => store.openExplanations(),
    text: ({ state }) => {
      const saved = state.explain.list.data?.items.length ?? 0;
      return `Ask here, or ask your agent through Codiluce's MCP server: answers are saved in this column (${saved ? `${plural(saved, 'explanation')} so far` : 'none yet'}), some as tours, scene by scene on the map. Pointing at a link lights its code.`;
    },
  },
};
const FEATURES: Stop = {
  key: 'features', title: 'Features', target: 'features',
  invite: () => 'Click **Features** for what the product does.',
  done: ({ state }) => leftOpen(state, 'features'),
  show: {
    run: async store => {
      await store.ensureFeatures();
      store.setPanels({ left: true, tab: 'features' });
      const feature = store.getState().features.data?.features[0];
      if (feature) await store.revealFeature(feature.key);
    },
    text: ({ state }) => { const feature = state.features.data?.features[0]; return `${feature ? `**${feature.name}** lights up: ${plural(feature.files, 'file')}, with the flows that start in it.` : 'Selecting a feature lights its files, with the flows that start in it.'} A folder's Inspector says which features it serves.`; },
  },
  missing: ({ thread }) => thread.available.features ? undefined : 'Features come from describing the code with a language model. `npx codiluce annotate --estimate` says what it would cost, and `npx codiluce annotate` runs it; the Features panel then lists what the product does.',
};
const lensText: Partial<Record<ColorMode, string>> = {
  complexity: '**Complexity**: the stronger a file\'s color, the more complex its code.',
  hotspots: '**Hotspots**: complex files that also change often, where bugs and slow work collect.',
  coverage: '**Flow coverage**: which files flows touch, from entry points to code no flow reaches.',
};
const COLOR: Stop[] = [
  {
    key: 'color', title: 'Color by', target: 'color',
    invite: () => 'The map can be colored by more than what each block is. Click **Color** to choose.',
    done: ({ state, start }) => colorOf(state) !== colorOf(start),
    show: { run: store => store.colorBy('complexity'), text: () => lensText.complexity! },
  },
  {
    key: 'color-more', title: 'Color by', target: 'color',
    prepare: (store, thread) => store.colorBy(thread.available.history ? 'hotspots' : 'coverage'),
    invite: ({ thread }) => `${lensText[thread.available.history ? 'hotspots' : 'coverage']} **Type** gives the theme's colors back.`,
  },
];
/** What colors the map (the store's `colorMode`, read from a state). */
function colorOf(state: AtlasState): ColorMode { return state.coverage.show ? 'coverage' : state.families.show ? 'families' : state.people.show ? 'people' : state.lens.show ?? 'type'; }
const SETTINGS: Stop = {
  key: 'settings', title: 'Settings', target: 'settings',
  invite: () => 'Click **⚙** for themes and how the map is drawn.',
  done: ({ state }) => state.panels.settings,
  show: { run: store => store.setPanels({ settings: true }), text: () => 'Themes (Dusk and Dawn first, more below), the 2D plan or the isometric map, building shapes, and how soon folders open. Your choices are kept in this browser.' },
};

const peopleMissing = (thread: OnboardingResult) => `Who changed which code comes from the Git history. ${sentence(thread.available.peopleReason ?? 'There is none here')}`;
/** The stops of a tour. The People & PRs chapter without Git history is one card saying why. */
export function stopsOf(tour: TourKey, thread: OnboardingResult): Stop[] {
  switch (tour) {
    case 'core': return [MAP, SEARCH, CODE, FLOWS, IMPACT, HISTORY];
    case 'people': return thread.available.people ? PEOPLE : [{ key: 'people', title: 'People & PRs', target: 'people', invite: () => '', missing: () => peopleMissing(thread) }];
    case 'agents': return [AGENTS];
    case 'explain': return [EXPLAIN];
    case 'features': return [FEATURES];
    case 'color': return COLOR;
    case 'settings': return [SETTINGS];
  }
}
/** A chapter that has nothing to show here (the closing card offers how to turn it on instead). */
export function chapterMissing(key: ChapterKey, thread: OnboardingResult): string | undefined {
  if (key === 'people' && !thread.available.people) return peopleMissing(thread);
  if (key === 'features' && !thread.available.features) return FEATURES.missing!({ thread } as StopContext);
  return undefined;
}
