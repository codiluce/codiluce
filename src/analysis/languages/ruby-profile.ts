import semver from 'semver';
import path from 'node:path';
import type { AnalysisContext } from '../../core/analyzer.js';
import { evidence, type Evidence } from '../../core/graph.js';
import { IndexedSources } from '../indexed-sources.js';
import type { RubyProject, RubyResolver } from '../resolution/ruby.js';
import { rubyNumericVersion, rubyProfileSubset, validRubyRequirements, emptyRubyRequirements, satisfiesRubyRequirements, compareRubyVersions } from './ruby-version.js';

export const RUBY_PROFILE_VERSION = '2';
export interface RubyGemProfile { gem: string; reviewed: boolean; version?: string; range?: string; requirements: string[]; proof: Evidence[]; gaps: string[] }
const REVIEWED: Record<string, [string, string][]> = { rails: [['7.1', '7.3'], ['8.0', '8.2']], zeitwerk: [['2.6', '2.8']] };
/** RubyGems requirements are ANDed; pessimistic ~> differs from npm's tilde. */
export function rubyGemRange(requirements: string[]): string | undefined {
  if (!requirements.length) return;
  const parts: string[] = [];
  for (const value of requirements.flatMap(item => item.split(','))) {
    const match = /^\s*(~>|>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2})\s*$/.exec(value); if (!match) return;
    const segments = match[2]!.split('.').map(Number); if (segments.some(item => !Number.isSafeInteger(item))) return;
    const normalized = [...segments, ...Array(3 - segments.length).fill(0)].join('.'), operator = match[1] ?? '=';
    if (operator === '~>') { const upper = [...segments, ...Array(3 - segments.length).fill(0)], index = segments.length === 3 ? 1 : 0; upper[index]++; for (let i = index + 1; i < 3; i++) upper[i] = 0; parts.push(`>=${normalized}`, `<${upper.join('.')}`); }
    else parts.push(`${operator === '=' ? '' : operator}${normalized}`);
  }
  try { return semver.validRange(parts.join(' ')) ?? undefined; } catch { return; }
}

