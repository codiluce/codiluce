import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { satisfies, valid, validRange } from 'semver';
import type { AnalysisContext } from '../../core/analyzer.js';
import { applicationAt, matchesGlob, type RustConfig } from '../../core/config.js';
import { evidence, type Evidence } from '../../core/graph.js';
import { IndexedSources } from '../indexed-sources.js';
import { rustCfg, type RustCfgEnvironment, type RustTruth } from '../languages/rust-cfg.js';
export const RUST_PROJECT_VERSION = '1';
export type RustTargetKind = 'lib' | 'bin' | 'test' | 'example' | 'bench';
export interface RustDependency {
    key: string;
    name: string;
    renamed: boolean;
    package: string;
    path?: string;
    version?: string;
    source: 'path' | 'registry' | 'git';
    sourceId?: string;
    optional: boolean;
    defaultFeatures: boolean;
    features: string[];
    scope: 'normal' | 'dev' | 'build';
    condition?: string;
    gaps: string[];
    proof: Evidence[];
}
export interface RustPackage {
    id: string;
    root: string;
    manifest: string;
    name: string;
    version?: string;
    edition: string;
    workspace?: string;
    resolver: string;
    configuration: {
        file: string;
        status: 'source-neutral' | 'unsupported';
        inputs?: Table;
        gaps: string[];
        proof: Evidence[];
    }[];
    dependencies: RustDependency[];
    features: Record<string, string[]>;
    targets: RustTarget[];
    gaps: string[];
    proof: Evidence[];
}
export interface RustTarget {
    id: string;
    package: RustPackage;
    kind: RustTargetKind;
    name: string;
    crateName: string;
    file: string;
    requiredFeatures: string[];
    procMacro: boolean;
    harness: boolean;
    gaps: string[];
    proof: Evidence[];
}
export interface RustCompilation {
    id: string;
    target: RustTarget;
    invocation: string;
    environment: RustCfgEnvironment;
    features?: Set<string>;
    activeDependencies: Set<string>;
    dependencyFeatures: Map<string, Set<string>>;
    gaps: string[];
    proof: Evidence[];
    dependencies: Map<string, {
        dependency: RustDependency;
        active: RustTruth;
        compilation?: RustCompilation;
        gaps: string[];
    }>;
    selected: RustTruth;
}
type Table = Record<string, unknown>;
const table = (value: unknown): Table => value && typeof value === 'object' && !Array.isArray(value) ? value as Table : {};
const strings = (value: unknown): string[] | undefined => Array.isArray(value) && value.length <= 2048 && value.every(v => typeof v === 'string' && v.length <= 2048) ? value as string[] : undefined;
const name = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
const inside = (root: string, file: string) => root === '.' || file === root || file.startsWith(root + '/');
const depth = (root: string) => root === '.' ? 0 : root.split('/').length;
export function rustPath(base: string, value: string): string | undefined {
    if (!value || value.length > 2048 || /[\\\0]/.test(value) || path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value))
        return;
    const result = path.posix.normalize(path.posix.join(base, value));
    return result === '..' || result.startsWith('../') ? undefined : result;
}
// Cargo requirements are comma-conjoined, with an implicit caret for bare versions.
export function cargoRequirement(value: string): string | undefined {
    if (value.length > 256 || !/^\s*(?:[~^=<>]*\s*)?[0-9*][0-9A-Za-z.*+\-]*(?:\s*,\s*[~^=<>]*\s*[0-9*][0-9A-Za-z.*+\-]*)*\s*$/.test(value))
        return;
    const pieces = value.split(',').map(p => p.trim().replace(/\s+/g, '')), normalized = pieces.map(p => /^\d/.test(p) && !p.includes('*') ? '^' + p : p).join(' ');
    return validRange(normalized) ?? undefined;
}
/** Indexed Cargo inputs only. No cargo metadata, rustc, build scripts, registry,
 * proc macros, environment, restored artifacts or generated files are consulted. */
