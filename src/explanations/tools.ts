// The tools a language model explains code with: what the index knows
// (search, an entity and its relationships, flows, impact, history, source)
// and saving what it wrote as an explanation. One registry serves the MCP
// server (an agent such as Claude Code or Codex) and the chat in the map.
// Every result names code by the link an explanation should use.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { HistoryService } from '../history/service.js';
import type { ProjectionNode } from '../projection/hierarchy.js';
import type { LinkContext, ProjectionService } from '../projection/service.js';
import type { NodeSummary, ViewKey } from '../projection/dto.js';
import { LINK_GUIDE, parseLink, schemeHref } from './links.js';
import { latestAnswer, type ExplanationDetail, type ResolvedLink, type SubjectKind } from './model.js';
import { hrefOf, resolveLink } from './resolve.js';
import { UnresolvedLinksError, type ExplanationService } from './service.js';
import type { ActivityWriter } from './activity.js';

const execute = promisify(execFile);
export type JsonSchema = Record<string, unknown>;
export interface ToolSpec {
  name: string; title: string; description: string; inputSchema: JsonSchema;
  /** Only reads (the MCP `readOnlyHint`); the chat never gets the others. */
  readOnly: boolean;
  run(input: Record<string, unknown>): Promise<string>;
}
export interface ToolContext {
  service: ExplanationService; projection: ProjectionService; history?: HistoryService;
  root?: string; maxFileBytes: number;
  /** The address of a running map (`serve`), for links to an explanation. */
  serverUrl?: () => string | undefined;
  /** Who publishes through these tools (the MCP client's name). */
  agent?: () => string | undefined;
  /** What the agent is doing, shown on the map while it works (the MCP server's session file). */
  activity?: Pick<ActivityWriter, 'begin' | 'published' | 'work'>;
}
export class ToolInputError extends Error {}

const LIVE: ViewKey = {};
const SOURCE_LINES = 400;
const string = (description: string) => ({ type: 'string', description });
const integer = (description: string, minimum: number, maximum: number) => ({ type: 'integer', description, minimum, maximum });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const LINK_INPUT = string('What to look at: a repository-relative path (file or folder/), path#Symbol, path#L10-L20, flow:<entry>, table:<name>, or a link a tool returned');
const SUBJECTS: SubjectKind[] = ['overview', 'flow', 'commit', 'pr', 'entity', 'question'];

