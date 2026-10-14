import type { StepLink, StepsResult } from '@engine/projection/dto';

export interface PageStepChoice {
  id: string;
  head: string;
  label: string;
  link: StepLink;
}
export interface PageStepGroup { id: string; label: string; choices: PageStepChoice[] }

/** A page offers alternative controls, rather than executing every handler
 * when it opens. Preserve the component binding each control as its group. */
export function pageStepGroups(data: StepsResult): { initialization: PageStepGroup[]; interactions: PageStepGroup[] } {
  const byId = new Map(data.steps.map(step => [step.id, step]));
  const initialization = new Map<string, PageStepGroup>();
  const interactions = new Map<string, PageStepGroup>();
  for (const link of data.links) {
    if (!link.event && link.from !== data.anchor.id) continue;
    const target = byId.get(link.to), source = byId.get(link.from);
    if (!target) continue;
    const component = [...link.via].reverse().find(item => item.type === 'component');
    const owner = !link.event && target.node?.type === 'component' ? target.node : component ?? (source?.node?.type === 'component' ? source.node : undefined);
    const label = owner?.name ?? target.effect?.ownerName ?? target.node?.path?.split('/').at(-1) ?? data.anchor.name;
    const groupId = owner?.id ?? target.effect?.owner ?? target.node?.path ?? data.anchor.id;
    const groups = link.event ? interactions : initialization;
    const group = groups.get(groupId) ?? { id: groupId, label, choices: [] };
    const choiceId = `${groupId}:${link.to}:${link.event ?? 'initialization'}`;
    if (!group.choices.some(choice => choice.id === choiceId)) group.choices.push({ id: choiceId, head: link.to, label: target.node?.name ?? `${target.effect?.category} · ${target.effect?.operation}`, link });
    groups.set(groupId, group);
  }
  return { initialization: [...initialization.values()], interactions: [...interactions.values()] };
}

/** The real path to one choice and what it leads to. Other event bindings
 * remain separate choices, even when their component has effects of its own. */
export function pageStepBranch(data: StepsResult, choice: PageStepChoice, showEffects: boolean): StepsResult {
  const outgoing = new Map<string, StepLink[]>();
  for (const link of data.links) outgoing.set(link.from, [...outgoing.get(link.from) ?? [], link]);
  const pathTo = (target: string, events: boolean): StepLink[] | undefined => {
    const previous = new Map<string, StepLink | undefined>([[data.anchor.id, undefined]]);
    const queue = [data.anchor.id];
    for (let i = 0; i < queue.length && !previous.has(target); i++) {
      for (const link of outgoing.get(queue[i]!) ?? []) {
        if ((!events && link.event) || previous.has(link.to)) continue;
        previous.set(link.to, link); queue.push(link.to);
      }
    }
    if (!previous.has(target)) return undefined;
    const path: StepLink[] = [];
    for (let link = previous.get(target); link; link = previous.get(link.from)) path.unshift(link);
    return path;
  };
  const prefix = pathTo(choice.link.from, false) ?? pathTo(choice.link.from, true) ?? [];
  const links = new Map([...prefix, choice.link].map(link => [link.id, link]));
  const members = new Set([data.anchor.id, ...prefix.flatMap(link => [link.from, link.to]), choice.head]);
  const queue = [choice.head];
  for (let i = 0; i < queue.length; i++) {
    for (const link of outgoing.get(queue[i]!) ?? []) {
      if (link.event) continue;
      links.set(link.id, link);
      if (!members.has(link.to)) { members.add(link.to); queue.push(link.to); }
    }
  }
  const steps = data.steps.filter(step => members.has(step.id) && (showEffects || !step.effect || step.id === choice.head));
  const visible = new Set(steps.map(step => step.id));
  const shownLinks = [...links.values()].filter(link => visible.has(link.from) && visible.has(link.to));
  const layers = new Map([[data.anchor.id, 0]]);
  const ordered = [data.anchor.id];
  for (let i = 0; i < ordered.length; i++) for (const link of shownLinks) if (link.from === ordered[i] && !layers.has(link.to)) {
    layers.set(link.to, layers.get(link.from)! + 1); ordered.push(link.to);
  }
  return { ...data, steps: steps.map(step => ({ ...step, layer: layers.get(step.id) ?? 1 })), links: shownLinks.map(link => ({ ...link, back: (layers.get(link.to) ?? 1) <= (layers.get(link.from) ?? 0) })), notices: [] };
}