export class RustProjects {
    readonly packages: RustPackage[] = [];
    readonly compilations: RustCompilation[] = [];
    readonly sources: IndexedSources;
    private readonly manifests = new Map<string, {
        file: string;
        raw: Table;
        gaps: string[];
    }>();
    private readonly observed: Set<string>;
    constructor(readonly context: AnalysisContext) {
        this.sources = context.sources ??= new IndexedSources(context);
        this.observed = new Set([...context.files.keys(), ...context.fileInventory ?? []]);
        for (const file of [...this.observed].filter(f => path.posix.basename(f) === 'Cargo.toml').sort()) {
            const text = this.sources.readFile(file);
            let raw: Table = {}, gaps: string[] = [];
            try {
                if (text === undefined)
                    throw new Error('Cargo manifest is denied/unavailable');
                raw = table(parseToml(text));
            }
            catch {
                gaps.push('Original Cargo manifest is malformed/denied/unavailable');
            }
            if (!gaps.length && !Object.keys(table(raw.package)).length && !Object.keys(table(raw.workspace)).length)
                gaps.push('Cargo manifest lacks a reviewed package/workspace model');
            this.manifests.set(path.posix.dirname(file), { file, raw, gaps });
        }
        for (const [root, manifest] of this.manifests)
            if (Object.keys(table(manifest.raw.package)).length) {
                if (this.packages.length >= 512) {
                    manifest.gaps.push('Cargo package inventory budget exceeded');
                    continue;
                }
                this.package(root, manifest);
            }
        for (const pkg of this.packages)
            this.targets(pkg);
        for (const pkg of this.packages)
            for (const dep of pkg.dependencies)
                if (dep.path && !dep.renamed) {
                    const library = this.packages.find(p => p.root === dep.path)?.targets.find(t => t.kind === 'lib');
                    if (library)
                        dep.name = library.crateName;
                }
        // Root selections are separate invocations. Dependency feature unification
        // occurs within each invocation; sibling applications never share features.
        for (const pkg of this.packages) {
            const app = applicationAt(context.config.applications, pkg.root), config = app?.rust ?? {};
            const selected = config.package && rustPath(app?.path ?? pkg.root, config.package);
            if (config.package && selected !== pkg.manifest)
                continue;
            for (const target of pkg.targets) {
                if (config.target && (config.target.kind !== target.kind || config.target.name !== target.name))
                    continue;
                if (['test', 'bench'].includes(target.kind) && !config.includeTests && config.target?.kind !== target.kind)
                    continue;
                this.invocation(target, config);
            }
            if (config.target && !pkg.targets.some(target => target.kind === config.target!.kind && target.name === config.target!.name))
                pkg.gaps.push('Recorded Rust target is not an original Cargo target');
        }
    }
    private fact(file: string, message: string): Evidence[] { return [evidence('filesystem', 'rust-imports', file, 1, message)]; }
    private workspace(root: string, raw: Table): {
        root: string;
        raw: Table;
        gaps: string[];
    } | undefined {
        const explicit = table(raw.package).workspace;
        const candidates = [...this.manifests].filter(([directory, m]) => Object.keys(table(m.raw.workspace)).length && (typeof explicit === 'string' ? rustPath(root, explicit) === directory : inside(directory, root))).sort(([a], [b]) => depth(b) - depth(a));
        if (!candidates.length)
            return;
        const [directory, manifest] = candidates[0]!, workspace = table(manifest.raw.workspace), gaps = [...manifest.gaps], members = strings(workspace.members), exclude = strings(workspace.exclude) ?? [];
        if (workspace.members !== undefined && !members || workspace.exclude !== undefined && !strings(workspace.exclude))
            gaps.push('Malformed Cargo workspace membership');
        const relative = path.posix.relative(directory, root), excluded = exclude.some(pattern => matchesGlob(relative, pattern));
        if (excluded) {
            if (explicit !== undefined)
                gaps.push('Recorded package workspace excludes the original package');
            else
                return;
        }
        if (directory !== root && !excluded && !members?.some(pattern => matchesGlob(relative, pattern))) {
            // Only a declared path-dependency chain from members implicitly adds a package.
            const reached = new Set<string>([directory, ...[...this.manifests.keys()].filter(r => members?.some(pattern => matchesGlob(path.posix.relative(directory, r), pattern)))]);
            for (let round = 0; round < 128; round++) {
                const before = reached.size;
                for (const r of [...reached]) {
                    const member = this.manifests.get(r)?.raw, groups = [member, ...Object.values(table(member?.target)).map(table)];
                    for (const group of groups)
                        for (const field of ['dependencies', 'dev-dependencies', 'build-dependencies'])
                            for (const [key, dep] of Object.entries(table(group?.[field]))) {
                                const inherited = table(dep).workspace === true, definition = inherited ? table(table(workspace.dependencies)[key]) : table(dep), p = definition.path;
                                if (typeof p === 'string') {
                                    const local = rustPath(inherited ? directory : r, p);
                                    if (local && inside(directory, local) && !exclude.some(pattern => matchesGlob(path.posix.relative(directory, local), pattern)))
                                        reached.add(local);
                                }
                            }
                }
                if (reached.size === before)
                    break;
            }
            if (!reached.has(root))
                gaps.push('Package is under a Cargo workspace but is not a declared/implicit member');
        }
        for (const member of members ?? [])
            if (!/[*?\[]/.test(member) && !this.manifests.has(rustPath(directory, member) ?? '<outside>'))
                gaps.push(`Declared Cargo workspace member is denied/unavailable: ${member}`);
        return { root: directory, raw: manifest.raw, gaps };
    }
    private package(root: string, manifest: {
        file: string;
        raw: Table;
        gaps: string[];
    }): void {
        const raw = manifest.raw, p = table(raw.package), workspace = this.workspace(root, raw), gaps = [...manifest.gaps, ...workspace?.gaps ?? []];
        if(p.workspace!==undefined&&typeof p.workspace!=='string')gaps.push('Invalid Cargo package.workspace path');
        if (p.workspace !== undefined && !workspace)
            gaps.push('Original package.workspace points at an unavailable/excluded workspace');
        const inherited = (key: string, fallback?: unknown) => { const value = p[key]; if (table(value).workspace === true) {
            const selected = table(table(workspace?.raw.workspace).package)[key];
            if (selected === undefined)
                gaps.push(`Unavailable Cargo workspace.package.${key}`);
            return selected;
        } return value ?? fallback; };
        const packageName = name(p.name);
        if (!packageName)
            gaps.push('Invalid/missing original Cargo package name');
        const version = inherited('version', '0.0.0'), edition = inherited('edition', '2015'), resolver = table(workspace?.raw.workspace).resolver ?? raw.resolver ?? p.resolver ?? (edition === '2024' ? '3' : edition === '2021' ? '2' : '1');
        if (typeof version !== 'string' || !valid(version))
            gaps.push('Unavailable/invalid original Cargo package version');
        if (typeof edition!=='string'||!['2015', '2018', '2021', '2024'].includes(edition))
            gaps.push('Unreviewed Rust edition');
        if (typeof resolver!=='string'||!['1', '2', '3'].includes(resolver))
            gaps.push('Unreviewed Cargo feature resolver');
        if (workspace && !table(workspace.raw.package).name && table(workspace.raw.workspace).resolver === undefined)
            gaps.push('Virtual Cargo workspace requires an explicit resolver');
        if (raw.patch !== undefined || raw.replace !== undefined || workspace?.raw.patch !== undefined || workspace?.raw.replace !== undefined)
            gaps.push('Cargo patch/replace changes dependency sources; a reviewed effective model is required');
        if (raw['cargo-features'] !== undefined)
            gaps.push('Unreviewed Cargo unstable manifest features');
        const build = p.build;
        if (build !== false && (build !== undefined || this.observed.has(path.posix.join(root, 'build.rs'))))
            gaps.push('Cargo build script can generate source/cfg/extern inputs; execution is unavailable');
        if (p.links !== undefined)
            gaps.push('Native links/build-script compilation inputs are unavailable');
        const configuration: RustPackage['configuration'] = [];
        for (let directory = root;; directory = path.posix.dirname(directory)) {
            const candidates = ['.cargo/config', '.cargo/config.toml'].map(file => path.posix.join(directory, file)).filter(file => this.observed.has(file));
            if (!candidates.length && this.context.directoryInventory?.has(path.posix.join(directory, '.cargo')) && !this.sources.directoryExists(path.posix.join(directory, '.cargo')))
                gaps.push('Indexed/denied Cargo configuration requires a reviewed effective compilation/source profile');
            for (const file of candidates) {
                let inputs: Table | undefined;
                try {
                    const content = this.sources.readFile(file);
                    if (content === undefined)
                        throw new Error('denied');
                    inputs = table(parseToml(content));
                }
                catch { /* Denied/malformed configuration cannot prove source neutrality. */ }
                const neutral = !!inputs && Object.keys(inputs).every(key => ['alias', 'resolver'].includes(key)) && ['alias','resolver'].every(key=>inputs![key]===undefined||!!inputs![key]&&typeof inputs![key]==='object'&&!Array.isArray(inputs![key])) && Object.values(table(inputs.alias)).every(value => typeof value === 'string' || strings(value) !== undefined) && Object.keys(table(inputs.resolver)).every(key => key === 'incompatible-rust-versions') && (table(inputs.resolver)['incompatible-rust-versions'] === undefined || ['allow', 'fallback'].includes(String(table(inputs.resolver)['incompatible-rust-versions']))) && candidates.length === 1;
                const reasons = neutral ? [] : ['Indexed/denied Cargo configuration requires a reviewed effective compilation/source profile'];
                configuration.push({ file, status: neutral ? 'source-neutral' : 'unsupported', ...(inputs ? { inputs } : {}), gaps: reasons, proof: this.fact(file, neutral ? 'Original literal aliases/registry Rust-version selection do not change source crate names/modules; binary resolution is unavailable' : 'Unreviewed/denied original Cargo configuration') });
                gaps.push(...reasons);
            }
            if (directory === '.')
                break;
        }
        for (const flag of ['autolib', 'autobins', 'autotests', 'autoexamples', 'autobenches'])
            if (p[flag] !== undefined && typeof p[flag] !== 'boolean')
                gaps.push(`Invalid Cargo ${flag} discovery flag`);
        if (raw.features !== undefined && !Object.keys(table(raw.features)).length && typeof raw.features !== 'object')
            gaps.push('Invalid Cargo feature table');
        const features: Record<string, string[]> = {};
        for (const [key, value] of Object.entries(table(raw.features))) {
            const values = strings(value);
            if (!values)
                gaps.push(`Malformed Cargo feature ${key}`);
            else
                features[key] = values;
        }
        const pkg: RustPackage = { id: this.context.graph.id('project', 'rust', root), root, manifest: manifest.file, name: packageName ?? '<unresolved>', ...(typeof version === 'string' ? { version } : {}), edition: String(edition), resolver: String(resolver), ...(workspace ? { workspace: workspace.root } : {}), configuration, features, dependencies: [], targets: [], gaps, proof: this.fact(manifest.file, 'Original Cargo package/workspace/edition/target inputs; no target tools run') };
        this.packages.push(pkg);
        const readDependencies = (values: unknown, scope: RustDependency['scope'], condition?: string) => {
            for (const [key, input] of Object.entries(table(values))) {
                let value = typeof input === 'string' ? { version: input } : table(input), base = root;
                if (value.workspace === true) {
                    const shared = table(table(workspace?.raw.workspace).dependencies)[key];
                    if (shared === undefined) {
                        gaps.push(`Unavailable workspace dependency ${key}`);
                        continue;
                    }
                    const inherited = typeof shared === 'string' ? { version: shared } : table(shared);
                    if (Object.keys(value).some(field => !['workspace', 'optional', 'features', 'default-features'].includes(field)) || inherited.optional !== undefined)
                        gaps.push(`Invalid inherited workspace dependency fields of ${key}`);
                    const extra = strings(value.features) ?? [];
                    if (value['default-features'] === false && inherited['default-features'] !== false)
                        gaps.push(`Member cannot disable inherited default features of ${key}`);
                    value = { ...inherited, ...value, features: [...strings(inherited.features) ?? [], ...extra] };
                    delete value.workspace;
                    base = workspace!.root;
                }
                const depGaps: string[] = [];
                if (!name(key))
                    depGaps.push('Invalid Cargo dependency alias');
                if (value.package !== undefined && !name(value.package))
                    depGaps.push('Invalid Cargo dependency package identity');
                if (scope !== 'normal' && value.optional === true)
                    depGaps.push('Cargo dev/build dependencies cannot be optional');
                for (const field of ['git', 'branch', 'tag', 'rev', 'registry'])
                    if (value[field] !== undefined && (typeof value[field] !== 'string' || !String(value[field]).length || String(value[field]).length > 2048 || /[\0\r\n]/.test(String(value[field]))))
                        depGaps.push(`Invalid Cargo ${field} source identity`);
                if (['branch', 'tag', 'rev'].filter(field => value[field] !== undefined).length > 1 || value.git === undefined && ['branch', 'tag', 'rev'].some(field => value[field] !== undefined))
                    depGaps.push('Competing/unattached Cargo Git source selectors');
                const packageName = name(value.package ?? key) ?? key, features = strings(value.features) ?? [];
                if (value.features !== undefined && !strings(value.features))
                    depGaps.push('Opaque dependency feature request');
                if (value.optional !== undefined && typeof value.optional !== 'boolean' || value['default-features'] !== undefined && typeof value['default-features'] !== 'boolean')
                    depGaps.push('Invalid dependency activation flags');
                if (Object.keys(value).some(field => !['path', 'version', 'package', 'optional', 'default-features', 'features', 'git', 'branch', 'tag', 'rev', 'registry', 'workspace', 'public'].includes(field)))
                    depGaps.push('Unreviewed Cargo dependency fields');
                let local: string | undefined;
                if (value.path !== undefined) {
                    if (typeof value.path === 'string')
                        local = rustPath(base, value.path);
                    if (!local)
                        depGaps.push('Cargo dependency path is outside/nonportable/unavailable');
                }
                const version = typeof value.version === 'string' ? value.version : undefined;
                if (value.version !== undefined && (!version || !cargoRequirement(version)))
                    depGaps.push('Unreviewed Cargo version requirement');
                if (value.git !== undefined && value.path !== undefined)
                    depGaps.push('Competing Cargo git/path dependency identity');
                if (local && value.registry !== undefined)
                    depGaps.push('Competing Cargo path/registry source identity');
                if (!local && !version && value.git === undefined)
                    depGaps.push('Dependency lacks a reviewed source identity');
                pkg.dependencies.push({ key, name: key.replaceAll('-', '_'), renamed: value.package !== undefined && key !== packageName, package: packageName, ...(local ? { path: local } : {}), ...(version ? { version } : {}), source: local ? 'path' : value.git !== undefined ? 'git' : 'registry', sourceId: local ?? (value.git !== undefined ? JSON.stringify([value.git, value.branch, value.tag, value.rev]) : String(value.registry ?? 'crates-io')), optional: value.optional === true, defaultFeatures: value['default-features'] !== false, features, scope, ...(condition ? { condition } : {}), gaps: depGaps, proof: this.fact(manifest.file, `Original ${scope} Cargo dependency ${key} (${packageName})${condition ? ' under ' + condition : ''}`) });
            }
        };
        readDependencies(raw.dependencies, 'normal');
        readDependencies(raw['dev-dependencies'], 'dev');
        readDependencies(raw['build-dependencies'], 'build');
        for (const [condition, value] of Object.entries(table(raw.target))) {
            const target = table(value);
            readDependencies(target.dependencies, 'normal', condition);
            readDependencies(target['dev-dependencies'], 'dev', condition);
            readDependencies(target['build-dependencies'], 'build', condition);
        }
        if (pkg.resolver === '1' && pkg.dependencies.some(dep => dep.scope !== 'normal' || dep.condition))
            gaps.push('Resolver 1 build/dev/platform feature unification requires a reviewed invocation profile');
        const hidden = new Set(Object.values(features).flat().filter(f => f.startsWith('dep:')).map(f => f.slice(4)));
        for (const dep of pkg.dependencies.filter(dep => dep.optional))
            if (!(dep.key in features) && !hidden.has(dep.key))
                features[dep.key] = ['dep:' + dep.key];
    }
    private targets(pkg: RustPackage): void {
        const raw = this.manifests.get(pkg.root)!.raw, p = table(raw.package), manual = ['lib', 'bin', 'test', 'example', 'bench'].some(key => raw[key] !== undefined), autoDefault = pkg.edition !== '2015' || !manual;
        const add = (kind: RustTargetKind, nameValue: string, file: string, options: Table = {}, explicit = false) => {
            if (pkg.targets.length >= 512) {
                if (!pkg.gaps.includes('Cargo target inventory budget exceeded'))
                    pkg.gaps.push('Cargo target inventory budget exceeded');
                return;
            }
            const targetName = name(nameValue), selectedPath = rustPath(pkg.root, file);
            if (!targetName || !selectedPath) {
                pkg.gaps.push('Invalid/nonportable Cargo target name/path');
                return;
            }
            const gaps: string[] = [], required = strings(options['required-features']) ?? [];
            for(const field of ['name','path','edition'])if(options[field]!==undefined&&typeof options[field]!=='string')gaps.push(`Invalid Cargo target ${field}`);
            for(const field of ['proc-macro','harness','test','bench','doc','doctest'])if(options[field]!==undefined&&typeof options[field]!=='boolean')gaps.push(`Invalid Cargo target ${field}`);
            if (options['required-features'] !== undefined && !strings(options['required-features']))
                gaps.push('Invalid Cargo required-features');
            const crateName = targetName.replaceAll('-', '_');
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(crateName))
                gaps.push('Unreviewed Cargo crate identifier');
            if (kind === 'lib' && targetName.includes('-'))
                gaps.push('Cargo library target names cannot contain hyphens');
            if (options.edition !== undefined && options.edition !== pkg.edition)
                gaps.push('Per-target Rust edition override needs its own compilation profile');
            if (options.harness === false && ['test', 'bench'].includes(kind))
                gaps.push('Nonstandard test/bench harness cfg behavior requires a reviewed profile');
            if (options['proc-macro'] === true)
                gaps.push('Proc-macro target exports/generated behavior are unavailable');
            const previous = pkg.targets.find(t => t.kind === kind && t.name === targetName);
            if (previous) {
                if (explicit || previous.file !== selectedPath)
                    previous.gaps.push('Competing original Cargo targets with the same name');
                return;
            }
            pkg.targets.push({ id: this.context.graph.id('crate', 'rust', pkg.id, kind, targetName), package: pkg, kind, name: targetName, crateName, file: selectedPath, requiredFeatures: required, procMacro: options['proc-macro'] === true, harness: options.harness !== false, gaps, proof: this.fact(pkg.manifest, `Original Cargo ${kind} target ${targetName} at ${selectedPath}`) });
        };
        const lib = table(raw.lib);
        if(raw.lib!==undefined&&(!raw.lib||typeof raw.lib!=='object'||Array.isArray(raw.lib)))pkg.gaps.push('Invalid Cargo library target table');
        if (raw.lib !== undefined)
            add('lib', String(lib.name ?? pkg.name.replaceAll('-', '_')), String(lib.path ?? 'src/lib.rs'), lib, true);
        else if (p.autolib !== false && this.observed.has(path.posix.join(pkg.root, 'src/lib.rs')))
            add('lib', pkg.name.replaceAll('-', '_'), 'src/lib.rs');
        for (const kind of ['bin', 'test', 'example', 'bench'] as const) {
            const values = raw[kind];
            if (values !== undefined && !Array.isArray(values)) {
                pkg.gaps.push(`Invalid Cargo ${kind} target list`);
                continue;
            }
            const directory = kind === 'bin' ? 'src/bin' : kind === 'test' ? 'tests' : kind === 'example' ? 'examples' : 'benches';
            for (const value of Array.isArray(values) ? values : []) {
                const item = table(value), targetName = name(item.name);
                if (!targetName) {
                    pkg.gaps.push('Cargo explicit target lacks a name');
                    continue;
                }
                let file = typeof item.path === 'string' ? item.path : undefined;
                if (!file) {
                    const candidates = kind === 'bin' && targetName === pkg.name ? ['src/main.rs', `${directory}/${targetName}.rs`, `${directory}/${targetName}/main.rs`] : [`${directory}/${targetName}.rs`, `${directory}/${targetName}/main.rs`], found = candidates.filter(f => this.observed.has(path.posix.join(pkg.root, f)));
                    if (found.length !== 1) {
                        pkg.gaps.push(`Original Cargo target path is missing/ambiguous: ${targetName}`);
                        file = candidates[0];
                    }
                    else
                        file = found[0];
                }
                add(kind, targetName, file!, item, true);
            }
            const manualNames = new Set(pkg.targets.filter(t => t.kind === kind).map(t => t.name));
            const autoKey = kind === 'bin' ? 'autobins' : kind === 'test' ? 'autotests' : kind === 'example' ? 'autoexamples' : 'autobenches';
            if (p[autoKey] === false || p[autoKey] === undefined && !autoDefault)
                continue;
            if (kind === 'bin' && this.observed.has(path.posix.join(pkg.root, 'src/main.rs')) && !pkg.targets.some(t => t.kind === 'bin' && t.name === pkg.name))
                add('bin', pkg.name, 'src/main.rs');
            const prefix = path.posix.join(pkg.root, directory) + '/';
            for (const file of [...this.observed].sort().filter(f => f.startsWith(prefix))) {
                const relative = file.slice(prefix.length), match = /^([^/]+)\.rs$/.exec(relative) ?? /^([^/]+)\/main\.rs$/.exec(relative);
                if (!match || manualNames.has(match[1]!))
                    continue;
                add(kind, match[1]!, path.posix.relative(pkg.root, file));
            }
        }
        if (pkg.targets.filter(t => t.kind === 'lib').length > 1)
            pkg.gaps.push('Cargo package has competing library targets');
    }
    private featureSet(pkg: RustPackage, requested: Set<string>, defaults: boolean): {
        features: Set<string>;
        deps: Set<string>;
        extra: Map<string, Set<string>>;
        gaps: string[];
    } {
        const features = new Set<string>([...requested, ...defaults && pkg.features.default ? ['default'] : []]), deps = new Set<string>(), extra = new Map<string, Set<string>>(), gaps: string[] = [];
        for (let round = 0; round < 128; round++) {
            const before = JSON.stringify([[...features], [...deps], [...extra].map(([k, v]) => [k, [...v]])]);
            for (const feature of [...features]) {
                const values = pkg.features[feature];
                if (!values) {
                    if (!gaps.includes(`Unavailable Cargo feature ${feature}`))
                        gaps.push(`Unavailable Cargo feature ${feature}`);
                    continue;
                }
                for (const value of values) {
                    if (value.startsWith('dep:')) {
                        const key = value.slice(4), known = pkg.dependencies.find(d => d.key === key && d.optional);
                        if (known)
                            deps.add(known.name);
                        else
                            gaps.push(`Unavailable optional dependency feature ${value}`);
                    }
                    else if (value.includes('/')) {
                        const [head, tail, ...rest] = value.split('/');
                        if (!head || !tail || rest.length) {
                            gaps.push(`Invalid Cargo dependency feature ${value}`);
                            continue;
                        }
                        const weak = head.endsWith('?'), key = weak ? head.slice(0, -1) : head, known = pkg.dependencies.find(d => d.key === key);
                        if (!known) {
                            gaps.push(`Unavailable dependency feature ${value}`);
                            continue;
                        }
                        const dep = known.name;
                        if (!weak || !known.optional || deps.has(dep)) {
                            if (!weak)
                                deps.add(dep);
                            const entries = extra.get(dep) ?? new Set<string>();
                            entries.add(tail);
                            extra.set(dep, entries);
                        }
                    }
                    else
                        features.add(value);
                }
            }
            if (JSON.stringify([[...features], [...deps], [...extra].map(([k, v]) => [k, [...v]])]) === before)
                return { features, deps, extra, gaps: [...new Set(gaps)] };
        }
        return { features, deps, extra, gaps: [...new Set([...gaps, 'Cargo feature expansion budget exceeded'])] };
    }
    private invocation(target: RustTarget, config: RustConfig): void {
        if (this.compilations.length >= 30000) {
            if (!target.package.gaps.includes('Cargo compilation inventory budget exceeded'))
                target.package.gaps.push('Cargo compilation inventory budget exceeded');
            return;
        }
        const pkg = target.package, rootKnown = config.features !== undefined && config.defaultFeatures !== undefined, requests = new Map<RustPackage, {
            features: Set<string>;
            defaults: boolean;
            known: boolean;
        }>(), states = new Map<RustPackage, ReturnType<RustProjects['featureSet']>>();
        requests.set(pkg, { features: new Set(config.features ?? []), defaults: config.defaultFeatures === true, known: rootKnown });
        const test = ['test', 'bench'].includes(target.kind), env: RustCfgEnvironment = { ...(config.cfg ? { cfg: config.cfg } : {}), ...(config.targetTriple ? { targetTriple: config.targetTriple } : {}), test };
        for (let round = 0; round < 128; round++) {
            let changed = false;
            for (const [package_, request] of [...requests]) {
                const state = this.featureSet(package_, request.features, request.defaults);
                states.set(package_, state);
                for (const dep of package_.dependencies.filter(d => d.scope === 'normal' || package_ === pkg && ['test', 'bench', 'example'].includes(target.kind) && d.scope === 'dev')) {
                    const active = dep.optional ? (request.known ? state.deps.has(dep.name) : 'unknown') : true, condition = dep.condition ? this.condition(dep.condition, { ...env, ...request.known ? { features: state.features } : {} }) : true;
                    if (active === false || condition === false || !dep.path)
                        continue;
                    const local = this.packages.find(p => p.root === dep.path);
                    if (!local)
                        continue;
                    const old = requests.get(local), features = new Set([...old?.features ?? [], ...dep.features, ...state.extra.get(dep.name) ?? []]), defaults = old?.defaults || dep.defaultFeatures, known = (old?.known ?? true) && request.known && active === true && condition === true;
                    if (!old || old.defaults !== defaults || old.known !== known || JSON.stringify([...old.features].sort()) !== JSON.stringify([...features].sort())) {
                        requests.set(local, { features, defaults, known });
                        changed = true;
                    }
                }
            }
            if (!changed)
                break;
            if (round === 127)
                pkg.gaps.push('Cargo dependency/feature unification budget exceeded');
        }
        const invocation = this.context.graph.id('rust-invocation', target.id, JSON.stringify(config)), comps = new Map<RustPackage, RustCompilation>();
        for (const [package_, request] of requests) {
            const selectedTarget = package_ === pkg ? target : package_.targets.find(t => t.kind === 'lib');
            if (!selectedTarget)
                continue;
            const state = states.get(package_) ?? this.featureSet(package_, request.features, request.defaults), features = request.known ? state.features : undefined;
            const compilation: RustCompilation = { id: this.context.graph.id('rust-compilation', invocation, selectedTarget.id), target: selectedTarget, invocation, environment: { ...env, test: package_ === pkg ? test : false, ...features ? { features } : {} }, ...(features ? { features } : {}), activeDependencies: state.deps, dependencyFeatures: state.extra, gaps: [...package_.gaps, ...selectedTarget.gaps, ...request.known ? state.gaps : []], proof: [...pkg.proof, ...selectedTarget.proof], dependencies: new Map(), selected: selectedTarget.requiredFeatures.length ? features ? selectedTarget.requiredFeatures.every(f => features.has(f)) : 'unknown' : true };
            comps.set(package_, compilation);
            this.compilations.push(compilation);
        }
        for (const [package_, comp] of comps) {
            for (const dep of package_.dependencies.filter(d => d.scope === 'normal' || package_ === pkg && ['test', 'bench', 'example'].includes(target.kind) && d.scope === 'dev')) {
                const optional: RustTruth = dep.optional ? comp.features ? comp.activeDependencies.has(dep.name) : 'unknown' : true, condition = dep.condition ? this.condition(dep.condition, comp.environment) : true, active: RustTruth = optional === false || condition === false ? false : optional === 'unknown' || condition === 'unknown' ? 'unknown' : true;
                const local = dep.path && this.packages.find(p => p.root === dep.path), dependency = local ? comps.get(local) : undefined, gaps = [...dep.gaps];
                if (dep.path && !local)
                    gaps.push('Declared Cargo path dependency has no indexed package manifest');
                if (local && local.name !== dep.package)
                    gaps.push('Original path dependency package identity does not match');
                if (local && dep.version && (!local.version || !satisfies(local.version, cargoRequirement(dep.version) ?? '<0.0.0')))
                    gaps.push('Original path package version does not satisfy the Cargo requirement');
                if (local && !dependency)
                    gaps.push('Cargo path dependency lacks an indexed library target');
                if (dependency?.target.procMacro)
                    gaps.push('Proc-macro dependency exports are unavailable');
                const previous = comp.dependencies.get(dep.name);
                if (previous && active !== false && previous.active !== false) {
                    const same = previous.dependency.package === dep.package && previous.dependency.path === dep.path && previous.dependency.source === dep.source && previous.dependency.sourceId === dep.sourceId && previous.dependency.version === dep.version && previous.compilation?.target.id === dependency?.target.id;
                    if (same) {
                        previous.gaps.push(...gaps);
                        if (previous.active === 'unknown' || active === 'unknown')
                            previous.active = 'unknown';
                        continue;
                    }
                    gaps.push('Competing active Cargo dependency aliases');
                    previous.gaps.push('Competing active Cargo dependency aliases');
                }
                if (active !== false || !comp.dependencies.has(dep.name))
                    comp.dependencies.set(dep.name, { dependency: dep, active, ...dependency ? { compilation: dependency } : {}, gaps });
            }
            // A binary/example/test/bench can name the package's original library as
            // an external crate. Its private items still cross a crate boundary.
            if (package_ === pkg && target.kind !== 'lib') {
                const lib = pkg.targets.find(t => t.kind === 'lib');
                if (lib) {
                    const original = comps.get(pkg)!;
                    const library: RustCompilation = { ...original, id: this.context.graph.id('rust-compilation', invocation, lib.id), target: lib, environment: { ...original.environment, test: false }, gaps: [...pkg.gaps, ...lib.gaps], selected: lib.requiredFeatures.length ? original.features ? lib.requiredFeatures.every(f => original.features!.has(f)) : 'unknown' : true, dependencies: new Map([...original.dependencies].filter(([, d]) => d.dependency.scope === 'normal')) };
                    this.compilations.push(library);
                    comp.dependencies.set(lib.crateName, { dependency: { key: lib.crateName, name: lib.crateName, renamed: false, package: pkg.name, path: pkg.root, source: 'path', optional: false, defaultFeatures: true, features: [], scope: 'normal', gaps: [], proof: lib.proof }, active: library.selected, compilation: library, gaps: [] });
                }
            }
        }
        const cycles = (comp: RustCompilation, trail: Set<string>, visited: Set<string>): boolean => { if (trail.has(comp.id))
            return true; if (visited.has(comp.id))
            return false; visited.add(comp.id); if (visited.size > 2048)
            return true; const next = new Set(trail); next.add(comp.id); return [...comp.dependencies.values()].some(d => d.active !== false && d.compilation && cycles(d.compilation, next, visited)); };
        for (const comp of this.compilations.filter(c => c.invocation === invocation))
            if (cycles(comp, new Set(), new Set()))
                comp.gaps.push('Cyclic/budgeted Cargo path dependency graph cannot certify a compilation');
    }
    private condition(condition: string, environment: RustCfgEnvironment): RustTruth { const match = /^cfg\(([\s\S]*)\)$/.exec(condition); if (!match)
        return environment.targetTriple ? condition === environment.targetTriple : 'unknown'; if (/\b(?:feature|test|debug_assertions|proc_macro)\b/.test(match[1]!))
        return 'unknown'; return rustCfg(match[1]!, environment); }
    describe() { return this.packages.map(pkg => ({ id: pkg.id, root: pkg.root, manifest: pkg.manifest, name: pkg.name, version: pkg.version, edition: pkg.edition, workspace: pkg.workspace, resolver: pkg.resolver, configuration: pkg.configuration, features: pkg.features, dependencies: pkg.dependencies, targets: pkg.targets.map(({ package: _, ...target }) => target), gaps: pkg.gaps, proof: pkg.proof })); }
    describeManifests() { return [...this.manifests.values()].map(m => ({ file: m.file, status: m.gaps.length ? 'failed' : Object.keys(table(m.raw.package)).length ? 'package' : Object.keys(table(m.raw.workspace)).length ? 'workspace' : 'unsupported', gaps: m.gaps })); }
    describeCompilations() { return this.compilations.map(c => ({ id: c.id, invocation: c.invocation, target: c.target.id, package: c.target.package.id, kind: c.target.kind, crateName: c.target.crateName, file: c.target.file, features: c.features ? [...c.features].sort() : null, cfg: c.environment.cfg ?? null, targetTriple: c.environment.targetTriple ?? null, test: c.environment.test, selected: c.selected, gaps: c.gaps, dependencies: [...c.dependencies].map(([name, d]) => ({ name, active: d.active, target: d.compilation?.id, gaps: d.gaps, proof: d.dependency.proof })) })); }
}