/** The read-only tools over the index. */
export function codeTools(context: ToolContext): ToolSpec[] {
  const { projection, service } = context;
  const links = () => projection.linkContext(LIVE);
  const environment = () => service.environment();
  const brief = (node: ProjectionNode | NodeSummary, ctx = links()): Record<string, unknown> => {
    const indexed = ctx.index.node(node.id);
    const range = node.sourceRange;
    return { type: node.type, name: node.name, link: indexed ? hrefOf(indexed, ctx) : undefined, ...(node.path && node.type !== 'file' && !['directory', 'application'].includes(node.type) ? { file: node.path } : {}), ...(range ? { lines: `${range.startLine}-${range.endLine}` } : {}) };
  };
  /** The entity a link (or an ID) names, or a clear error. */
  const target = async (value: unknown): Promise<{ node: ProjectionNode; link?: ResolvedLink; ctx: LinkContext }> => {
    const text = requireText(value, 'link');
    const env = await environment();
    const ctx = env.context;
    const direct = ctx.index.node(text);
    if (direct) return { node: direct, ctx };
    const parsed = parseLink(text);
    if (!parsed || parsed.kind === 'external') throw new ToolInputError(`${text} is not a path, flow:, table: or entity link`);
    const link = resolveLink(parsed, env);
    if (link.status === 'missing' || !link.id) throw new ToolInputError(`${text}: ${link.reason ?? 'not found'}${parsed.kind === 'path' ? '. Use search to find the right path.' : ''}`);
    return { node: ctx.index.node(link.id)!, link, ctx };
  };
  return [
    {
      name: 'overview', title: 'Repository overview', readOnly: true,
      description: `Start here. The repository's applications (with their frameworks), its size, the flows by kind, its features and the model-written overview when \`annotate\` ran, and the link syntax explanations use.\n\n${LINK_GUIDE}`,
      inputSchema: object({}),
      async run() {
        const meta = projection.meta(LIVE);
        const ctx = links();
        const root = ctx.index.node(ctx.index.rootId)!;
        const applications = [...ctx.index.nodes.values()].filter(node => node.type === 'application').map(node => {
          const entity = projection.entity(node.id, LIVE);
          return { name: node.name, link: hrefOf(node, ctx), frameworks: entity?.metadata.frameworks, files: node.stats.files };
        });
        const flowCounts: Record<string, number> = {};
        for (const flow of ctx.flows.filter(flow => (flow.summary.scope ?? 'application') === 'application')) flowCounts[flow.summary.kind] = (flowCounts[flow.summary.kind] ?? 0) + 1;
        const notes = projection.annotationsOverview();
        const features = notes.available ? projection.features(LIVE).features.map(item => ({ name: item.name, link: schemeHref('feature', item.key), files: item.files, summary: item.summary })) : [];
        return json({
          repository: meta.run.repositoryName, commit: meta.run.commitSha, uncommittedChanges: meta.run.dirty ?? false, indexedAt: meta.run.analyzedAt,
          files: root.stats.files, symbols: root.stats.symbols, endpoints: root.stats.endpoints, measuredLines: root.stats.measuredLoc,
          applications, flows: flowCounts,
          ...(notes.overview ? { modelOverview: notes.overview } : {}), ...(features.length ? { features } : {}),
          explanations: (await service.list()).items.length, linkSyntax: LINK_GUIDE,
        });
      },
    },
    {
      name: 'search', title: 'Search the index', readOnly: true,
      description: 'Find files, folders, symbols, routes, endpoints, tables, commands and tasks by name or path (every word must match). Returns their links.',
      inputSchema: object({ query: string('Words of a name or path, e.g. "checkout controller"'), type: string('Only this entity type: file, directory, class, function, method, component, route, api_endpoint, controller, model, database_table, command, scheduled_task'), limit: integer('At most this many (default 20)', 1, 100) }, ['query']),
      async run(input) {
        const page = projection.search(requireText(input.query, 'query'), { type: optionalText(input.type), limit: optionalNumber(input.limit) ?? 20, view: LIVE });
        const ctx = links();
        return json({ total: page.total, types: page.typeCounts.slice(0, 12), items: page.items.map(item => ({ ...brief(item, ctx), in: item.breadcrumb })) });
      },
    },
    {
      name: 'entity', title: 'What the index knows about one entity', readOnly: true,
      description: 'One file, folder, symbol, entry point or table: its description (when annotated), feature, symbols or contents, the flows through it, a sample of its relationships, what it does outside the indexed code (effects), who changed it, and the explanations that link it.',
      inputSchema: object({ link: LINK_INPUT }, ['link']),
      async run(input) {
        const { node, link, ctx } = await target(input.link);
        const entity = projection.entity(node.id, LIVE);
        const container = ['repository', 'application', 'directory', 'group'].includes(node.type);
        const annotation = safe(() => projection.entityAnnotation(node.id, LIVE));
        const coverage = safe(() => projection.coverageOf(node.id, LIVE));
        const relations = container ? undefined : safe(() => projection.relations(node.id, { limit: 40, scope: node.type === 'file' ? 'contained' : undefined, view: LIVE }));
        const aggregate = container ? safe(() => projection.aggregate(node.id, { view: LIVE })) : undefined;
        const authorship = await projection.entityAuthorship(node.id, LIVE, { window: 'all' }).catch(() => undefined);
        const children = node.children.map(id => ctx.index.node(id)).filter((child): child is ProjectionNode => !!child);
        const effects = Array.isArray(entity?.metadata.effects) ? (entity!.metadata.effects as { category: string; operation: string; detail: string; line: number; status?: number; tableName?: string }[]).slice(0, 30).map(effect => `${effect.category} ${effect.operation}${effect.tableName ? ` ${effect.tableName}` : ''}${effect.status ? ` ${effect.status}` : ''}: ${effect.detail} (line ${effect.line})`) : undefined;
        const explained = await service.forEntity(node.id);
        return json({
          ...brief(node, ctx), ...(link?.reason ? { note: link.reason } : {}), ...(node.qualifiedName ? { qualifiedName: node.qualifiedName } : {}),
          ...(annotation?.summary ? { description: annotation.summary, descriptionBy: annotation.model, ...(annotation.outdated ? { descriptionOutdated: true } : {}) } : {}),
          ...(annotation?.role ? { role: annotation.role } : {}), ...(annotation?.domain ? { feature: { name: annotation.domain.name, link: schemeHref('feature', annotation.domain.key) } } : {}),
          ...(entity?.metadata.signature ? { signature: entity.metadata.signature } : {}),
          ...(children.length ? { [node.type === 'file' ? 'symbols' : 'contains']: children.slice(0, 60).map(child => brief(child, ctx)), ...(children.length > 60 ? { moreContents: children.length - 60 } : {}) } : {}),
          stats: { files: node.stats.files, symbols: node.stats.symbols, endpoints: node.stats.endpoints, lines: node.stats.measuredLoc },
          ...(coverage ? { coverage: { category: coverage.category, reason: coverage.reason, flows: coverage.totalFlows, firstFlows: coverage.flows.slice(0, 15).map(flow => ({ name: flow.title ?? flow.name, kind: flow.kind, link: schemeHref('flow', flow.name) })) } } : {}),
          ...(relations ? { relationships: { total: relations.total, byType: relations.typeCounts, first: relations.items.map(item => ({ [item.direction === 'incoming' ? 'from' : 'to']: brief(item.other, ctx), type: item.type, ...(item.inside ? { through: item.inside.name } : {}) })) } } : {}),
          ...(aggregate ? { crossingThisBoundary: aggregate.totalCrossing, connections: aggregate.groups.slice(0, 30).map(group => ({ direction: group.direction, type: group.type, count: group.count, other: brief(group.anchor, ctx) })) } : {}),
          ...(effects?.length ? { effects } : {}),
          ...(authorship?.available ? { people: authorship.people.slice(0, 5).map(person => ({ name: person.name, kind: person.kind, commits: person.commits, lines: person.lines })), lastCommits: authorship.recent.slice(0, 5).map(commit => ({ commit: commit.sha.slice(0, 10), subject: commit.subject, date: commit.authoredAt.slice(0, 10) })) } : {}),
          ...(explained.items.length ? { explainedIn: explained.items.slice(0, 10).map(item => ({ id: item.id, title: item.title, via: item.via })) } : {}),
        });
      },
    },
    {
      name: 'relations', title: 'Relationships of an entity', readOnly: true,
      description: 'The indexed relationships of one entity (a file includes those of its symbols): imports, calls, renders, requests (frontend to backend), handles, reads, writes, extends… with the other end\'s link.',
      inputSchema: object({ link: LINK_INPUT, direction: { type: 'string', enum: ['incoming', 'outgoing', 'both'], description: 'Default both' }, type: string('Only this relation type, e.g. calls, requests, reads, writes, renders, imports'), limit: integer('At most this many (default 50)', 1, 200), offset: integer('Skip this many', 0, 100000) }, ['link']),
      async run(input) {
        const { node, ctx } = await target(input.link);
        const page = projection.relations(node.id, { direction: optionalText(input.direction), type: optionalText(input.type), limit: optionalNumber(input.limit) ?? 50, offset: optionalNumber(input.offset), scope: node.type === 'file' ? 'contained' : undefined, view: LIVE });
        return json({ of: brief(node, ctx), total: page.total, hasMore: page.hasMore, byType: page.typeCounts, items: page.items.map(item => ({ direction: item.direction, type: item.type, other: brief(item.other, ctx), ...(item.inside ? { through: brief(item.inside, ctx) } : {}) })) });
      },
    },
    {
      name: 'flows', title: 'Flows by entry point', readOnly: true,
      description: 'Every evidenced entry: UI, HTTP, CLI, MCP, worker messages and configured functions. Tests and fixtures have their own source scopes. Filter by kind, source scope, an entity they touch, or words of their name.',
      inputSchema: object({ kind: { type: 'string', enum: ['page', 'request', 'command', 'schedule', 'cli', 'mcp', 'worker', 'function', 'unmatched'] }, scope:{ type:'string',enum:['application','test','fixture','all'],description:'Application source by default; test and fixture flows are separate scopes' }, link: string('Only the flows touching this (a path or link)'), query: string('Words of the flow name or title'), limit: integer('At most this many (default 60)', 1, 300) }),
      async run(input) {
        const entity = input.link !== undefined ? (await target(input.link)).node.id : undefined;
        const list = projection.flows({ view: LIVE, entity, kind: optionalText(input.kind), scope:(optionalText(input.scope) ?? 'application') as 'application'|'test'|'fixture'|'all' });
        const words = optionalText(input.query)?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
        const items = list.items.filter(item => words.every(word => `${item.name} ${item.title ?? ''} ${item.goal ?? ''}`.toLowerCase().includes(word)));
        const limit = optionalNumber(input.limit) ?? 60;
        return json({ counts: list.counts,scopeCounts:list.scopeCounts, total: items.length, items: items.slice(0, limit).map(item => ({
          name: item.name, kind: item.kind, link: item.kind === 'unmatched' ? undefined : schemeHref('flow', item.name), ...(item.title ? { title: item.title } : {}), ...(item.goal ? { goal: item.goal } : {}),
          channel:item.channel,scope:item.scope,evidenceCoverage:item.evidenceCoverage,entry: brief(projection.linkContext(LIVE).index.node(item.entry.id) ?? { id: item.entry.id, type: item.entry.type, name: item.entry.name } as ProjectionNode), files: item.files, ...(item.status ? { gaps: item.gaps } : {}), ...(item.tables ? { tables: item.tables } : {}), ...(item.cadence ? { runs: item.cadence } : {}),
        })) });
      },
    },
    {
      name: 'flow', title: 'One flow, step by step', readOnly: true,
      description: 'What happens in one flow: for a request, command or task, its lanes in order (caller, route, middleware, controller, services, data, response) with gaps where the index cannot see; for a page, the steps it sets in motion with the conditions read from source.',
      inputSchema: object({ flow: string('The flow: flow:<name> as the flows tool lists it, or the entry point\'s path') }, ['flow']),
      async run(input) {
        const raw = requireText(input.flow, 'flow');
        // A flow by name first ("POST /api/orders", "/cart"), then an entry point by path.
        let found: Awaited<ReturnType<typeof target>>;
        try { found = await target(raw.startsWith('flow:') ? raw : `flow:${raw}`); }
        catch (error) { if (raw.startsWith('flow:')) throw error; found = await target(raw); }
        const { node, ctx } = found;
        const flow = ctx.flows.find(item => item.summary.entry.id === node.id || item.summary.id === node.id);
        if (flow?.summary.detail === 'lanes') {
          const lanes = await projection.requestFlow(flow.summary.id, { view: LIVE, maxFileBytes: context.maxFileBytes });
          const byId = new Map(lanes.nodes.map(item => [item.id, item]));
          const label = (id: string) => { const item = byId.get(id); return item ? `${item.lane}: ${item.label}` : id; };
          return json({
            flow: flow.summary.name, kind: flow.summary.kind,channel:flow.summary.channel,evidenceCoverage:lanes.evidenceCoverage,laneLabels:lanes.laneLabels, ...(flow.summary.title ? { title: flow.summary.title } : {}), notices: lanes.notices,
            nodes: lanes.nodes.map(item => ({ lane: item.lane, kind: item.kind, label: item.label, ...(item.detail ? { detail: item.detail } : {}), ...(item.node ? { entity: brief(item.node, ctx) } : {}), ...(item.page ? { page: brief(item.page.node, ctx) } : {}), ...(item.effect ? { effect: `${item.effect.category} ${item.effect.operation}: ${item.effect.detail} in ${item.effect.ownerName} (line ${item.effect.line})` } : {}), ...(item.gap ? { gap: item.gap.text } : {}), ...(item.status ? { status: item.status } : {}) })),
            edges: lanes.edges.map(edge => ({ from: label(edge.from), to: label(edge.to), kind: edge.kind, ...(edge.label ? { label: edge.label } : {}), ...(edge.via.length ? { via: edge.via.map(item => item.name) } : {}), ...(edge.when.length ? { when: edge.when.map(guard => guard.phrase) } : {}) })),
          });
        }
        const steps = await projection.steps(node.id, { view: LIVE, maxFileBytes: context.maxFileBytes });
        const byId = new Map(steps.steps.map(step => [step.id, step]));
        const name = (id: string) => { const step = byId.get(id); return step?.node?.name ?? (step?.effect ? `${step.effect.category} ${step.effect.operation}` : id); };
        return json({
          from: brief(steps.anchor, ctx), notices: steps.notices,
          steps: steps.steps.map(step => ({ layer: step.layer, kind: step.kind, ...(step.node ? brief(step.node, ctx) : {}), ...(step.effect ? { effect: `${step.effect.category} ${step.effect.operation}: ${step.effect.detail} (line ${step.effect.line})`, ...(step.effect.when.length ? { when: step.effect.when.map(guard => guard.phrase) } : {}) } : {}), ...(step.navigation ? { navigation: true } : {}) })),
          links: steps.links.filter(item => !item.back).map(item => ({ from: name(item.from), to: name(item.to), how: item.hops.map(hop => hop.type).join(' → '), ...(item.event ? { event: item.event } : {}), ...(item.when.length ? { when: item.when.map(guard => guard.phrase) } : {}) })),
        });
      },
    },
    {
      name: 'impact', title: 'Blast radius', readOnly: true,
      description: 'What depends on an entity, hop by hop: every affected entity with the chain of relations that reaches it, grouped by folder, and what the walk cannot see (so the result is a lower bound).',
      inputSchema: object({ link: LINK_INPUT, depth: integer('Hops to follow (default 3)', 1, 10), limit: integer('At most this many entities (default 60)', 1, 300) }, ['link']),
      async run(input) {
        const { node, ctx } = await target(input.link);
        const result = projection.impact(node.id, { depth: optionalNumber(input.depth) ?? 3, limit: optionalNumber(input.limit) ?? 60, group: 'folder', view: LIVE });
        return json({
          origin: brief(node, ctx), affected: result.total, byDistance: result.byDistance.slice(1), byType: result.byType, truncated: result.truncated,
          endpoints: result.highlights.endpoints, routes: result.highlights.routes, folders: result.groups?.slice(0, 20).map(group => ({ folder: group.name, count: group.count, nearest: group.distance })),
          items: result.items.items.map(item => ({ ...brief(item, ctx), hops: item.distance, chain: item.chain.map(hop => `${hop.from.name} ${hop.type} ${hop.to.name}`).join(' → ') })),
          cannotSee: result.unknowns,
        });
      },
    },
    {
      name: 'history', title: 'Commits', readOnly: true,
      description: 'Recent commits of the current branch (with pull requests and model notes when known), or, with a link, the indexed commits where that entity appeared, changed, moved or was removed.',
      inputSchema: object({ link: string('Only the commits that changed this entity (needs indexed history)'), limit: integer('At most this many (default 30)', 1, 200) }),
      async run(input) {
        const history = context.history;
        if (!history) return json({ available: false, reason: 'No Git history is available' });
        const limit = optionalNumber(input.limit) ?? 30;
        const timeline = projection.annotateTimeline(await history.timeline());
        const env = await environment();
        if (input.link !== undefined) {
          const { node, ctx } = await target(input.link);
          if (!timeline.available) return json({ available: false, reason: timeline.reason });
          const listed = await history.commits(await history.defaultRef());
          const result = projection.entityHistory(node.id, listed?.commits.map(commit => commit.sha) ?? [], await history.currentIdentity());
          const subjects = new Map(env.commits.map(commit => [commit.sha, commit.subject]));
          return json({ of: brief(node, ctx), indexedCommits: result.indexedSnapshots, points: result.points.slice(-limit).map(point => ({ commit: point.sha.slice(0, 10), link: `commit:${point.sha.slice(0, 10)}`, status: point.status, subject: subjects.get(point.sha), ...(point.path ? { path: point.path } : {}) })) });
        }
        const entries = timeline.entries.length ? timeline.entries.slice(-limit).reverse().map(entry => ({ commit: entry.sha.slice(0, 10), link: `commit:${entry.sha.slice(0, 10)}`, subject: entry.note?.title ?? entry.subject, ...(entry.note ? { message: entry.subject, intent: entry.note.intent } : {}), author: entry.authorName, date: entry.authoredAt.slice(0, 10), ...(entry.pullRequest ? { pr: entry.pullRequest.number, prLink: `pr:${entry.pullRequest.number}` } : {}), indexed: !!entry.snapshot }))
          : env.commits.slice(-limit).reverse().map(commit => ({ commit: commit.sha.slice(0, 10), link: `commit:${commit.sha.slice(0, 10)}`, subject: commit.subject, ...(commit.pr ? { pr: commit.pr, prLink: `pr:${commit.pr}` } : {}) }));
        return json({ indexedHistory: timeline.available, commits: entries });
      },
    },
    {
      name: 'commit', title: 'One commit', readOnly: true,
      description: 'One commit (or a merged pull request with pr): its message, the files it changed, and, when history is indexed, the entities it added, modified, moved or removed, with their links.',
      inputSchema: object({ commit: string('A commit SHA (at least 7 characters), or pr:<number>') }, ['commit']),
      async run(input) {
        const raw = requireText(input.commit, 'commit');
        const env = await environment();
        const parsed = parseLink(raw.startsWith('pr:') || raw.startsWith('commit:') ? raw : `commit:${raw}`)!;
        const resolved = resolveLink(parsed, env);
        if (resolved.status === 'missing' || !resolved.sha) throw new ToolInputError(resolved.reason ?? `No commit ${raw}`);
        const sha = resolved.sha;
        const result: Record<string, unknown> = { commit: sha, link: `commit:${sha.slice(0, 10)}` };
        if (context.root) {
          try {
            const { stdout } = await execute('git', ['show', '--no-color', '--format=%an%n%aI%n%B%x00', '--numstat', '-M', sha], { cwd: context.root, maxBuffer: 8 * 1024 * 1024 });
            const [header, stats = ''] = stdout.split('\0');
            const [author, date, ...message] = header!.split('\n');
            Object.assign(result, { author, date, message: message.join('\n').trim() });
            const files = stats.trim().split('\n').filter(Boolean).map(line => { const [added, removed, ...rest] = line.split('\t'); return { path: rest.join('\t'), added: Number(added) || 0, removed: Number(removed) || 0 }; });
            result.files = files.slice(0, 120).map(file => ({ ...file, link: env.context.byPath.has(file.path) ? file.path : undefined }));
            if (files.length > 120) result.moreFiles = files.length - 120;
          } catch (error) { result.gitError = error instanceof Error ? error.message.split('\n')[0] : String(error); }
        }
        const timeline = context.history ? projection.annotateTimeline(await context.history.timeline().catch(() => ({ available: false, entries: [], firstParent: true, indexing: { enabled: false, queued: [], failed: [] } }))) : undefined;
        const at = timeline?.entries.findIndex(entry => entry.sha === sha) ?? -1;
        const entry = at >= 0 ? timeline!.entries[at] : undefined;
        if (entry?.note) result.modelNote = entry.note;
        if (entry?.pullRequest) result.pullRequest = entry.pullRequest;
        const previous = at > 0 ? timeline!.entries.slice(0, at).reverse().find(item => item.snapshot)?.snapshot?.id : undefined;
        if (entry?.snapshot && previous) {
          const view = { snapshot: entry.snapshot.id, compareTo: previous };
          await projection.prepare(view);
          const changes = projection.changes(view, { limit: 120 });
          const ctx = links();
          result.changedEntities = { counts: changes.statusCounts, total: changes.total, items: changes.items.map(item => ({ status: item.change?.status, type: item.type, name: item.name, ...(ctx.index.node(item.id) ? { link: hrefOf(ctx.index.node(item.id)!, ctx) } : { goneSince: item.path }) })) };
        } else result.changedEntities = 'History is not indexed for this commit and its predecessor: only the files are known (run history index for the entities).';
        return json(result);
      },
    },
    {
      name: 'source', title: 'Read source', readOnly: true,
      description: `The source of a file or symbol as indexed (a symbol: its lines), at most ${SOURCE_LINES} lines at a time, numbered. Give start and end for other lines of the file.`,
      inputSchema: object({ link: LINK_INPUT, start: integer('First line', 1, 10_000_000), end: integer('Last line', 1, 10_000_000) }, ['link']),
      async run(input) {
        const { node, link, ctx } = await target(input.link);
        if (['repository', 'application', 'directory', 'group'].includes(node.type)) throw new ToolInputError(`${node.path ?? node.name} is a folder; use entity to list it`);
        let start = optionalNumber(input.start) ?? link?.lines?.start, end = optionalNumber(input.end) ?? link?.lines?.end;
        if (start !== undefined && end === undefined) end = start + SOURCE_LINES - 1;
        if (start !== undefined && end !== undefined && end - start >= SOURCE_LINES) end = start + SOURCE_LINES - 1;
        const source = await projection.source({ entity: node.id, ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) }, context.maxFileBytes, LIVE);
        const width = String(source.end).length;
        return `${source.file.path} lines ${source.start}-${source.end} of ${source.totalLines}${source.changedSinceIndex ? ' (the file changed since it was indexed)' : ''} · link ${hrefOf(ctx.index.node(source.file.id) ?? node, ctx)}\n${source.lines.map((line, index) => `${String(source.start + index).padStart(width)}  ${line}`).join('\n')}${source.end < source.totalLines ? `\n… ${source.totalLines - source.end} more lines (start=${source.end + 1})` : ''}`;
      },
    },
    {
      name: 'check_links', title: 'Check the links of a text', readOnly: true,
      description: 'Resolve every link of a Markdown text against the index before publishing: what each names, and why the others do not resolve.',
      inputSchema: object({ markdown: string('The text to check') }, ['markdown']),
      async run(input) {
        const checked = await service.check(requireText(input.markdown, 'markdown'));
        return json({ links: checked.length, unresolved: checked.filter(item => item.status === 'missing').map(item => ({ href: item.href, reason: item.reason })), resolved: checked.filter(item => item.status === 'ok').map(item => ({ href: item.href, is: `${item.type ?? item.kind} ${item.label ?? item.path ?? item.name ?? ''}`.trim(), ...(item.reason ? { note: item.reason } : {}) })) });
      },
    },
  ];
}

