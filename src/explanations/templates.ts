// Explain templates: the questions people ask most about a codebase, with
// [placeholders] to fill. The composer in the Explanations column offers them
// (Templates, or / in an empty question), the inspector's ⋯ fills their code
// placeholder with the selection, and agents get them as MCP prompts (one
// argument per placeholder). Pure, shared with the browser.
// No runtime imports: the browser bundle reads this file directly (like links.ts).

export type TemplateGroup = 'understand' | 'dependencies' | 'change' | 'risks';
export const TEMPLATE_GROUPS: { id: TemplateGroup; title: string; description: string }[] = [
  { id: 'understand', title: 'Understand', description: 'What the code does, and where things happen' },
  { id: 'dependencies', title: 'Dependencies', description: 'How the parts depend on each other and on packages' },
  { id: 'change', title: 'Change', description: 'Before you change something' },
  { id: 'risks', title: 'Risks', description: 'Security, bugs, dead code and slow paths' },
];
/** What the inspector has selected, for the templates it offers there. */
export type SelectionKind = 'file' | 'folder' | 'symbol' | 'flow' | 'table';

export interface ExplainTemplate {
  id: string;
  group: TemplateGroup;
  title: string;
  /** One line in the menu: what the answer covers. */
  description: string;
  /** The question, with [placeholders] to fill: `[feature, e.g. password reset]`. */
  text: string;
  /** The placeholder that names code (its text, without brackets): the selection fills it. */
  code?: string;
  /** Offered in the inspector's ⋯ for these selections, worded for one. */
  selection?: { on: SelectionKind[]; text: string };
  /** How an agent starts: the tools that answer it. */
  tools: string;
  /** About the whole codebase (saved with the overview subject). */
  overview?: boolean;
}

