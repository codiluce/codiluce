import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { satisfies, valid } from 'semver';
import { evidence, type Evidence } from '../../core/graph.js';
import { cargoRequirement, type RustDependency, type RustPackage } from './rust-projects.js';
import type { RustResolver } from './rust.js';

interface LockedPackage { name: string; version: string; source?: string; dependencies: string[]; line: number }
export interface RustLockedSelection { package: LockedPackage; proof: Evidence[] }
const registry = 'registry+https://github.com/rust-lang/crates.io-index';
const selector = /^([A-Za-z0-9_-]+)(?: ([0-9][^ ()]*))?(?: \(([^\r\n]+)\))?$/;
const table = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Recorded Cargo.lock selections only, never a resolver/toolchain run. A
 * transitive provider must be reached from the original owning package edge;
 * another workspace/target's similarly named entry cannot lend its version. */
export class RustLockfiles {
    private readonly files = new Map<string, LockedPackage[] | undefined>();
    constructor(private readonly base: RustResolver) { }
    private read(file: string): LockedPackage[] | undefined {
        if (this.files.has(file)) return this.files.get(file);
        this.files.set(file, undefined);
        const text = this.base.projects.sources.readFile(file);
        if (text === undefined || text.length > (1 << 20)) return;
        try {
            const document = parseToml(text);
            if (document.version !== 3 && document.version !== 4 || !Array.isArray(document.package) || document.package.length > 4096) return;
            const lines = text.split('\n').flatMap((line, index) => /^\s*\[\[package\]\]\s*(?:#.*)?$/.test(line) ? [index + 1] : []);
            if (lines.length !== document.package.length) return;
            // A package-header-looking line inside unrelated multiline data
            // cannot supply coordinates for an inline package array.
            if (!lines.length || parseToml(text.split('\n').slice(0,lines[0]! - 1).join('\n')).package !== undefined) return;
            const entries: LockedPackage[] = [], ids = new Set<string>();
            for (const [index, input] of document.package.entries()) {
                const item = table(input);
                if (!item || typeof item.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.name) || typeof item.version !== 'string' || !valid(item.version) || item.source !== undefined && typeof item.source !== 'string' || item.dependencies !== undefined && (!Array.isArray(item.dependencies) || item.dependencies.length > 4096 || item.dependencies.some(value => typeof value !== 'string' || value.length > 2048))) return;
                const entry = { name: item.name, version: item.version, ...(item.source !== undefined ? { source: item.source as string } : {}), dependencies: item.dependencies as string[] ?? [], line: lines[index]! };
                if (entry.source !== undefined && (!entry.source || entry.source.length > 2048)) return;
                for (const dependency of entry.dependencies) {
                    const parsed = selector.exec(dependency);
                    if (!parsed || parsed[2] && !valid(parsed[2])) return;
                }
                const id = JSON.stringify([entry.name, entry.version, entry.source]);
                if (ids.has(id)) return;
                ids.add(id); entries.push(entry);
            }
            this.files.set(file, entries); return entries;
        } catch { return; }
    }
    private edge(entries: LockedPackage[], owner: LockedPackage, name: string): LockedPackage | undefined {
        const selectors = owner.dependencies.map(value => selector.exec(value)).filter(value => value?.[1] === name);
        if (selectors.length !== 1) return;
        const selected = selectors[0]!, matches = entries.filter(item => item.name === name && (!selected[2] || item.version === selected[2]) && (!selected[3] || item.source === selected[3]));
        return matches.length === 1 && matches[0]!.source === registry ? matches[0] : undefined;
    }
    select(pkg: RustPackage, dependency: RustDependency, provider?: string): RustLockedSelection | undefined {
        if (dependency.source !== 'registry' || dependency.sourceId !== 'crates-io' || dependency.gaps.length || pkg.gaps.length) return;
        const file = path.posix.join(pkg.workspace ?? pkg.root, 'Cargo.lock'), entries = this.read(file);
        if (!entries || !pkg.version) return;
        const roots = entries.filter(item => item.name === pkg.name && item.version === pkg.version && item.source === undefined);
        if (roots.length !== 1) return;
        const selected = this.edge(entries, roots[0]!, dependency.package), requirement = dependency.version && cargoRequirement(dependency.version);
        if (!selected || !requirement || !satisfies(selected.version, requirement)) return;
        const target = provider ? this.edge(entries, selected, provider) : selected;
        if (!target) return;
        const proof = [roots[0]!, selected, ...target === selected ? [] : [target]].map(item => ({ ...evidence('syntax', 'rust-imports', file, item.line, `Original Cargo.lock ${item.name} ${item.version} selection on the owning package dependency path; no dependency resolution or execution`), analyzerVersion: '1' }));
        return { package: target, proof };
    }
}