/** Tools that read and write explanations (an agent's; the chat saves its answers itself). */
export function explanationTools(context: ToolContext): ToolSpec[] {
  const { service } = context;
  const url = (id: string) => { const base = context.serverUrl?.(); return base ? `${base.replace(/\/$/, '')}/#explain=${encodeURIComponent(id)}` : undefined; };
  const subjectSchema = object({ kind: { type: 'string', enum: SUBJECTS, description: 'overview (the codebase), flow, commit, pr, entity (a file, folder or symbol), or question' }, ref: string('What it is about: flow:<name>, a commit SHA, a PR number, or a path') }, ['kind']);
  const saved = (detail: ExplanationDetail, verb: string) => json({
    [verb]: detail.id, title: detail.title, file: detail.file, ...(url(detail.id) ? { open: url(detail.id) } : { open: 'Open the Codiluce map (codiluce start) and its Explanations column' }),
    links: detail.links.filter(link => link.status !== 'external').length, subject: detail.subject,
    ...(detail.links.some(link => link.status === 'missing') ? { unresolved: detail.links.filter(link => link.status === 'missing').map(link => link.href) } : {}),
    pinnedTo: detail.commit,
  });
  const unresolved = (error: unknown): string => {
    if (!(error instanceof UnresolvedLinksError)) throw error;
    return json({ saved: false, reason: 'Some links do not name anything indexed. Fix them (search finds the right path; copy the link values tools return) and call again, or pass allowUnresolved: true to save anyway.', unresolved: error.links.map(link => ({ href: link.href, reason: link.reason })) });
  };
  // Asked to explain without saying what (no question given): the question start_explanation named.
  const asked = (question: string | undefined) => question ?? context.activity?.work?.question;
  const published = (detail: ExplanationDetail) => { context.activity?.published(detail); return detail; };
  return [
    ...(context.activity ? [{
      name: 'start_explanation', title: 'Say what you are explaining', readOnly: true,
      description: 'Call this only when the user explicitly asks for a code, PR or history explanation, before reading the code. Do not call for implementation or ordinary reads. Once started, the Codiluce map shows at once that an explanation is on its way, with their question and each tool you call, until `publish_explanation` saves it. Saves nothing.',
      inputSchema: object({ title: string('What you are explaining, in a few words'), question: string('What the user asked, in their words'), subject: subjectSchema }),
      async run(input: Record<string, unknown>) {
        context.activity!.begin({ title: optionalText(input.title), question: optionalText(input.question), subject: subjectInput(input.subject) });
        return json({ started: true, next: 'Read the code with the Codiluce tools, then save the answer with publish_explanation.' });
      },
    } satisfies ToolSpec] : []),
    {
      name: 'publish_explanation', title: 'Save an explanation', readOnly: false,
      description: `Save what you explained so the user reads it in Codiluce's Explanations column: hovering a link lights that code on the map, clicking it opens it. Links are checked first; the explanation is pinned to the indexed commit so it shows when the code changes later. Write Markdown with headings and short paragraphs.\n\n${LINK_GUIDE}`,
      inputSchema: object({ title: string('A short title (default: the first heading)'), markdown: string('The explanation, in Markdown, with links'), question: string('What the user asked, in their words'), subject: subjectSchema, allowUnresolved: { type: 'boolean', description: 'Save even if some links do not resolve' } }, ['markdown']),
      async run(input) {
        try {
          const detail = published(await service.publish({ markdown: requireText(input.markdown, 'markdown'), title: optionalText(input.title), question: asked(optionalText(input.question)), subject: subjectInput(input.subject) ?? context.activity?.work?.subject, source: 'agent', agent: context.agent?.(), allowUnresolved: input.allowUnresolved === true }));
          return saved(detail, 'saved');
        } catch (error) { return unresolved(error); }
      },
    },
    {
      name: 'update_explanation', title: 'Add to or replace an explanation', readOnly: false,
      description: 'Answer a follow-up in an existing explanation (append), or rewrite it after the code changed (replace). Links are checked and pinned again.',
      inputSchema: object({ id: string('The explanation ID'), markdown: string('The new answer, in Markdown, with links'), question: string('The follow-up question, if any'), mode: { type: 'string', enum: ['append', 'replace'], description: 'append (default) or replace' }, allowUnresolved: { type: 'boolean' } }, ['id', 'markdown']),
      async run(input) {
        try {
          const detail = published(await service.publish({ id: requireText(input.id, 'id'), markdown: requireText(input.markdown, 'markdown'), question: optionalText(input.question), mode: input.mode === 'replace' ? 'replace' : 'append', source: 'agent', agent: context.agent?.(), allowUnresolved: input.allowUnresolved === true }));
          return saved(detail, 'updated');
        } catch (error) { return unresolved(error); }
      },
    },
    {
      name: 'list_explanations', title: 'Saved explanations', readOnly: true,
      description: 'The explanations saved for this repository, newest first, with what went stale since each was written.',
      inputSchema: object({ limit: integer('At most this many (default 30)', 1, 200) }),
      async run(input) {
        const list = await service.list();
        return json({ total: list.items.length, items: list.items.slice(0, optionalNumber(input.limit) ?? 30).map(item => ({ id: item.id, title: item.title, subject: item.subject, updated: item.updatedAt, by: item.agent ?? item.source, stale: item.stale.changed || item.stale.missing ? item.stale : undefined, excerpt: item.excerpt })) });
      },
    },
    {
      name: 'read_explanation', title: 'Read an explanation', readOnly: true,
      description: 'One saved explanation: its questions and answers, the commit it is pinned to, and the links whose code changed or disappeared since (what to update).',
      inputSchema: object({ id: string('The explanation ID') }, ['id']),
      async run(input) {
        const detail = await service.detail(requireText(input.id, 'id'));
        if (!detail) throw new ToolInputError(`No explanation ${String(input.id)}`);
        return json({ id: detail.id, title: detail.title, subject: detail.subject, pinnedTo: detail.commit, stale: detail.stale, changed: detail.links.filter(link => link.status === 'changed').map(link => link.href), missing: detail.links.filter(link => link.status === 'missing').map(link => link.href), turns: detail.turns.map(turn => ({ role: turn.role, text: turn.text, ...(turn.model ? { model: turn.model } : {}) })), latest: latestAnswer(detail)?.at });
      },
    },
  ];
}