export const TEMPLATES: ExplainTemplate[] = [
  {
    id: 'codebase', group: 'understand', title: 'The codebase', overview: true,
    description: 'What it does, how its parts fit, and where to start reading',
    text: 'Explain this codebase as a whole: what the product does, its applications and how they talk to each other, its main flows and features, and where a newcomer should start reading.',
    tools: 'Start with `overview`, then `flows`, `entity` and `source` for the parts that matter.',
  },
  {
    id: 'onboarding', group: 'understand', title: 'Get started on an area',
    description: 'What to read first before working on one part of the product',
    text: 'I am going to work on [area, e.g. billing]. Which parts of the code should I read first, in what order, and what should I know about how they fit with the rest?',
    tools: 'Find the area with `search` and `flows`, then use `entity` and `relations` for what surrounds it.',
  },
  {
    id: 'path', group: 'understand', title: 'A file or folder', code: 'file or folder',
    description: 'Its role, what uses it and what it uses',
    text: 'Explain [file or folder]: what it is responsible for, what uses it and what it uses, the flows it is part of, and anything surprising in it.',
    tools: 'Start with `entity` on it, then `relations`, `flows` and `source` as needed.',
  },
  {
    id: 'feature', group: 'understand', title: 'How a feature works',
    description: 'A feature end to end, from what triggers it to the data it touches',
    text: 'How does [feature, e.g. password reset] work, end to end? Start where a user or a system triggers it, follow each step through the code, and say which data it reads and writes.',
    tools: 'Find it with `search` and `flows`, then follow it with `flow` and `source`.',
  },
  {
    id: 'where', group: 'understand', title: 'Where something happens',
    description: 'Every place that does it, and which one to change',
    text: 'Where in the code does [behavior, e.g. the invoice email get sent] happen? List every place that does it, the entry points that reach each one, and which one I would change.',
    tools: 'Use `search`, then `relations` and `flows` to see what reaches each place.',
  },
  {
    id: 'data', group: 'understand', title: 'A table or model', code: 'table or model',
    description: 'What it stores, which code writes it and which reads it',
    selection: { on: ['table'], text: 'Who writes and reads it?' },
    text: 'Explain [table or model]: what it stores, which code writes it and which code reads it, and the rules that keep its data consistent.',
    tools: 'Start with `entity` on it, then `relations` (reads and writes) and `source`.',
  },
  {
    id: 'dependencies', group: 'dependencies', title: 'Dependencies of a part', code: 'file or folder',
    description: 'What it depends on, what depends on it, and cycles',
    selection: { on: ['file', 'folder'], text: 'What does it depend on?' },
    text: 'What does [file or folder] depend on, and what depends on it? Separate our own code from third-party packages, and point out cycles and dependencies that go the wrong way.',
    tools: 'Use `relations` in both directions and `impact` on it, and `source` for its imports.',
  },
  {
    id: 'packages', group: 'dependencies', title: 'Third-party packages',
    description: 'Which packages the code relies on, what for, and where',
    text: 'Which third-party packages does this codebase rely on most, what for, and where are they used? Point out any that look unused, duplicated or hard to replace.',
    tools: 'Find the package manifests, such as package.json, composer.json or requirements.txt, with `search` and read them with `source`, then `search` for the code that uses each package.',
  },
  {
    id: 'architecture', group: 'dependencies', title: 'Architecture and boundaries', overview: true,
    description: 'Its layers or modules, and where code crosses them',
    text: 'Describe the architecture of this codebase: its layers or modules, which way the dependencies between them should go, and the places where code crosses a boundary it should not.',
    tools: 'Start with `overview`, then `relations` and `impact` between the main folders.',
  },
  {
    id: 'connection', group: 'dependencies', title: 'How two parts connect',
    description: 'The calls, requests and tables between two parts',
    text: 'How is [first part] connected to [second part]? Show the paths between them (calls, HTTP requests, shared tables), and say which ones matter.',
    tools: 'Use `relations` and `flows` on both, and `impact` on one to see whether it reaches the other.',
  },
  {
    id: 'impact', group: 'change', title: 'What would break', code: 'file, folder or symbol',
    description: 'What depends on it, and which risks are real',
    text: 'What would break if I changed [file, folder or symbol]? Tell real risks from incidental links, and say what the index cannot see (dynamic calls, configuration, other repositories).',
    tools: 'Start with `impact` on it, then `entity` and `source`.',
  },
  {
    id: 'change', group: 'change', title: 'Plan a change',
    description: 'Which files to touch, in what order, and what could break',
    text: 'I want to [change, e.g. add a discount code to checkout]. Which files would I touch, in what order, what could break, and which tests cover that code today?',
    tools: 'Find the code with `search` and `flows`, then use `impact` on what you would touch.',
  },
  {
    id: 'history', group: 'change', title: 'Recent changes', code: 'file or folder',
    description: 'What changed in a part lately, and why',
    selection: { on: ['file', 'folder'], text: 'What changed recently, and why?' },
    text: 'What changed in [file or folder] recently, and why? Group the commits by intent, and point out anything that looks risky or unfinished.',
    tools: 'Use `history` on it, then `commit` for the commits that matter.',
  },
  {
    id: 'tests', group: 'change', title: 'Tests', code: 'file or folder',
    description: 'What covers it, and which tests to write first',
    selection: { on: ['file', 'folder', 'symbol'], text: 'How well is it tested?' },
    text: 'How well is [file or folder] tested? Which tests cover it, which of its paths have none, and which tests should be written first?',
    tools: 'Use `relations` and `search` to find the tests that reach it, and `source` to read them.',
  },
  {
    id: 'security', group: 'risks', title: 'Security review', code: 'file, folder or flow',
    description: 'Unchecked input, missing permission checks, secrets, by severity',
    selection: { on: ['file', 'folder', 'flow'], text: 'Review it for security issues' },
    text: 'Review [file, folder or flow] for security issues: input that reaches queries, commands, files or HTML without validation, missing authentication or permission checks, secrets in the code, and unsafe defaults. Rank what you find by severity, with the lines involved.',
    tools: 'Start with `entity` or `flow` on it, follow user input with `relations`, and read the code with `source`.',
  },
  {
    id: 'bugs', group: 'risks', title: 'Possible bugs', code: 'file or folder',
    description: 'Likely mistakes, how they would show up, and how sure',
    selection: { on: ['file', 'folder', 'symbol'], text: 'Look for bugs in it' },
    text: 'Look for likely bugs in [file or folder]: unhandled errors, missing or empty values, race conditions, off-by-one mistakes, and callers that assume something the code does not do. For each, say how it would show up and how sure you are.',
    tools: 'Read it with `source`, and check its callers with `relations`.',
  },
  {
    id: 'debug', group: 'risks', title: 'Track down a bug',
    description: 'From a symptom to the code that could cause it',
    text: 'Something goes wrong: [symptom, e.g. the order total is wrong after a refund]. Where in the code could it come from? Follow the flows involved, and list the suspects, most likely first, with what to check for each.',
    tools: 'Find the flows involved with `search` and `flows`, follow them with `flow`, and read the suspects with `source`.',
  },
  {
    id: 'unused', group: 'risks', title: 'Unused code', code: 'folder',
    description: 'What nothing reaches, and whether it is safe to delete',
    selection: { on: ['folder'], text: 'What in it is never reached?' },
    text: 'Which code in [folder] is never reached? Tell dead code from code used dynamically (by name, configuration or a framework), and say what is safe to delete.',
    tools: 'Use `entity`, `flows` and `relations` on what it holds, and `search` for dynamic uses.',
  },
  {
    id: 'performance', group: 'risks', title: 'Performance', code: 'flow or feature',
    description: 'Where it could be slow, and why',
    selection: { on: ['flow'], text: 'Where could it be slow?' },
    text: 'Where could [flow or feature] be slow? Look for queries in loops, work repeated on every request, large payloads, and missing indexes or caches.',
    tools: 'Follow it with `flow`, and read the steps that do the most work with `source`.',
  },
];

