// What to ask about a part of the code: the prompt to paste into an agent
// connected to Codiluce over MCP ("Copy prompt"), the shorter question the
// chat in the map starts from, and the same prompts as MCP prompts (slash
// commands in clients such as Claude Code). Pure, shared with the browser.
// No runtime imports: the browser bundle reads this file directly (like links.ts).
import type { ExplainTemplate } from './templates.js';
/** A flow link, as links.ts writes it. */
function flowHref(name: string): string { return `flow:${encodeURIComponent(name).replace(/%2F/gi, '/').replace(/%3A/gi, ':')}`; }

export type PromptKind = 'overview' | 'flow' | 'commit' | 'pr' | 'entity' | 'impact' | 'coverage' | 'refresh' | 'template';
export interface PromptTarget {
  kind: PromptKind;
  /** The link of what it is about: flow:<name>, a SHA, a PR number, a path. */
  ref?: string;
  /** How to name it in the text (a flow title, a commit subject, a file name). */
  label?: string;
  /** Entity type (file, directory, class…), for wording. */
  type?: string;
  /** refresh: the explanation to update. */
  id?: string;
  /** template: the question asked (`ref` fills its code placeholder). */
  template?: ExplainTemplate;
}
const LINKING = 'Link every file, folder, symbol, flow and commit you mention, copying the `link` values the tools return, so each lights up on the Codiluce map.';

export function agentPrompt(target: PromptTarget, options: { setup?: string } = {}): string {
  const ref = readable(target.ref ?? '');
  const name = target.label && target.label !== ref ? `${target.label} (${ref})` : ref;
  const what = target.type ? typeWord(target.type) : 'code';
  const lines: string[] = [];
  switch (target.kind) {
    case 'overview':
      lines.push('Explain this codebase as a whole, using the Codiluce MCP tools: what the product does, its applications and how they talk to each other, its main flows and features, and where a newcomer should start reading.',
        'Start with `overview`, then use `flows`, `entity` and `source` for the parts that matter.', 'Publish the result with `publish_explanation` (subject kind "overview").');
      break;
    case 'flow':
      lines.push(`Explain the flow ${name} step by step, using the Codiluce MCP tools: who starts it, what each step does, what data it reads and writes, which conditions change its path, and where it can fail.`,
        `Start with \`flow\` (flow: "${ref}"), read \`source\` where a step needs it, and use \`impact\` if a step is shared with other flows.`, `Publish the result with \`publish_explanation\` (subject: kind "flow", ref "${ref}").`);
      break;
    case 'commit':
      lines.push(`Explain commit ${name} using the Codiluce MCP tools: what changed in architectural terms, why (from the message and the code), and what the change affects.`,
        `Start with \`commit\` (commit: "${ref}"), then \`entity\` and \`impact\` for the main changed entities.`, `Publish the result with \`publish_explanation\` (subject: kind "commit", ref "${ref}").`);
      break;
    case 'pr':
      lines.push(`Explain pull request #${ref}${target.label ? ` (${target.label})` : ''} using the Codiluce MCP tools: what it changes, in the order a reviewer should read it, why, and what it affects.`,
        `Start with \`commit\` (commit: "pr:${ref}"), then \`entity\` and \`impact\` for the main changed entities.`, `Publish the result with \`publish_explanation\` (subject: kind "pr", ref "${ref}").`);
      break;
    case 'entity':
      lines.push(`Explain the ${what} ${name} using the Codiluce MCP tools: its role, what uses it and what it uses, the flows it is part of, and anything surprising.`,
        `Start with \`entity\` (link: "${ref}"), then \`relations\`, \`flows\` and \`source\` as needed.`, `Publish the result with \`publish_explanation\` (subject: kind "entity", ref "${ref}").`);
      break;
    case 'impact':
      lines.push(`What would break if I changed the ${what} ${name}? Use the Codiluce MCP tools: \`impact\` (link: "${ref}") for what depends on it, \`entity\` and \`source\` to tell real risks from incidental links, and say what the index cannot see.`,
        `Publish the result with \`publish_explanation\` (subject: kind "entity", ref "${ref}").`);
      break;
    case 'coverage':
      lines.push(`No indexed flow reaches the ${what} ${name}. Using the Codiluce MCP tools (\`entity\`, \`relations\`, \`source\`, \`search\`), find out whether it is dead code, used dynamically (by name, configuration or a framework), or reached in a way the index cannot see.`,
        `Publish the result with \`publish_explanation\` (subject: kind "entity", ref "${ref}").`);
      break;
    case 'refresh':
      lines.push(`The Codiluce explanation "${target.label ?? target.id}" (id ${target.id}) is out of date: code it links changed since it was written.`,
        `Read it with \`read_explanation\` (id "${target.id}"), check what changed with \`entity\`, \`commit\` and \`source\`, then rewrite it with \`update_explanation\` (id "${target.id}", mode "replace").`);
      break;
    case 'template': {
      const template = target.template!;
      const subject = template.overview ? 'subject kind "overview"' : ref ? `subject: kind "${ref.startsWith('flow:') ? 'flow' : 'entity'}", ref "${ref}"` : 'subject kind "question"';
      lines.push(template.code && ref ? template.text.replace(`[${template.code}]`, target.type ? `the ${what} ${name}` : name) : template.text,
        `Use the Codiluce MCP tools to answer. ${template.tools}`, `Publish the result with \`publish_explanation\` (${subject}).`);
      break;
    }
  }
  lines.push(LINKING);
  if (options.setup) lines.push(`(If the Codiluce tools are not connected yet, add them first: ${options.setup})`);
  return lines.join('\n');
}

