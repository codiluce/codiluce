import path from 'node:path';
import type { AnalysisContext } from '../../core/analyzer.js';
import type { ApplicationConfig, DotnetConfig } from '../../core/config.js';
import { evidence, type Evidence } from '../../core/graph.js';
import { IndexedSources } from '../indexed-sources.js';
import { SourceText } from '../source-map.js';
import type { CsharpImportFact } from '../facts.js';
import type { XmlNode } from './jvm-manifest.js';
import { dotnetGlob, dotnetGlobWithinDirectory, dotnetCoveredDirectory, dotnetTargetCompatible, dotnetPath, msbuildCondition, readMsbuildXml } from './dotnet-data.js';
export const DOTNET_PROJECT_VERSION = '1';
export interface DotnetProject {
    id: string;
    directory: string;
    sdk?: string;
    targetFramework?: string;
    properties: Record<string, string>;
    sources: string[];
    references: string[];
    using: {
        fact: CsharpImportFact;
        file: string;
        proof: Evidence[];
    }[];
    dependencies: {
        name: string;
        version?: string;
        kind: string;
    }[];
    proof: Evidence[];
    gaps: string[];
    blockers: string[];
}
interface RawItems {
    node: XmlNode;
    file: string;
}
interface ItemAction {
    end?: number;
    kind: string;
    attributes: Record<string, string>;
    metadata: Record<string, string>;
    file: string;
    start: number;
}
const REPOSITORY = '/@codiluce-repository/';
const originalPath = (root: string, value: string, glob = false) => value.startsWith(REPOSITORY) ? dotnetPath('.', value.slice(REPOSITORY.length), glob) : dotnetPath(root, value, glob);
const under = (file: string, directory: string) => directory === '.' || file === directory || file.startsWith(directory + '/');
export class DotnetProjects {
    readonly projects: DotnetProject[] = [];
    readonly sources: IndexedSources;
    private readonly indexedDirectories = new Set(['.']);
    private readonly documents = new Map<string, XmlNode | undefined>();
    constructor(readonly context: AnalysisContext) {
        this.sources = context.sources ?? new IndexedSources(context);
        for (const source of context.files.keys()) {
            let directory = path.posix.dirname(source);
            while (!this.indexedDirectories.has(directory)) {
                this.indexedDirectories.add(directory);
                directory = path.posix.dirname(directory);
            }
        }
        const paths = [...context.files.keys()].filter(file => file.endsWith('.csproj')).sort();
        for (const file of paths.slice(0, 512))
            this.projects.push(this.readProject(file));
        for (const app of context.config.applications)
            if (app.sourceRoots?.csharp?.length && !paths.some(file => under(file, app.path))) {
                const roots = app.sourceRoots.csharp.map(root => dotnetPath(app.path, root)).filter((item): item is string => !!item);
                const sources = [...new Set([...context.files.keys(), ...context.fileInventory ?? []])].filter(file => file.endsWith('.cs') && roots.some(root => under(file, root))).sort();
                const blockers = [...context.directoryInventory ?? []].filter(directory => !this.indexedDirectories.has(directory) && roots.some(root => under(directory, root) || under(root, directory))).map(directory => 'Configured source inventory crosses a pruned directory/symlink boundary: ' + directory);
                this.projects.push({ id: 'configured:' + app.name, directory: app.path, properties: {}, sources, references: [], using: [], dependencies: [], gaps: ['Recorded source roots define an indexed source compilation; SDK/binary/generated declarations remain outside this contract'], blockers, proof: [{ ...evidence('filesystem', 'csharp-projects', app.path, undefined, 'Recorded sourceRoots.csharp compilation'), analyzerVersion: DOTNET_PROJECT_VERSION }] });
            }
        if (paths.length > 512)
            for (const project of this.projects)
                project.blockers.push('MSBuild project budget exceeded');
    }
    private app(file: string): ApplicationConfig | undefined { return [...this.context.config.applications].filter(app => under(file, app.path)).sort((a, b) => b.path.length - a.path.length)[0]; }
    private document(file: string): XmlNode | undefined {
        if (!this.documents.has(file)) {
            const text = this.sources.readFile(file);
            this.documents.set(file, text === undefined ? undefined : readMsbuildXml(text));
        }
        return this.documents.get(file);
    }
    private readProject(file: string): DotnetProject {
        const directory = path.posix.dirname(file), config = this.app(file)?.dotnet ?? {}, root = this.document(file), project: DotnetProject = { id: file, directory, properties: {}, sources: [], references: [], using: [], dependencies: [], gaps: [], blockers: [], proof: [] };
        if (!root) {
            project.blockers.push('Indexed, bounded MSBuild project XML is unavailable: ' + file);
            return project;
        }
        const properties = project.properties, locked = new Set<string>(), actions: ItemAction[] = [], rawItems: RawItems[] = [], included = new Set<string>(), exclusions: string[] = [];
        const set = (key: string, value: string, global = false) => {
            const normalized = key.toLowerCase();
            if (global || !locked.has(normalized))
                properties[normalized] = value;
            if (global)
                locked.add(normalized);
        };
        for (const [key, value] of Object.entries(config.properties ?? {}))
            set(key, value, true);
        for (const [key, value] of [['TargetFramework', config.targetFramework], ['Configuration', config.configuration], ['Platform', config.platform]] as const)
            if (value !== undefined)
                set(key, value, true);
        set('MSBuildProjectDirectory', REPOSITORY + (directory === '.' ? '' : directory), true);
        set('MSBuildProjectFullPath', REPOSITORY + file, true);
        set('MSBuildProjectName', path.posix.basename(file, '.csproj'), true);
        project.sdk = root.attributes?.Sdk;
        if (Object.keys(root.attributes ?? {}).some(key => !['Sdk', 'xmlns', 'ToolsVersion', 'DefaultTargets', 'InitialTargets'].includes(key)))
            project.blockers.push('Unreviewed MSBuild project attributes: ' + file);
        if (project.sdk && !['Microsoft.NET.Sdk', 'Microsoft.NET.Sdk.Web', 'Microsoft.NET.Sdk.Worker'].includes(project.sdk))
            project.blockers.push('Unreviewed SDK import: ' + project.sdk);
        const expand = (text: string, current: string): string | undefined => {
            if (text.length > 8192 || /\$\[|\$\([^)]*::|[@%]\(/.test(text))
                return;
            const missing: string[] = [];
            const result = text.replace(/\$\(([A-Za-z_][\w]*)\)/g, (_, key: string) => {
                const normalized = key.toLowerCase(), value = normalized === 'msbuildthisfiledirectory' ? REPOSITORY + (path.posix.dirname(current) === '.' ? '' : path.posix.dirname(current) + '/') : normalized === 'msbuildthisfilefullpath' ? REPOSITORY + current : properties[normalized];
                if (value === undefined)
                    missing.push(key);
                return value ?? '';
            });
            return missing.length || result.includes('$(') ? undefined : result;
        };
        const condition = (text: string | undefined, current: string): boolean | undefined => {
            const value = text === undefined ? undefined : expand(text, current);
            if (text !== undefined && value === undefined)
                return;
            return msbuildCondition(value, target => {
                const name = originalPath(directory, target);
                if (!name)
                    return;
                if (this.sources.fileExists(name) || this.sources.directoryExists(name))
                    return true;
                if (contextObserved(this.context, name))
                    return;
                return false;
            });
        };
        const visit = (current: string, stack: string[]) => {
            if (stack.length > 32 || stack.includes(current) || project.proof.length > 512) {
                project.blockers.push('Cyclic/oversized MSBuild import graph: ' + current);
                return;
            }
            const document = this.document(current), text = this.sources.readFile(current);
            if (!document || text === undefined) {
                project.blockers.push('Indexed imported MSBuild XML is unavailable: ' + current);
                return;
            }
            project.proof.push({ ...evidence('filesystem', 'csharp-projects', current, 1, 'Original MSBuild project/import data'), analyzerVersion: DOTNET_PROJECT_VERSION });
            const walk = (nodes: XmlNode[]) => {
                for (const node of nodes) {
                    if (node.name === 'ItemGroup') {
                        rawItems.push({ node, file: current });
                        continue;
                    }
                    const selected = condition(node.attributes?.Condition, current);
                    if (selected === false)
                        continue;
                    if (selected === undefined) {
                        project.blockers.push('Unselected/opaque MSBuild condition in ' + current + ': ' + node.attributes?.Condition);
                        continue;
                    }
                    if (node.name === 'PropertyGroup')
                        for (const property of node.children) {
                            const active = condition(property.attributes?.Condition, current);
                            if (active === false)
                                continue;
                            if (active === undefined) {
                                project.blockers.push('Unselected MSBuild property condition: ' + property.name + ' in ' + current);
                                continue;
                            }
                            const value = property.children.length ? undefined : expand(property.text.trim(), current);
                            if (value === undefined) {
                                project.blockers.push('Opaque/unavailable MSBuild property: ' + property.name + ' in ' + current);
                                continue;
                            }
                            if (/^MSBuild/i.test(property.name)) {
                                project.blockers.push('Reserved MSBuild property assignment in ' + current);
                                continue;
                            }
                            set(property.name, value);
                        }
                    else if (node.name === 'ImportGroup')
                        walk(node.children);
                    else if (node.name === 'Import') {
                        const target = expand(node.attributes?.Project ?? '', current), resolved = target === undefined ? undefined : originalPath(path.posix.dirname(current), target);
                        if (node.attributes?.Sdk || !resolved) {
                            project.blockers.push('Opaque/SDK/wildcard MSBuild import in ' + current);
                            continue;
                        }
                        visit(resolved, [...stack, current]);
                    }
                    else if (['Target', 'UsingTask', 'Choose', 'Sdk'].includes(node.name))
                        project.blockers.push('Executable/conditional/unreviewed MSBuild ' + node.name + ' in ' + current);
                    else if (node.name !== 'ProjectExtensions')
                        project.blockers.push('Unreviewed MSBuild element ' + node.name + ' in ' + current);
                }
            };
            walk(document.children);
        };
        const nearest = (name: string): string | undefined => {
            let parent = directory;
            while (true) {
                const candidate = path.posix.join(parent, name);
                if (this.context.files.has(candidate) || contextObserved(this.context, candidate))
                    return candidate;
                if (parent === '.')
                    return;
                parent = path.posix.dirname(parent);
            }
        };
        const directoryImport = (name: 'props' | 'targets') => {
            const enabled = properties['importdirectorybuild' + name], override = properties['directorybuild' + name + 'path'];
            if (enabled?.toLowerCase() === 'false')
                return;
            const target = override ? originalPath(directory, override) : nearest('Directory.Build.' + name);
            if (override && !target)
                project.blockers.push('Invalid Directory.Build.' + name + ' override');
            else if (target)
                visit(target, []);
        };
        // SDK props and targets are reviewed conventions, not host SDK imports.
        directoryImport('props');
        if (project.sdk)
            rawItems.push({ node: { name: 'SdkDefaults', text: '', children: [], start: 0 }, file });
        visit(file, []);
        directoryImport('targets');
        // MSBuild evaluates properties/imports before its source-ordered item pass.
        for (const { node, file: current } of rawItems) {
            if (node.name === 'SdkDefaults') {
                actions.push({ kind: 'SdkDefaults', attributes: {}, metadata: {}, file: current, start: 0 });
                continue;
            }
            const selected = condition(node.attributes?.Condition, current);
            if (selected === false)
                continue;
            if (selected === undefined) {
                project.blockers.push('Unselected MSBuild ItemGroup condition in ' + current);
                continue;
            }
            for (const item of node.children) {
                const active = condition(item.attributes?.Condition, current);
                if (active === false)
                    continue;
                if (active === undefined) {
                    project.blockers.push('Unselected MSBuild item condition: ' + item.name + ' in ' + current);
                    continue;
                }
                if (!['Compile', 'ProjectReference', 'Using', 'PackageReference', 'FrameworkReference', 'Reference'].includes(item.name)) {
                    project.gaps.push('Unmodeled MSBuild item ' + item.name + ' in ' + current);
                    continue;
                }
                const attributes: Record<string, string> = {}, metadata: Record<string, string> = {};
                let valid = true;
                for (const [key, value] of Object.entries(item.attributes ?? {})) {
                    if (key === 'Condition')
                        continue;
                    const expanded = expand(value, current);
                    if (expanded === undefined) {
                        valid = false;
                        break;
                    }
                    attributes[key] = expanded;
                }
                for (const child of item.children) {
                    const active = condition(child.attributes?.Condition, current);
                    if (active === false)
                        continue;
                    const value = expand(child.text.trim(), current);
                    if (active === undefined || child.children.length || value === undefined) {
                        valid = false;
                        break;
                    }
                    metadata[child.name] = value;
                }
                if (!valid) {
                    project.blockers.push('Opaque MSBuild ' + item.name + ' item in ' + current);
                    continue;
                }
                actions.push({ kind: item.name, attributes, metadata, file: current, start: item.start, end: item.end });
            }
        }
        project.targetFramework = properties.targetframework;
        const frameworks = (properties.targetframeworks ?? '').split(';').filter(Boolean);
        if (frameworks.length && !config.targetFramework)
            project.blockers.push('Multi-target MSBuild compilation requires dotnet.targetFramework');
        if (config.targetFramework && frameworks.length && !frameworks.includes(config.targetFramework))
            project.blockers.push('Recorded target framework is not a declared project target');
        if (config.targetFramework && !frameworks.length) {
            const declared = root.children.filter(node => node.name === 'PropertyGroup' && !node.attributes?.Condition).flatMap(node => node.children).find(node => node.name === 'TargetFramework' && !node.attributes?.Condition);
            if (declared && !declared.text.includes('$(') && declared.text.trim() !== config.targetFramework)
                project.blockers.push('Recorded target framework is not the declared project target');
        }
        if (project.sdk && !project.targetFramework)
            project.blockers.push('SDK compilation target framework is unavailable');
        const bool = (key: string, defaultValue: boolean) => properties[key] === undefined ? defaultValue : properties[key]!.toLowerCase() === 'true' ? true : properties[key]!.toLowerCase() === 'false' ? false : undefined;
        if (properties.defaultlanguagesourceextension && properties.defaultlanguagesourceextension !== '.cs')
            project.blockers.push('Unreviewed SDK source extension');
        if (properties.usingnetsdkdefaults?.toLowerCase() === 'false' || properties.disabledefaultitemsinprojectfolder?.toLowerCase() === 'true')
            project.blockers.push('Unreviewed SDK default item mode');
        for (const key of ['custombeforemicrosoftcommonprops', 'customaftermicrosoftcommonprops', 'custombeforemicrosoftcommontargets', 'customaftermicrosoftcommontargets', 'aftermicrosoftnetsdkprops', 'beforemicrosoftnetsdktargets', 'aftermicrosoftnetsdktargets', 'msbuildprojectextensionspath'])
            if (properties[key])
                project.blockers.push('Unreviewed SDK/MSBuild extension import path: ' + key);
        const defaultItems = bool('enabledefaultitems', true), defaultCompile = bool('enabledefaultcompileitems', true);
        if (defaultItems === undefined || defaultCompile === undefined)
            project.blockers.push('Opaque default Compile item selection');
        const paths = [...new Set([...this.context.files.keys(), ...this.context.fileInventory ?? []])].sort();
        const list = (value: string | undefined, origin = directory): string[] | undefined => {
            if (value === undefined)
                return [];
            const values = value.split(';').filter(Boolean).map(value => originalPath(origin, value, true));
            return values.some(value => value === undefined) ? undefined : values as string[];
        };
        for (const action of actions) {
            const { attributes: a, metadata: m } = action;
            if (action.kind === 'SdkDefaults' && defaultItems && defaultCompile) {
                const pattern = path.posix.join(directory, '**/*.cs');
                exclusions.push(path.posix.join(directory, 'bin/**'), path.posix.join(directory, 'obj/**'), path.posix.join(directory, '**/.*/**'));
                for (const key of ['defaultitemexcludes', 'defaultexcludesinprojectfolder', 'defaultitemexcludesinprojectfolder']) {
                    const values = list(properties[key]);
                    if (values)
                        exclusions.push(...values);
                    else
                        project.blockers.push('Opaque SDK default excludes');
                }
                for (const key of ['baseoutputpath', 'baseintermediateoutputpath'])
                    if (properties[key]) {
                        const prefix = originalPath(directory, properties[key]!);
                        if (prefix)
                            exclusions.push(path.posix.join(prefix, '**'));
                        else
                            project.blockers.push('Opaque SDK output path: ' + key);
                    }
                for (const item of paths)
                    if (dotnetGlob(pattern, item) && !exclusions.some(pattern => dotnetGlob(pattern, item)))
                        included.add(item);
            }
            else if (action.kind === 'Compile') {
                const include = list(a.Include), remove = list(a.Remove), exclude = list(a.Exclude);
                if (!include || !remove || !exclude) {
                    project.blockers.push('Opaque Compile paths in ' + action.file);
                    continue;
                }
                if (a.Include && a.Remove || a.Update && (a.Include || a.Remove)) {
                    project.blockers.push('Conflicting Compile item operations in ' + action.file);
                    continue;
                }
                if (a.Include) {
                    for (const pattern of include) {
                        const matches = /[*?]/.test(pattern) ? paths.filter(file => dotnetGlob(pattern, file)) : [pattern];
                        for (const target of matches)
                            if (!exclude.some(pattern => dotnetGlob(pattern, target))) {
                                if (included.has(target))
                                    project.blockers.push('Duplicate Compile item: ' + target);
                                included.add(target);
                            }
                    }
                }
                if (a.Remove) {
                    for (const target of included)
                        if (remove.some(pattern => dotnetGlob(pattern, target)))
                            included.delete(target);
                }
                if (Object.keys(a).some(key => !['Include', 'Remove', 'Exclude', 'Update'].includes(key)) || Object.keys(m).some(key => !['Link', 'Visible', 'DependentUpon', 'SubType'].includes(key)))
                    project.blockers.push('Unreviewed Compile metadata in ' + action.file);
            }
            else if (action.kind === 'ProjectReference') {
                const targets = list(a.Include);
                if (!targets || targets.some(target => /[*?]/.test(target) || !target.endsWith('.csproj'))) {
                    project.blockers.push('Opaque ProjectReference in ' + action.file);
                    continue;
                }
                const output = m.ReferenceOutputAssembly ?? a.ReferenceOutputAssembly;
                if (output?.toLowerCase() === 'false')
                    continue;
                if (output && output.toLowerCase() !== 'true' || Object.keys({ ...a, ...m }).some(key => !['Include', 'ReferenceOutputAssembly', 'Name', 'Project', 'Private'].includes(key)))
                    project.blockers.push('ProjectReference metadata/framework/alias negotiation requires a reviewed profile in ' + action.file);
                project.references.push(...targets);
            }
            else if (action.kind === 'Using') {
                const target = a.Include;
                if (a.Remove || a.Update || !target || Object.keys({ ...a, ...m }).some(key => !['Include', 'Alias', 'Static'].includes(key))) {
                    project.blockers.push('Unreviewed Using item in ' + action.file);
                    continue;
                }
                const alias = m.Alias ?? a.Alias, staticValue = m.Static ?? a.Static, isStatic = staticValue?.toLowerCase() === 'true';
                if (staticValue && !['true', 'false'].includes(staticValue.toLowerCase())) {
                    project.blockers.push('Opaque Using.Static in ' + action.file);
                    continue;
                }
                const source = this.sources.readFile(action.file)!, range = new SourceText(source).range(action.start, action.end ?? action.start), line = range.startLine;
                project.using.push({ file: action.file, fact: { specifier: target, kind: alias ? 'alias' : isStatic ? 'static' : 'namespace', ...(alias ? { alias } : {}), global: true, namespace: '', scopeStart: 0, scopeEnd: 0, start: action.start, end: action.end ?? action.start, range }, proof: [{ ...evidence('filesystem', 'csharp-projects', action.file, line, 'Original global Using item; no generated file is fabricated'), analyzerVersion: DOTNET_PROJECT_VERSION }] });
            }
            else if (action.kind !== 'SdkDefaults') {
                const name = a.Include ?? a.Update;
                if (name)
                    project.dependencies.push({ name, version: a.Version ?? m.Version, kind: action.kind });
                project.gaps.push('Binary/NuGet metadata and restored build assets are outside the indexed source contract');
            }
        }
        // ImplicitUsings is optional, never inferred from templates or the host.
        if (['true', 'enable'].includes(properties.implicitusings?.toLowerCase() ?? ''))
            project.gaps.push('SDK implicit global usings require a pinned SDK namespace profile; original Using items and source globals are retained');
        else if (properties.implicitusings && !['false', 'disable'].includes(properties.implicitusings.toLowerCase()))
            project.blockers.push('Opaque ImplicitUsings selection');
        if (properties.disabletransitiveprojectreferences && !['true', 'false'].includes(properties.disabletransitiveprojectreferences.toLowerCase()))
            project.blockers.push('Opaque transitive ProjectReference selection');
        if (properties.disabletransitiveprojectreferences?.toLowerCase() === 'true')
            project.gaps.push('Transitive project references are explicitly disabled');
        if (included.size > 50000 || actions.length > 10000)
            project.blockers.push('MSBuild source/item budget exceeded');
        project.sources = [...included].sort();
        project.references = [...new Set(project.references)].sort();
        for (const source of project.sources)
            if (!this.sources.fileExists(source))
                project.blockers.push('Included Compile source is excluded/unavailable: ' + source);
        const possibleInDirectory = (directory: string) => {
            let value = false;
            for (const action of actions) {
                if (action.kind === 'SdkDefaults' && defaultItems && defaultCompile) {
                    if (dotnetGlobWithinDirectory(path.posix.join(project.directory, '**/*.cs'), directory) && !exclusions.some(pattern => dotnetCoveredDirectory(pattern, directory)))
                        value = true;
                }
                else if (action.kind === 'Compile') {
                    if (list(action.attributes.Include)?.some(pattern => dotnetGlobWithinDirectory(pattern, directory)) && !list(action.attributes.Exclude)?.some(pattern => dotnetCoveredDirectory(pattern, directory)))
                        value = true;
                    if (list(action.attributes.Remove)?.some(pattern => dotnetCoveredDirectory(pattern, directory)))
                        value = false;
                }
            }
            return value;
        };
        for (const directory of this.context.directoryInventory ?? [])
            if (!this.indexedDirectories.has(directory) && possibleInDirectory(directory))
                project.blockers.push('Compile inventory crosses a pruned directory/symlink boundary: ' + directory);
        project.gaps = [...new Set(project.gaps)].sort();
        project.blockers = [...new Set(project.blockers)].sort();
        return project;
    }
    selection(file: string): {
        project?: DotnetProject;
        candidates: string[];
        reason?: string;
    } {
        let owners = this.projects.filter(project => project.sources.includes(file));
        const app = this.context.files.get(file)?.application ?? this.app(file), selected = app?.dotnet?.project ? dotnetPath(app.path, app.dotnet.project) : undefined;
        if (selected)
            owners = owners.filter(project => project.id === selected);
        return owners.length === 1 ? { project: owners[0], candidates: [owners[0]!.id] } : { candidates: owners.map(project => project.id), reason: owners.length ? 'Source belongs to several compilations; record dotnet.project' : 'Source is outside a selected indexed C# compilation' };
    }
    classpath(project: DotnetProject): {
        projects: DotnetProject[];
        gaps: string[];
    } {
        const projects: DotnetProject[] = [], gaps: string[] = [], visited = new Set<string>();
        const visit = (item: DotnetProject, stack: string[]) => {
            if (stack.includes(item.id)) {
                gaps.push('Cyclic ProjectReference: ' + item.id);
                return;
            }
            if (visited.has(item.id))
                return;
            visited.add(item.id);
            projects.push(item);
            gaps.push(...item.blockers);
            for (const reference of item.references) {
                const dependency = this.projects.find(candidate => candidate.id === reference);
                if (!dependency) {
                    gaps.push('Original referenced project is unavailable: ' + reference);
                    continue;
                }
                if (item === project || project.sdk && project.properties.disabletransitiveprojectreferences?.toLowerCase() !== 'true') {
                    if (!dotnetTargetCompatible(item.targetFramework, dependency.targetFramework))
                        gaps.push('Unreviewed/incompatible ProjectReference target frameworks: ' + item.id + ' -> ' + dependency.id);
                    visit(dependency, [...stack, item.id]);
                }
            }
        };
        visit(project, []);
        return { projects, gaps: [...new Set(gaps)].sort() };
    }
    describe(): unknown { return this.projects; }
}
function contextObserved(context: AnalysisContext, file: string): boolean { return !!context.fileInventory?.has(file) || !!context.directoryInventory?.has(file); }
