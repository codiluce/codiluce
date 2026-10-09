/** Numeric RubyGems release versions. Trailing zeroes compare equally, while
 * hotfix components remain significant. Prerelease/custom versions stay gaps.
 * Source contract: ruby/rubygems v3.6.9 Version#<=>/#bump and Requirement. */
type Operator = '=' | '!=' | '>=' | '<=' | '>' | '<' | '~>';
interface Clause { operator: Operator; version: number[]; upper?: number[] }
interface Bound { version: number[]; inclusive: boolean }
interface Bounds { lower: Bound; upper?: Bound; excluded: number[][]; empty: boolean }
export function rubyNumericVersion(text: string): number[] | undefined {
  if (text.length > 256 || !/^\d+(?:\.\d+){0,15}$/.test(text)) return;
  const parts = text.split('.').map(Number); return parts.every(Number.isSafeInteger) ? parts : undefined;
}
export function compareRubyVersions(left: number[], right: number[]): number {
  for (let i = 0; i < Math.max(left.length, right.length); i++) { const a = left[i] ?? 0, b = right[i] ?? 0; if (a !== b) return a < b ? -1 : 1; } return 0;
}
function clauses(requirements: string[]): Clause[] | undefined {
  if (requirements.length > 256) return;
  const result: Clause[] = [];
  for (const text of requirements) {
    const match = /^\s*(~>|!=|>=|<=|>|<|=)?\s*(\d+(?:\.\d+)*)\s*$/.exec(text), version = match && rubyNumericVersion(match[2]!); if (!match || !version) return;
    const operator = (match[1] ?? '=') as Operator;
    if (operator === '~>') { const upper = version.slice(0, Math.max(1, version.length - 1)); upper[upper.length - 1]!++; if (!upper.every(Number.isSafeInteger)) return; result.push({ operator, version, upper }); }
    else result.push({ operator, version });
  }
  return result;
}
function bounds(requirements: string[]): Bounds | undefined {
  const parsed = clauses(requirements); if (!parsed) return;
  const result: Bounds = { lower: { version: [0], inclusive: true }, excluded: [], empty: false };
  const lower = (bound: Bound) => { const order = compareRubyVersions(bound.version, result.lower.version); if (order > 0 || !order && !bound.inclusive) result.lower = bound; };
  const upper = (bound: Bound) => { const order = result.upper ? compareRubyVersions(bound.version, result.upper.version) : -1; if (order < 0 || !order && !bound.inclusive) result.upper = bound; };
  for (const clause of parsed) {
    if (clause.operator === '!=') result.excluded.push(clause.version);
    else if (clause.operator === '=') { lower({ version: clause.version, inclusive: true }); upper({ version: clause.version, inclusive: true }); }
    else if (clause.operator === '>' || clause.operator === '>=') lower({ version: clause.version, inclusive: clause.operator === '>=' });
    else if (clause.operator === '<' || clause.operator === '<=') upper({ version: clause.version, inclusive: clause.operator === '<=' });
    else { lower({ version: clause.version, inclusive: true }); upper({ version: clause.upper!, inclusive: false }); }
  }
  if (result.excluded.some(version => compareRubyVersions(version, result.lower.version) === 0)) result.lower.inclusive = false;
  if (result.upper) { if (result.excluded.some(version => compareRubyVersions(version, result.upper!.version) === 0)) result.upper.inclusive = false; const order = compareRubyVersions(result.lower.version, result.upper.version); result.empty = order > 0 || order === 0 && (!result.lower.inclusive || !result.upper.inclusive); }
  return result;
}
export function validRubyRequirements(requirements: string[]): boolean { return !!clauses(requirements); }
export function emptyRubyRequirements(requirements: string[]): boolean | undefined { return bounds(requirements)?.empty; }
export function satisfiesRubyRequirements(version: string, requirements: string[]): boolean | undefined {
  const value = rubyNumericVersion(version), parsed = clauses(requirements); if (!value || !parsed) return;
  return parsed.every(clause => { const order = compareRubyVersions(value, clause.version); return clause.operator === '=' ? order === 0 : clause.operator === '!=' ? order !== 0 : clause.operator === '>=' ? order >= 0 : clause.operator === '>' ? order > 0 : clause.operator === '<=' ? order <= 0 : clause.operator === '<' ? order < 0 : order >= 0 && compareRubyVersions(value, clause.upper!) < 0; });
}
export function rubyProfileExact(profile: { version?: string; requirements?: string[] }, version: string): boolean {
  if (profile.version) return satisfiesRubyRequirements(profile.version, ['=' + version]) === true;
  return !!profile.requirements?.length && satisfiesRubyRequirements(version, profile.requirements) === true && emptyRubyRequirements([...profile.requirements, '!=' + version]) === true;
}
/** A selected numeric version or every release allowed by an ANDed requirement
 * must fall inside the reviewed half-open release-line interval. */
export function rubyProfileSubset(profile: { version?: string; requirements?: string[] }, minimum?: string, maximum?: string): boolean {
  const low = minimum && rubyNumericVersion(minimum), high = maximum && rubyNumericVersion(maximum);
  if (minimum && !low || maximum && !high) return false;
  if (profile.version) { const value = rubyNumericVersion(profile.version); return !!value && (!low || compareRubyVersions(value, low) >= 0) && (!high || compareRubyVersions(value, high) < 0); }
  if (!profile.requirements?.length) return false;
  const range = bounds(profile.requirements); if (!range || range.empty) return false;
  if (low && compareRubyVersions(range.lower.version, low) < 0) return false;
  if (high) { if (!range.upper) return false; const order = compareRubyVersions(range.upper.version, high); if (order > 0 || order === 0 && range.upper.inclusive) return false; }
  return true;
}
