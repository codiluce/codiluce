import path from 'node:path';
import type { AnalysisContext } from '../../core/analyzer.js';
import { applicationAt } from '../../core/config.js';
import { evidence, type Evidence } from '../../core/graph.js';
import { IndexedSources } from '../indexed-sources.js';
import { readPomXml, xmlChild, xmlChildren, xmlValue, jvmPath, gradleTokens, readGradleSettings, readGradleBuild, type XmlNode } from './jvm-manifest.js';
export const JVM_PROJECT_VERSION = '2';
export interface JvmDependency {
    path?: string;
    coordinate?: string;
    scope: string;
    exported: boolean;
    optional: boolean;
    exclusions: string[];
    proof: Evidence[];
    reason?: string;
}
export interface JvmProject {
    id: string;
    root: string;
    kind: 'maven' | 'gradle' | 'configured';
    manifest?: string;
    sourceSet: 'main' | 'test';
    roots: {
        path: string;
        language: 'java' | 'kotlin';
        set: 'main' | 'test';
        proof: Evidence[];
    }[];
    dependencies: JvmDependency[];
    modules: string[];
    reactor: string;
    coordinate?: string;
    properties: Record<string, string>;
    managed: Map<string, JvmDependency>;
    gaps: string[];
    proof: Evidence[];
}
const inside = (file: string, root: string) => root === '.' || file === root || file.startsWith(root + '/');
const length = (root: string) => root === '.' ? 0 : root.length;
export class JvmProjects {
    readonly projects: JvmProject[] = [];
    private readonly sources: IndexedSources;
    private readonly effective = new Map<string, {
        file: string;
        node: XmlNode;
    }[]>();
    private readonly active = new Set<string>();
    constructor(readonly context: AnalysisContext) {
        this.sources = context.sources ?? new IndexedSources(context);
        const observed = [...new Set([...context.files.keys(), ...context.fileInventory ?? []])].sort();
        for (const file of observed.filter(file => path.posix.basename(file) === 'pom.xml'))
            this.maven(file);
        const settings = observed.filter(file => /^settings\.gradle(?:\.kts)?$/.test(path.posix.basename(file)));
        for (const file of settings)
            this.gradle(file, observed);
        for (const file of observed.filter(file => /^build\.gradle(?:\.kts)?$/.test(path.posix.basename(file))))
            if (!this.at(path.posix.dirname(file)))
                this.gradle(file, observed);
        for (const app of context.config.applications)
            if ((app.sourceRoots?.java || app.sourceRoots?.kotlin) && !this.at(app.path))
                this.projects.push(this.create(app.path, 'configured'));
        for (const project of this.projects) {
            this.configured(project);
            if (project.kind === 'maven' && observed.some(file => path.posix.dirname(file) === project.root && /^(?:build|settings)\.gradle(?:\.kts)?$/.test(path.posix.basename(file))))
                project.gaps.push('Competing Maven and Gradle build ownership requires an explicit project selection');
        }
        // A reactor is an explicit aggregation, never a shared directory/GAV guess.
        for (const root of this.projects.filter(project => project.kind === 'maven' && project.modules.length).sort((a, b) => length(a.root) - length(b.root))) {
            if (root.reactor !== root.root)
                continue;
            const visit = (project: JvmProject, seen = new Set<string>()) => {
                if (seen.has(project.root) || seen.size > 1024)
                    return;
                seen.add(project.root);
                if (project.reactor !== project.root && project.reactor !== root.root) {
                    project.gaps.push('Competing Maven reactor membership');
                    root.gaps.push('Competing Maven reactor membership');
                    return;
                }
                project.reactor = root.root;
                project.proof.push(...root.proof.filter(fact => !project.proof.some(existing => existing.file === fact.file && existing.explanation === fact.explanation)));
                for (const member of project.modules) {
                    const child = this.at(member);
                    if (child)
                        visit(child, seen);
                    else
                        project.gaps.push(`Declared Maven module is unavailable: ${member}`);
                }
            };
            visit(root);
        }
        for (const project of this.projects)
            if (project.kind === 'maven')
                for (const dep of project.dependencies)
                    if (dep.coordinate) {
                        const targets = this.projects.filter(target => target.kind === 'maven' && target.reactor === project.reactor && target.coordinate === dep.coordinate);
                        if (targets.length === 1)
                            dep.path = targets[0]!.root;
                        else if (targets.length > 1)
                            dep.reason = 'Competing local Maven coordinates';
                    }
    }
    private fact(file: string | undefined, start: number | undefined, explanation: string): Evidence[] { const text = file && this.sources.readFile(file), line = text !== undefined && start !== undefined ? text.slice(0, start).split(/\r\n|\r|\n/).length : undefined; return [{ ...evidence(file ? 'syntax' : 'framework', 'jvm-projects', file, line, explanation), analyzerVersion: JVM_PROJECT_VERSION }]; }
    private at(root: string) { return this.projects.find(project => project.root === root); }
    private create(root: string, kind: JvmProject['kind'], manifest?: string): JvmProject {
        const app = applicationAt(this.context.config.applications, root);
        return { id: this.context.graph.id('project', 'jvm', root), root, kind, manifest, sourceSet: app?.jvm?.sourceSet ?? 'main', roots: [], dependencies: [], modules: [], reactor: root, properties: {}, managed: new Map(), gaps: [], proof: this.fact(manifest, 0, `Indexed ${kind} JVM project; target builds/plugins never execute`) };
    }
    private root(project: JvmProject, value: string, language: 'java' | 'kotlin', set: 'main' | 'test', proof: Evidence[]) {
        const selected = jvmPath(project.root, value);
        if (!selected)
            project.gaps.push(`Unresolved/nonportable ${language} source root: ${value}`);
        else if (!project.roots.some(root => root.path === selected && root.language === language && root.set === set))
            project.roots.push({ path: selected, language, set, proof });
    }
    private configured(project: JvmProject) {
        const app = applicationAt(this.context.config.applications, project.root);
        if (!app || app.path !== project.root)
            return;
        for (const language of ['java', 'kotlin'] as const)
            if (app.sourceRoots?.[language]) {
                project.roots = project.roots.filter(root => root.language !== language);
                for (const root of app.sourceRoots[language]!)
                    this.root(project, root, language, project.sourceSet, this.fact(undefined, undefined, `Recorded ${language} source root ${root}`));
            }
        if (app.jvm?.dependencies)
            project.dependencies = app.jvm.dependencies.map(value => ({ path: jvmPath(project.root, value), scope: 'recorded', exported: false, optional: false, exclusions: [], proof: this.fact(undefined, undefined, `Recorded local JVM classpath dependency ${value}`) }));
    }
    private maven(file: string): JvmProject {
        const root = path.posix.dirname(file), old = this.at(root);
        if (old) {
            if (this.active.has(file))
                old.gaps.push('Cyclic Maven parent initialization');
            return old;
        }
        const project = this.create(root, 'maven', file);
        this.projects.push(project);
        if (this.active.size > 64) {
            project.gaps.push('Maven parent traversal budget exceeded');
            return project;
        }
        this.active.add(file);
        const text = this.sources.readFile(file), document = text === undefined ? undefined : readPomXml(text);
        if (!document) {
            project.gaps.push(`Denied/incomplete/unsupported Maven XML: ${file}`);
            this.active.delete(file);
            return project;
        }
        const uniqueContainers = new Set(['project', 'profile', 'parent', 'build', 'plugin', 'configuration', 'dependency', 'dependencyManagement', 'exclusion']);
        const inspect = (node: XmlNode) => {
            if (uniqueContainers.has(node.name)) {
                const names = node.children.map(child => child.name);
                if (new Set(names).size !== names.length)
                    project.gaps.push(`Duplicate Maven model fields in ${node.name}`);
            }
            if (Object.keys(node.attributes ?? {}).some(name => name.startsWith('combine.')))
                project.gaps.push('Custom Maven model merge attributes require an effective model summary');
            for (const child of node.children)
                inspect(child);
        };
        inspect(document);
        if (xmlValue(document, 'modelVersion') !== '4.0.0')
            project.gaps.push('Unsupported Maven model version');
        const duplicate = (node: XmlNode) => {
            for (const name of ['groupId', 'artifactId', 'version', 'parent', 'build', 'profiles', 'properties', 'dependencyManagement', 'dependencies', 'modules'])
                if (xmlChildren(node, name).length > 1)
                    project.gaps.push(`Duplicate Maven model element ${name}`);
        };
        duplicate(document);
        let parent: JvmProject | undefined;
        const parentNode = xmlChild(document, 'parent');
        if (parentNode) {
            const relative = xmlChild(parentNode, 'relativePath'), value = relative ? relative.text.trim() : '../pom.xml', target = value ? jvmPath(root, value.endsWith('.xml') ? value : value + '/pom.xml') : undefined;
            if (target && this.context.files.has(target) && !this.active.has(target))
                parent = this.maven(target);
            else if (target && this.active.has(target))
                project.gaps.push('Cyclic Maven parent initialization');
            if (parent) {
                const expected = ['groupId', 'artifactId', 'version'].map(name => xmlValue(parentNode, name)).join(':');
                if (expected !== parent.coordinate) {
                    project.gaps.push('Local Maven parent coordinates do not match');
                    parent = undefined;
                }
            }
            if (parent) {
                project.gaps.push(...parent.gaps.filter(gap => !gap.startsWith('Non-JAR Maven packaging')));
                project.proof.push(...parent.proof);
            }
            else
                project.gaps.push('External/unavailable Maven parent may change the effective model');
        }
        const app = applicationAt(this.context.config.applications, root), configuredProfiles = app?.jvm?.profiles, profiles = xmlChildren(xmlChild(document, 'profiles'), 'profile'), selected: XmlNode[] = [document];
        if (profiles.length && configuredProfiles === undefined)
            project.gaps.push('Maven profiles require explicitly selected jvm.profiles; activation is not evaluated');
        for (const profile of profiles)
            if (configuredProfiles?.includes(xmlValue(profile, 'id') ?? ''))
                selected.push(profile);
        for (const id of configuredProfiles ?? [])
            if (!profiles.some(profile => xmlValue(profile, 'id') === id))
                project.gaps.push(`Selected Maven profile is not present in this project: ${id}`);
        const models = [...parent?.manifest ? this.effective.get(parent.manifest) ?? [] : [], ...selected.map(node => ({ file, node }))];
        this.effective.set(file, models);
        for (const { node: model } of models)
            for (const prop of xmlChild(model, 'properties')?.children ?? [])
                if (!prop.children.length) {
                    if (xmlChildren(xmlChild(model, 'properties'), prop.name).length > 1)
                        project.gaps.push('Competing Maven property values');
                    project.properties[prop.name] = prop.text.trim();
                }
        const interpolate = (value: string | undefined, depth = 0): string | undefined => {
            if (value === undefined || depth > 16)
                return;
            let missing = false;
            const result = value.replace(/\$\{([^}]+)\}/g, (_all, name: string) => {
                const selected = project.properties[name];
                if (selected === undefined) {
                    missing = true;
                    return '';
                }
                const next = interpolate(selected, depth + 1);
                if (next === undefined)
                    missing = true;
                return next ?? '';
            });
            return missing || result.includes('${') ? undefined : result;
        };
        const group = interpolate(xmlValue(document, 'groupId') ?? parent?.coordinate?.split(':')[0]), artifact = interpolate(xmlValue(document, 'artifactId')), version = interpolate(xmlValue(document, 'version') ?? parent?.coordinate?.split(':')[2]);
        if (group && artifact && version && ![group, artifact, version].some(value => value.includes(':')))
            project.coordinate = `${group}:${artifact}:${version}`;
        else
            project.gaps.push('Maven coordinates are not literal/resolved');
        Object.assign(project.properties, { 'project.groupId': group ?? '', 'pom.groupId': group ?? '', 'project.artifactId': artifact ?? '', 'pom.artifactId': artifact ?? '', 'project.version': version ?? '', 'pom.version': version ?? '', 'project.basedir': '.', 'basedir': '.' });
        const dependencies = (model: XmlNode, sourceFile: string, managed: boolean) => {
            for (const node of xmlChildren(xmlChild(model, 'dependencies'), 'dependency')) {
                const group = interpolate(xmlValue(node, 'groupId')), artifact = interpolate(xmlValue(node, 'artifactId')), key = group && artifact && `${group}:${artifact}`, inherited = key && project.managed.get(key), version = interpolate(xmlValue(node, 'version')) ?? (inherited && inherited.coordinate?.split(':')[2]), scope = xmlValue(node, 'scope') ?? (inherited && inherited.scope) ?? 'compile';
                const dep: JvmDependency = { coordinate: key && version ? `${key}:${version}` : undefined, scope, exported: scope === 'compile', optional: xmlValue(node, 'optional') === 'true', exclusions: xmlChildren(xmlChild(node, 'exclusions'), 'exclusion').map(item => `${xmlValue(item, 'groupId')}:${xmlValue(item, 'artifactId')}`), proof: this.fact(sourceFile, node.start, 'Literal Maven dependency selection') };
                if (inherited)
                    dep.proof.push(...inherited.proof);
                if (!key || !version || xmlValue(node, 'type') && xmlValue(node, 'type') !== 'jar' || xmlValue(node, 'classifier') || xmlValue(node, 'systemPath') || !['compile', 'provided', 'runtime', 'test'].includes(scope))
                    dep.reason = 'Dynamic/unreviewed Maven dependency or artifact variant';
                if (managed && dep.reason)
                    project.gaps.push(dep.reason);
                if (dep.exclusions.some(value => value.includes('*') || value.includes('undefined'))) {
                    dep.reason = 'Unreviewed Maven exclusion pattern';
                }
                if (managed && (xmlValue(node, 'optional') || xmlChild(node, 'exclusions')))
                    project.gaps.push('Managed Maven optional/exclusion overrides require an effective dependency summary');
                if (managed && key)
                    project.managed.set(key, dep);
                else if (!managed) {
                    project.dependencies = project.dependencies.filter(item => !item.coordinate?.startsWith(key + ':'));
                    project.dependencies.push(dep);
                }
            }
        };
        for (const { node: model, file: sourceFile } of models) {
            const management = xmlChild(model, 'dependencyManagement');
            if (management)
                dependencies(management, sourceFile, true);
        }
        for (const { node: model, file: sourceFile } of models)
            dependencies(model, sourceFile, false);
        for (const model of selected)
            for (const member of xmlChildren(xmlChild(model, 'modules'), 'module')) {
                const value = interpolate(member.text.trim()), target = value && jvmPath(root, value.endsWith('.xml') ? path.posix.dirname(value) : value);
                if (target)
                    project.modules.push(target);
                else
                    project.gaps.push('Dynamic/outside Maven module path');
            }
        for (const [set, name, fallback] of [['main', 'sourceDirectory', 'src/main/java'], ['test', 'testSourceDirectory', 'src/test/java']] as const) {
            const selectedModel = [...models].reverse().find(model => xmlChild(xmlChild(model.node, 'build'), name)), selectedBuild = xmlChild(selectedModel?.node, 'build'), declared = xmlValue(selectedBuild, name), value = declared === undefined ? fallback : interpolate(declared);
            if (value)
                this.root(project, value, 'java', set, this.fact(selectedModel?.file ?? file, selectedBuild?.start ?? 0, 'Maven source directory selection'));
            else
                project.gaps.push('Unresolved Maven source directory');
        }
        const kotlinPlugins = models.flatMap(({ node: model, file: sourceFile }) => xmlChildren(xmlChild(xmlChild(model, 'build'), 'plugins'), 'plugin').filter(plugin => xmlValue(plugin, 'artifactId') === 'kotlin-maven-plugin' && !(sourceFile !== file && xmlValue(plugin, 'inherited') === 'false')));
        if (kotlinPlugins.length > 1)
            project.gaps.push('Merged Kotlin Maven plugin configurations require a selected compilation summary');
        for (const { node: model, file: sourceFile } of models) {
            const build = xmlChild(model, 'build');
            if (xmlChild(build, 'extensions'))
                project.gaps.push('Maven build extensions may change project/classpath inputs');
            for (const plugin of xmlChildren(xmlChild(build, 'plugins'), 'plugin')) {
                if (sourceFile !== file && xmlValue(plugin, 'inherited') === 'false')
                    continue;
                if (xmlValue(plugin, 'extensions') === 'true')
                    project.gaps.push('Maven plugin extensions require an effective lifecycle summary');
                const name = xmlValue(plugin, 'artifactId'), group = xmlValue(plugin, 'groupId') ?? 'org.apache.maven.plugins';
                if (name === 'kotlin-maven-plugin' && group === 'org.jetbrains.kotlin') {
                    const configuration = xmlChild(plugin, 'configuration'), dirs = xmlChild(configuration, 'sourceDirs');
                    if (dirs)
                        for (const dir of dirs.children) {
                            const value = interpolate(dir.text.trim());
                            if (value)
                                this.root(project, value, 'kotlin', 'main', this.fact(sourceFile, dir.start, 'Literal Kotlin Maven source directory'));
                            else
                                project.gaps.push('Dynamic Kotlin source directory');
                        }
                    else
                        this.root(project, 'src/main/kotlin', 'kotlin', 'main', this.fact(sourceFile, plugin.start, 'Kotlin Maven source convention'));
                    this.root(project, 'src/test/kotlin', 'kotlin', 'test', this.fact(sourceFile, plugin.start, 'Kotlin Maven test source convention'));
                    if (xmlChild(plugin, 'executions'))
                        project.gaps.push('Kotlin Maven execution-specific roots require a selected compilation summary');
                }
                else if (group !== 'org.apache.maven.plugins' || name && !['maven-compiler-plugin', 'maven-surefire-plugin', 'maven-jar-plugin', 'maven-war-plugin', 'maven-resources-plugin', 'maven-clean-plugin', 'maven-install-plugin', 'maven-deploy-plugin'].includes(name))
                    project.gaps.push(`Unreviewed Maven plugin can change source/classpath inputs: ${name}`);
            }
        }
        if (xmlChild(document, 'packaging') && xmlValue(document, 'packaging') !== 'jar')
            project.gaps.push('Non-JAR Maven packaging requires a selected source/compiler lifecycle profile');
        // Compiler options may substitute source/module paths or produce types.
        for (const { node: model } of models) {
            const build = xmlChild(model, 'build');
            if (xmlChild(build, 'pluginManagement'))
                project.gaps.push('Maven plugin management requires effective plugin configuration review');
            for (const plugin of xmlChildren(xmlChild(build, 'plugins'), 'plugin'))
                if (xmlValue(plugin, 'artifactId') === 'maven-compiler-plugin' && (xmlChild(plugin, 'configuration') || xmlChild(plugin, 'executions')))
                    project.gaps.push('Custom Maven compiler configuration/annotation processing requires a compilation profile');
        }
        if (this.context.fileInventory?.has(path.posix.join(root, '.mvn/extensions.xml')))
            project.gaps.push('Maven core extensions are not evaluated');
        project.gaps = [...new Set(project.gaps)];
        this.active.delete(file);
        return project;
    }
    private gradle(file: string, observed: string[]) {
        const buildRoot = path.posix.dirname(file), settings = path.posix.basename(file).startsWith('settings.');
        const members = new Map<string, string>([[':', buildRoot]]), gaps: string[] = [];
        if (observed.filter(item => path.posix.dirname(item) === buildRoot && /^settings\.gradle(?:\.kts)?$/.test(path.posix.basename(item))).length > 1)
            gaps.push('Competing Gradle settings files');
        if (settings) {
            const text = this.sources.readFile(file), tokens = text === undefined ? undefined : gradleTokens(text);
            if (!tokens)
                gaps.push('Denied/opaque Gradle settings');
            else {
                const model = readGradleSettings(tokens, file.endsWith('.kts'));
                gaps.push(...model.gaps);
                for (const value of model.includes) {
                    const name = ':' + value.replace(/^:/, ''), target = jvmPath(buildRoot, name.slice(1).replaceAll(':', '/'));
                    if (target && /^:(?:[\w-]+:)*[\w-]+$/.test(name))
                        members.set(name, target);
                    else
                        gaps.push('Unreviewed Gradle project path');
                }
                for (const location of model.directories) {
                    const target = jvmPath(buildRoot, location.path);
                    if (target && members.has(location.project))
                        members.set(location.project, target);
                    else
                        gaps.push('Dynamic/undeclared Gradle projectDir');
                }
            }
        }
        const selected: JvmProject[] = [];
        for (const [name, root] of members) {
            const old = this.at(root);
            if (old) {
                old.gaps.push('Competing JVM build manifests/project ownership');
                gaps.push('Competing Gradle project ownership');
                continue;
            }
            const builds = observed.filter(item => path.posix.dirname(item) === root && /^build\.gradle(?:\.kts)?$/.test(path.posix.basename(item)));
            const manifest = builds[0] ?? (settings ? undefined : file), project = this.create(root, 'gradle', manifest);
            this.projects.push(project);
            selected.push(project);
            project.reactor = buildRoot;
            project.gaps.push(...gaps);
            if (settings)
                project.proof.push(...this.fact(file, 0, 'Literal indexed Gradle settings select this project'));
            if (builds.length > 1)
                project.gaps.push('Competing Gradle build scripts');
            const text = manifest && this.sources.readFile(manifest), tokens = text === undefined ? undefined : gradleTokens(text);
            if (!tokens) {
                project.gaps.push('Gradle project build is denied/opaque/unavailable');
                if (name === ':' && manifest)
                    gaps.push(...project.gaps);
                continue;
            }
            const model = readGradleBuild(tokens, manifest?.endsWith('.kts'));
            project.gaps.push(...model.gaps);
            if (!model.plugins.length)
                project.gaps.push('No literal reviewed Java/Kotlin JVM plugin selects conventional source roots');
            const languages: ('java' | 'kotlin')[] = model.plugins.some(plugin => plugin.id === 'org.jetbrains.kotlin.jvm') ? ['java', 'kotlin'] : ['java'];
            if (model.plugins.length)
                for (const language of languages)
                    for (const set of ['main', 'test'] as const)
                        this.root(project, `src/${set}/${language}`, language, set, this.fact(manifest, model.plugins[0]!.start, 'Literal standard Gradle JVM plugin/source-set contract'));
            for (const item of model.dependencies) {
                const target = item.project && members.get(item.project);
                if (['api', 'compileOnlyApi'].includes(item.scope) && !model.plugins.some(plugin => plugin.id === 'java-library'))
                    project.gaps.push('Gradle api configuration requires the literal java-library plugin');
                project.dependencies.push({ path: target || undefined, coordinate: item.coordinate, scope: item.scope, exported: ['api', 'compileOnlyApi'].includes(item.scope), optional: false, exclusions: [], proof: this.fact(manifest, item.start, 'Literal Gradle dependency DSL selection'), reason: item.project && !target ? 'Gradle project dependency is absent from selected settings' : item.coordinate && !/^[^:\s]+:[^:\s]+:[^:\s]+$/.test(item.coordinate) ? 'Unreviewed Gradle artifact variant or coordinate' : undefined });
            }
            if (name === ':') {
                project.modules = [...members.values()].filter(member => member !== root);
                gaps.push(...model.gaps);
            }
        }
        if (observed.some(item => inside(item, path.posix.join(buildRoot, 'buildSrc'))) || this.context.directoryInventory?.has(path.posix.join(buildRoot, 'buildSrc')))
            gaps.push('Gradle buildSrc can change project/classpath conventions');
        for (const project of selected)
            project.gaps = [...new Set([...project.gaps, ...gaps])];
    }
    owner(file: string) { return this.projects.filter(project => inside(file, project.root)).sort((a, b) => length(b.root) - length(a.root))[0]; }
    selection(file: string): {
        project?: JvmProject;
        set?: 'main' | 'test';
        reason?: string;
        proof: Evidence[];
    } {
        const project = this.owner(file);
        if (!project)
            return { proof: [], reason: 'No selected JVM project/source roots' };
        const roots = project.roots.filter(root => root.language === this.context.files.get(file)?.language && inside(file, root.path)).sort((a, b) => length(b.path) - length(a.path));
        const root = roots[0];
        if (!root)
            return { project, proof: [], reason: 'JVM source lies outside selected source roots' };
        if (root.set === 'test' && project.sourceSet !== 'test')
            return { project, set: root.set, proof: root.proof, reason: 'Test source is outside selected main compilation' };
        return { project, set: root.set, proof: root.proof };
    }
    classpath(project: JvmProject): {
        projects: JvmProject[];
        artifacts: JvmDependency[];
        gaps: string[];
        proof: Evidence[];
    } {
        const result = [project], artifacts: JvmDependency[] = [], gaps = [...project.gaps], proof = [...project.proof], queue = [{ project, depth: 0, excluded: [] as string[] }], seen = new Set([JSON.stringify([project.root, []])]), versions = new Map<string, string>();
        let steps = 0;
        while (queue.length) {
            const current = queue.shift()!;
            for (const dep of current.project.dependencies) {
                if (++steps > 4096) {
                    gaps.push('JVM dependency traversal budget exceeded');
                    queue.length = 0;
                    break;
                }
                if (current.depth > 0 && (!dep.exported || dep.optional) || dep.scope === 'runtime' || dep.scope === 'runtimeOnly' || dep.scope === 'testRuntimeOnly' || dep.scope.startsWith('test') && project.sourceSet !== 'test')
                    continue;
                if (dep.reason) {
                    gaps.push(dep.reason);
                    continue;
                }
                if (dep.coordinate) {
                    const key = dep.coordinate.split(':').slice(0, 2).join(':'), old = versions.get(key);
                    if (old && old !== dep.coordinate) {
                        gaps.push('Competing JVM dependency versions require a selected mediation summary');
                        continue;
                    }
                    versions.set(key, dep.coordinate);
                }
                if (dep.coordinate && current.excluded.includes(dep.coordinate.split(':').slice(0, 2).join(':')))
                    continue;
                if (dep.coordinate && !dep.path) artifacts.push(dep);
                if (!dep.path)
                    continue;
                const target = this.at(dep.path);
                if (!target) {
                    gaps.push(`Recorded local JVM dependency is unavailable: ${dep.path}`);
                    continue;
                }
                proof.push(...dep.proof);
                const excluded = [...new Set([...current.excluded, ...dep.exclusions])].sort(), key = JSON.stringify([target.root, excluded]);
                if (seen.has(key))
                    continue;
                seen.add(key);
                if (!result.includes(target))
                    result.push(target);
                gaps.push(...target.gaps);
                queue.push({ project: target, depth: current.depth + 1, excluded });
            }
        }
        return { projects: result, artifacts, gaps: [...new Set(gaps)], proof };
    }
    describe() { return this.projects.map(project => ({ ...project, managed: Object.fromEntries(project.managed), gaps: [...new Set(project.gaps)] })); }
}