function subjectInput(value: unknown): { kind: SubjectKind; ref?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { kind, ref } = value as { kind?: unknown; ref?: unknown };
  if (typeof kind !== 'string' || !SUBJECTS.includes(kind as SubjectKind)) throw new ToolInputError(`subject.kind must be one of ${SUBJECTS.join(', ')}`);
  return { kind: kind as SubjectKind, ...(typeof ref === 'string' && ref.trim() ? { ref: ref.trim() } : {}) };
}
export function requireText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ToolInputError(`${name} is required`);
  return value.trim();
}
function optionalText(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new ToolInputError('Expected a number');
  return Math.round(number);
}
/** A tool call as one line (`flow POST /api/orders`): the steps shown while an answer is being written. */
export function describeTool(name: string, input: unknown): string {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const main = value.link ?? value.flow ?? value.query ?? value.commit ?? value.kind ?? value.title ?? value.id ?? '';
  return `${name}${typeof main === 'string' || typeof main === 'number' ? ` ${String(main)}` : ''}`.trim();
}
function safe<T>(work: () => T): T | undefined { try { return work(); } catch { return undefined; } }
function json(value: unknown): string { return JSON.stringify(value, (_key, item) => item === undefined ? undefined : item); }
/** Run a tool by name with a JSON input; errors come back as text for the model to read. */
export async function runTool(tools: ToolSpec[], name: string, input: unknown): Promise<{ text: string; isError: boolean }> {
  const tool = tools.find(item => item.name === name);
  if (!tool) return { text: `Unknown tool ${name}`, isError: true };
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) return { text: 'The input must be a JSON object', isError: true };
  try { return { text: await tool.run((input ?? {}) as Record<string, unknown>), isError: false }; }
  catch (error) { return { text: error instanceof Error ? error.message : String(error), isError: true }; }
}