export function rubyGemProfile(context: AnalysisContext, resolver: RubyResolver, project: RubyProject, gem: string, configured?: string, transitive = false): RubyGemProfile {
  const sources = context.sources ?? new IndexedSources(context), proof: Evidence[] = [], gaps: string[] = [], requirements: string[] = [];
  const fact = (file: string | undefined, line: number | undefined, explanation: string, source: Evidence['source'] = 'syntax') => ({ ...evidence(source, 'ruby-profile', file, line, explanation), analyzerVersion: RUBY_PROFILE_VERSION });
  let declarations = 0;
  for (const file of project.manifests) {
    const syntax = resolver.facts(file); if (!syntax?.complete) { gaps.push(`Incomplete Ruby dependency manifest ${file}`); continue; }
    if (syntax.definitions.some(def => ['gem', 'add_dependency', 'add_runtime_dependency'].includes(def.name)) || syntax.calls.some(call => ['eval', 'eval_gemfile', 'instance_eval', 'class_eval'].includes(call.expression.method))) gaps.push(`Executable/custom Ruby dependency DSL in ${file}`);
    for (const call of syntax.calls) {
      if (!['gem', 'add_dependency', 'add_runtime_dependency'].includes(call.expression.method)) continue;
      const [name, ...args] = call.expression.args; if (name?.kind !== 'literal' || name.value !== gem) continue;
      if (call.expression.method === 'gem' && call.expression.receiver) { gaps.push(`Unproven receiver for ${gem} dependency DSL`); continue; }
      if (call.expression.method !== 'gem') {
        const receiver = call.expression.receiver, scopes = resolver.ancestors(file, call.scope);
        const specification = syntax.calls.find(site => site.blockScope && scopes.some(scope => scope.key === site.blockScope) && site.expression.method === 'new' && site.expression.receiver?.kind === 'constant' && ['Gem::Specification', '::Gem::Specification'].includes(site.expression.receiver.name));
        const parameter = specification && syntax.locals.find(local => local.scope === specification.blockScope && local.kind === 'parameter')?.name;
        const customFactory = syntax.definitions.some(def => ['class', 'module'].includes(def.kind) && def.name.replace(/^::/, '').split('::')[0] === 'Gem' || def.kind === 'singleton_method' && def.receiver?.kind === 'constant' && def.receiver.name.replace(/^::/, '').split('::')[0] === 'Gem') || syntax.assignments.some(item => item.target.kind === 'constant' && item.target.name.replace(/^::/, '').split('::')[0] === 'Gem');
        if (receiver?.kind !== 'identifier' || receiver.name !== parameter || syntax.locals.some(local => local.name === parameter && local.kind === 'write') || customFactory || syntax.gaps.some(gap => ['loader', 'constants'].includes(gap.kind))) { gaps.push(`Unproven gemspec receiver for ${gem} dependency DSL`); continue; }
      }
      declarations++;
      if (resolver.ancestors(file, call.scope).some(scope => scope.conditional || scope.kind === 'method')) gaps.push(`Conditional/deferred ${gem} dependency declaration`);
      const versions = args.filter(arg => arg.kind !== 'hash');
      if (versions.some(arg => arg.kind !== 'literal' || typeof arg.value !== 'string')) gaps.push(`Dynamic ${gem} version requirement`);
      else requirements.push(...versions.map(arg => arg.kind === 'literal' ? String(arg.value) : ''));
      if (args.some(arg => arg.kind === 'hash' && arg.items.some(item => item.key.kind === 'symbol' && ['path', 'git', 'github', 'branch', 'ref', 'tag'].includes(item.key.name)))) gaps.push(`Local/VCS ${gem} dependency is outside the reviewed gem profile`);
      proof.push(fact(file, call.range.startLine, `Literal ${gem} dependency requirements`));
    }
  }
  const range = rubyGemRange(requirements);
  if (!validRubyRequirements(requirements)) gaps.push(`Unsupported RubyGems ${gem} version requirements`);
  if (emptyRubyRequirements(requirements)) gaps.push(`Unsatisfiable RubyGems ${gem} version requirements`);
  const lock = path.posix.join(project.root, 'Gemfile.lock'), text = sources.readFile(lock), locked: string[] = [];
  if (text !== undefined) {
    let section = '';
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (/^[A-Z][A-Z ]+$/.test(line)) section = line;
      const match = /^    ([A-Za-z0-9_.-]+) \(([^)]+)\)\s*$/.exec(line);
      if (match?.[1] !== gem) continue;
      if (section !== 'GEM') gaps.push(`Locked ${gem} comes from unreviewed ${section || 'unknown'} source`);
      if (!rubyNumericVersion(match[2]!)) gaps.push(`Unreviewed locked ${gem} version ${match[2]}`); else locked.push(match[2]!);
      proof.push(fact(lock, index + 1, `Recorded locked ${gem} version ${match[2]}`));
    }
  } else if (context.fileInventory?.has(lock)) gaps.push(`Observed ${gem} lockfile is not indexed/readable`);
  const versions = locked.filter((version, index) => !locked.slice(0, index).some(prior => compareRubyVersions(rubyNumericVersion(version)!, rubyNumericVersion(prior)!) === 0)); if (versions.length > 1) gaps.push(`Competing locked ${gem} versions`);
  let version = versions[0];
  if (configured) { if (version && (!rubyNumericVersion(configured) || compareRubyVersions(rubyNumericVersion(version)!, rubyNumericVersion(configured)!) !== 0)) gaps.push(`Recorded ${gem} version conflicts with its lockfile`); version = configured; proof.push(fact(undefined, undefined, `Recorded ${gem} runtime version ${configured}`, 'framework')); }
  if (version && !satisfiesRubyRequirements(version, requirements)) gaps.push(`Selected ${gem} version conflicts with dependency requirements`);
  if (!configured && !declarations && !(transitive && version)) gaps.push(`No literal ${gem} dependency declaration`);
  if (!version && !requirements.length) gaps.push(`No bounded ${gem} version input`);
  const reviewed = REVIEWED[gem];
  const inProfile = reviewed?.some(([lower, upper]) => rubyProfileSubset({ version, requirements }, lower, upper));
  if (!inProfile) gaps.push(`Version is outside reviewed ${gem} autoload profiles`);
  return { gem, reviewed: gaps.length === 0, ...(version ? { version } : {}), ...(range ? { range } : {}), requirements, proof, gaps: [...new Set(gaps)] };
}