/** The question the chat in the map starts from (links become context). */
export function chatQuestion(target: PromptTarget, options: { plain?: boolean } = {}): string {
  const ref = target.ref ?? '';
  const name = target.label ?? readable(ref).replace(/^flow:/, '');
  // Plain: the composer attaches the code as context instead of linking it in the text.
  const link = (text: string, href: string) => options.plain ? text : `[${text.replace(/[[\]]/g, '')}](${href})`;
  switch (target.kind) {
    case 'overview': return 'Explain this codebase: what it does, how its parts fit together, its main flows, and where to start reading.';
    case 'flow': return `Explain the flow ${link(name, flowHref(readable(ref).replace(/^flow:/, '')))} step by step: who starts it, what each step does, what data it touches, and where it can fail.`;
    case 'commit': return `Explain commit ${link(target.label ?? ref.slice(0, 10), `commit:${ref}`)}: what changed, why, and what it affects.`;
    case 'pr': return `Explain pull request ${link(`#${ref}`, `pr:${ref}`)}: what it changes, in reading order, why, and what it affects.`;
    case 'entity': return `Explain ${link(name, ref)}: its role, what uses it and what it uses, and the flows it is part of.`;
    case 'impact': return `What would break if I changed ${link(name, ref)}?`;
    case 'coverage': return `No flow reaches ${link(name, ref)}. Is it dead code, used dynamically, or reached in a way the index cannot see?`;
    case 'refresh': return 'The code this explanation links changed since it was written. Check what changed and rewrite the explanation so it is correct again.';
    case 'template': { const template = target.template!; return template.code && ref ? template.text.replace(`[${template.code}]`, link(name, ref)) : template.text; }
  }
}
/** A link as a person reads it (`flow:POST /api/orders`, not `flow:POST%20/api/orders`). */
function readable(ref: string): string { try { return decodeURIComponent(ref); } catch { return ref; } }
function typeWord(type: string): string {
  return ({ directory: 'folder', application: 'application', file: 'file', api_endpoint: 'endpoint', database_table: 'table', scheduled_task: 'scheduled task', component: 'component', class: 'class', function: 'function', method: 'method', controller: 'controller', model: 'model', route: 'page', command: 'command', repository: 'repository' } as Record<string, string>)[type] ?? 'code';
}

/** The MCP prompts: one per kind, with the argument it needs. */
export const MCP_PROMPTS: { name: string; title: string; description: string; argument?: { name: string; description: string }; target(value: string | undefined): PromptTarget }[] = [
  { name: 'explain-codebase', title: 'Explain the codebase', description: 'An overview of the repository, saved as a Codiluce explanation', target: () => ({ kind: 'overview' }) },
  { name: 'explain-flow', title: 'Explain a flow', description: 'A flow step by step (a page, request, command or scheduled task)', argument: { name: 'flow', description: 'The flow, as Codiluce lists it: "POST /api/orders", "/cart", "app:sync"' }, target: value => ({ kind: 'flow', ref: value?.startsWith('flow:') ? value : `flow:${value ?? ''}` }) },
  { name: 'explain-commit', title: 'Explain a commit', description: 'What a commit changed and why', argument: { name: 'commit', description: 'A commit SHA' }, target: value => ({ kind: 'commit', ref: value ?? 'HEAD' }) },
  { name: 'explain-pr', title: 'Explain a pull request', description: 'What a merged pull request changed, in reading order', argument: { name: 'number', description: 'The pull request number' }, target: value => ({ kind: 'pr', ref: (value ?? '').replace(/^#/, '') }) },
  { name: 'explain-path', title: 'Explain a file or folder', description: 'The role of a file, folder or symbol', argument: { name: 'path', description: 'A repository-relative path (path#Symbol for a symbol)' }, target: value => ({ kind: 'entity', ref: value ?? '' }) },
  { name: 'explain-impact', title: 'What would break', description: 'What depends on a file, folder or symbol', argument: { name: 'path', description: 'A repository-relative path (path#Symbol for a symbol)' }, target: value => ({ kind: 'impact', ref: value ?? '' }) },
];