export function templateById(id: string | undefined): ExplainTemplate | undefined { return id ? TEMPLATES.find(template => template.id === id) : undefined; }

export interface Placeholder {
  /** Its text, without the brackets. */
  text: string;
  /** Where it is, brackets included. */
  start: number;
  end: number;
}
// [text] that is not a Markdown link's text ([text](href)).
const PLACEHOLDER = /\[([^[\]\n]{1,80})\](?!\()/g;
/** The placeholders left in a text; with a template, only its own (other brackets are the writer's). */
export function placeholdersIn(text: string, template?: ExplainTemplate): Placeholder[] {
  const own = template ? new Set(placeholdersIn(template.text).map(item => item.text)) : undefined;
  return [...text.matchAll(PLACEHOLDER)].filter(match => !own || own.has(match[1]!)).map(match => ({ text: match[1]!, start: match.index, end: match.index + match[0].length }));
}
/** A placeholder's argument name in an MCP prompt: `path` for the code one, else its first words ("feature", "first_part"). */
export function argumentName(template: ExplainTemplate, placeholder: string): string {
  return placeholder === template.code ? 'path' : placeholder.split(',')[0]!.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
/** Its placeholders as MCP prompt arguments, each once. */
export function templateArguments(template: ExplainTemplate): { name: string; description: string }[] {
  const seen = new Set<string>();
  return placeholdersIn(template.text).flatMap(({ text }) => {
    const name = argumentName(template, text);
    if (seen.has(name)) return [];
    seen.add(name);
    const description = text !== template.code ? `${text[0]!.toUpperCase()}${text.slice(1)}`
      : /flow/.test(text) ? 'A repository-relative path, or a flow as Codiluce lists it ("POST /api/orders")' : 'A repository-relative path (path#Symbol for a symbol)';
    return [{ name, description }];
  });
}
/** The question with its placeholders replaced by the values given (by argument name); the others stay. */
export function fillTemplate(template: ExplainTemplate, values: Record<string, string | undefined>): string {
  return template.text.replace(PLACEHOLDER, (whole, text: string) => values[argumentName(template, text)]?.trim() || whole);
}
