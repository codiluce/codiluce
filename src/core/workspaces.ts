import { parse } from 'yaml';

export interface WorkspacePatterns { include: string[]; exclude: string[]; issues: string[] }
/** Static package membership. No package-manager configuration is executed. */
export function nodeWorkspacePatterns(name: string, text: string): WorkspacePatterns {
  const result: WorkspacePatterns = { include: [], exclude: [], issues: [] };
  let values: unknown;
  try {
    if (name === 'package.json') {
      const value = JSON.parse(text);
      values = Array.isArray(value.workspaces) ? value.workspaces : value.workspaces?.packages;
    } else if (name === 'pnpm-workspace.yaml') values = parse(text)?.packages;
    else return result;
  } catch { result.issues.push(`Cannot parse workspace manifest: ${name}`); return result; }
  if (values === undefined) return result;
  if (!Array.isArray(values) || !values.every(item => typeof item === 'string')) { result.issues.push('Workspace packages must be a list of path patterns'); return result; }
  for (const value of values as string[]) {
    const excluded = value.startsWith('!'), pattern = excluded ? value.slice(1) : value;
    if (!pattern || /[{}[\]\\\0]/.test(pattern) || pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern)) result.issues.push(`Unsupported workspace path pattern: ${value}`);
    else (excluded ? result.exclude : result.include).push(pattern.replace(/^\.\//, '').replace(/\/$/, ''));
  }
  return result;
}
