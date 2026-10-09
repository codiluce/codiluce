import path from 'node:path';
import { compare } from 'semver';
import type { AnalysisContext, ScannedFile } from '../../core/analyzer.js';
import type { GoBuildConfig } from '../../core/config.js';
import { evidence, type Evidence } from '../../core/graph.js';
import { IndexedSources } from '../indexed-sources.js';
import { selectGoFile, type GoSelection } from '../languages/go-build.js';
import { goModulePath, parseGoManifest, type GoManifest, type GoReplace } from './go-manifest.js';

export const GO_RESOLVER_VERSION = '2';
export interface GoModule { id: string; root: string; file: string; manifest: GoManifest }
interface Workspace { root: string; file: string; manifest: GoManifest }
export interface GoPackage { key: string; directory: string; name: string; module: GoModule; files: ScannedFile[]; conditions: string[] }
export type GoResolution = { status: 'resolved'; package: GoPackage; proof: Evidence[]; conditions: string[] }
  | { status: 'external'; module: string; version?: string; standardLibrary: boolean; proof: Evidence[]; conditions: string[] }
  | { status: 'ambiguous'; candidates: string[]; reason: string }
  | { status: 'excluded' | 'unsupported' | 'unresolved'; reason: string };
interface Environment { mains: GoModule[]; workspace?: Workspace; vendor: boolean; conditions: string[]; proof: Evidence[]; error?: { status: 'excluded' | 'unsupported'; reason: string } }
const inside = (root: string, file: string) => root === '.' || file === root || file.startsWith(`${root}/`);
const matches = (module: string, specifier: string) => specifier === module || specifier.startsWith(`${module}/`);
// Explicit standard-library names have priority over modules. New/unreviewed
// no-dot imports do not acquire standard-library provenance by their spelling.
const STANDARD = new Set(('archive/tar archive/zip bufio bytes cmp compress/bzip2 compress/flate compress/gzip compress/lzw compress/zlib container/heap container/list container/ring context crypto crypto/aes crypto/cipher crypto/des crypto/dsa crypto/ecdh crypto/ecdsa crypto/ed25519 crypto/elliptic crypto/hmac crypto/md5 crypto/rand crypto/rc4 crypto/rsa crypto/sha1 crypto/sha256 crypto/sha512 crypto/subtle crypto/tls crypto/x509 crypto/x509/pkix database/sql database/sql/driver debug/buildinfo debug/dwarf debug/elf debug/gosym debug/macho debug/pe debug/plan9obj embed encoding encoding/ascii85 encoding/asn1 encoding/base32 encoding/base64 encoding/binary encoding/csv encoding/gob encoding/hex encoding/json encoding/pem encoding/xml errors expvar flag fmt go/ast go/build go/build/constraint go/constant go/doc go/format go/importer go/parser go/printer go/scanner go/token go/types hash hash/adler32 hash/crc32 hash/crc64 hash/fnv html html/template image image/color image/draw image/gif image/jpeg image/png index/suffixarray io io/fs iter log log/slog log/syslog maps math math/big math/bits math/cmplx math/rand math/rand/v2 mime mime/multipart mime/quotedprintable net net/http net/http/cgi net/http/cookiejar net/http/fcgi net/http/httptest net/http/httptrace net/http/httputil net/http/pprof net/mail net/netip net/rpc net/rpc/jsonrpc net/smtp net/textproto net/url os os/exec os/signal os/user path path/filepath plugin reflect regexp regexp/syntax runtime runtime/cgo runtime/debug runtime/metrics runtime/pprof runtime/race runtime/trace slices sort strconv strings structs sync sync/atomic syscall testing testing/fstest testing/iotest testing/quick testing/slogtest text/scanner text/tabwriter text/template text/template/parse time unicode unicode/utf16 unicode/utf8 unique unsafe').split(' '));

/** Repository-local package binding. No go env/list, module download, generated
 * code, vendor lookup, compiler plugin or target command is executed. */
export class GoResolver {
  readonly modules: GoModule[] = [];
  readonly workspaces: Workspace[] = [];
  readonly sources: IndexedSources;
  private readonly goFiles = new Map<string, ScannedFile[]>();
  private readonly selections = new Map<string, GoSelection>();
  private readonly environments = new Map<string, Environment>();
  constructor(readonly context: AnalysisContext) {
    this.sources = context.sources ??= new IndexedSources(context);
    for (const file of [...context.files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
      if (file.language === 'go') { const dir = path.posix.dirname(file.path), files = this.goFiles.get(dir) ?? []; files.push(file); this.goFiles.set(dir, files); }
      const name = path.posix.basename(file.path); if (!['go.mod', 'go.work'].includes(name)) continue;
      const kind = name === 'go.mod' ? 'module' : 'workspace', text = this.sources.readFile(file.path), manifest = text === undefined ? { ...parseGoManifest('', kind), issues: ['Go manifest is not an indexed readable input'], valid: false } : parseGoManifest(text, kind), root = path.posix.dirname(file.path);
      if (kind === 'module') this.modules.push({ id: context.graph.id('project', 'go', root), root, file: file.path, manifest }); else this.workspaces.push({ root, file: file.path, manifest });
      for (const reason of manifest.issues) context.graph.diagnose({ analyzer: 'go-imports', severity: 'warning', code: 'go-manifest-gap', file: file.path, entityId: file.id, reason });
    }
    for (const file of [...context.goManifestInventory ?? []].sort()) if (!context.files.has(file)) {
      const root = path.posix.dirname(file), kind = file.endsWith('go.mod') ? 'module' : 'workspace', manifest = { ...parseGoManifest('', kind), issues: ['Observed Go manifest is pruned or a symlink; its contents are not indexed'], valid: false };
      if (kind === 'module') this.modules.push({ id: context.graph.id('project', 'go', root), root, file, manifest }); else this.workspaces.push({ root, file, manifest });
    }
    this.modules.sort((a, b) => (b.root === '.' ? 0 : b.root.length) - (a.root === '.' ? 0 : a.root.length) || a.root.localeCompare(b.root));
    this.workspaces.sort((a, b) => (b.root === '.' ? 0 : b.root.length) - (a.root === '.' ? 0 : a.root.length) || a.root.localeCompare(b.root));
  }
  owner(file: string): GoModule | undefined { return this.modules.find(module => inside(module.root, file)); }
  config(file: string): GoBuildConfig { return this.context.files.get(file)?.application?.go ?? {}; }
  selection(file: string, config = this.config(file)): GoSelection {
    const key = JSON.stringify([file, config]), known = this.selections.get(key); if (known) return known;
    const syntax = this.context.syntax?.get(file)?.facts.go, text = this.sources.readFile(file);
    const selection: GoSelection = syntax && text !== undefined ? selectGoFile(file, syntax, text, config) : { status: 'invalid', conditions: ['Unavailable Go syntax/source input'], expressions: [], test: file.endsWith('_test.go') };
    this.selections.set(key, selection); return selection;
  }
  private localRoot(base: string, relative: string): string | undefined {
    if (path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || /[\\\0]/.test(relative)) return undefined;
    const root = path.posix.normalize(path.posix.join(base, relative)); return root === '..' || root.startsWith('../') ? undefined : root;
  }
  environment(file: string): Environment {
    const owner = this.owner(file), app = this.context.files.get(file)?.application, config = this.config(file), key = JSON.stringify([owner?.id, app?.path, config.workspace]);
    const known = this.environments.get(key); if (known) return known;
    const result: Environment = { mains: owner ? [owner] : [], vendor: false, conditions: [], proof: [] }; this.environments.set(key, result);
    if (!owner?.manifest.valid) { result.error = { status: 'unsupported', reason: owner ? 'Owning Go module manifest is unavailable/malformed' : 'No indexed module; GOPATH/implicit invocation context is not qualified' }; return result; }
    const selected = config.workspace === false ? undefined : typeof config.workspace === 'string' ? this.localRoot(app?.path ?? owner.root, config.workspace) : undefined;
    const workspace = typeof config.workspace === 'string' ? this.workspaces.find(work => work.file === selected) : config.workspace === false ? undefined : this.workspaces.find(work => inside(work.root, owner.root));
    if (typeof config.workspace === 'string' && !workspace) { result.error = { status: 'excluded', reason: 'Configured Go workspace is not indexed' }; return result; }
    result.proof.push(evidence('filesystem', 'go-imports', owner.file, undefined, `Go module ${owner.manifest.module}; workspace ${workspace?.file ?? 'off/absent'} is a recorded static invocation assumption`));
    result.vendor = !!this.context.directoryInventory?.has(path.posix.join(workspace?.root ?? owner.root, 'vendor'));
    if (!workspace) return result;
    result.workspace = workspace;
    if (!workspace.manifest.valid) { result.error = { status: 'unsupported', reason: 'Selected Go workspace manifest is malformed/unavailable' }; return result; }
    result.mains = [];
    for (const use of workspace.manifest.uses) {
      const root = this.localRoot(workspace.root, use), module = root === undefined ? undefined : this.modules.find(module => module.root === root);
      if (!module?.manifest.valid) { result.error = { status: 'excluded', reason: `Workspace member ${use} is outside the repository, unavailable or lacks a valid indexed go.mod` }; continue; }
      if (!result.mains.includes(module)) result.mains.push(module);
    }
    if (!result.mains.includes(owner)) result.error = { status: 'unsupported', reason: 'Owning module is not a member of the selected Go workspace' };
    const names = result.mains.map(module => module.manifest.module); if (new Set(names).size !== names.length) result.conditions.push('Workspace members declare duplicate module paths');
    result.proof.push(evidence('filesystem', 'go-imports', workspace.file, undefined, 'Selected indexed Go workspace members; no environment lookup or target command')); return result;
  }
  private replacement(env: Environment, module: string, version: string): { value?: GoReplace; file?: string; root?: string; conflict?: boolean } {
    const applicable = (items: GoReplace[]) => items.filter(item => item.module === module && (!item.version || item.version === version));
    const workspace = env.workspace && applicable(env.workspace.manifest.replacements);
    // A workspace replacement overrides conflicting main-module replacements.
    if (workspace?.length) { const value = workspace.find(item => item.version) ?? workspace[0]!; return { value, root: env.workspace!.root, file: env.workspace!.file }; }
    const options = env.mains.flatMap(main => { const items = applicable(main.manifest.replacements), value = items.find(item => item.version) ?? items[0]; return value ? [{ value, root: main.root, file: main.file }] : []; });
    const identities = new Set(options.map(item => JSON.stringify([item.value.local ? this.localRoot(item.root, item.value.target) ?? `outside:${item.value.target}` : item.value.target, item.value.targetVersion ?? ''])));
    if (identities.size > 1) return { conflict: true };
    return options.find(item => item.value.version) ?? options[0] ?? {};
  }
  private package(module: GoModule, directory: string, config: GoBuildConfig, allowMain = false, name?: string): GoResolution {
    const found = (this.goFiles.get(directory) ?? []).filter(file => this.owner(file.path) === module), candidates: ScannedFile[] = [], conditions: string[] = [];
    const normalNames = new Set(found.filter(file => !file.path.endsWith('_test.go')).map(file => this.context.syntax?.get(file.path)?.facts.go?.package?.name).filter((name): name is string => !!name));
    const externalScope = !!name && !!config.includeTests && !normalNames.has(name) && [...normalNames].some(normal => name === `${normal}_test`);
    for (const file of found) {
      const selection = this.selection(file.path, config); if (selection.status === 'inactive') continue;
      if (!file.analyzable) return { status: 'excluded', reason: 'Package contains an unavailable indexed compilation unit' };
      const declared = this.context.syntax?.get(file.path)?.facts.go?.package?.name;
      if (externalScope && declared && declared !== name) continue;
      if (file.path.endsWith('_test.go') && declared && !normalNames.has(declared) && [...normalNames].some(normal => declared === `${normal}_test`) && name !== declared) continue;
      if (name && declared && declared !== name && file.path.endsWith('_test.go')) continue;
      candidates.push(file); conditions.push(...selection.conditions.map(reason => `${file.path}: ${reason}`));
    }
    if (!candidates.length) return { status: found.length ? 'unresolved' : 'excluded', reason: found.length ? 'No package files are active under the recorded build inputs' : 'No indexed Go package at the declared module path' };
    if (candidates.length > 512) return { status: 'unsupported', reason: 'Package exceeds the 512 compilation-unit budget' };
    const names = [...new Set(candidates.map(file => this.context.syntax?.get(file.path)?.facts.go?.package?.name).filter((name): name is string => !!name))];
    if (names.length > 1) return { status: 'ambiguous', candidates: candidates.map(file => file.id), reason: 'Competing package names in the selected directory/build context' };
    if (!names.length) return { status: 'unsupported', reason: 'Package clause is unavailable' };
    if (names[0] === 'main' && !allowMain) return { status: 'unsupported', reason: 'A Go command package cannot be imported as a library' };
    const target: GoPackage = { key: `${module.id}:${directory}:${names[0]}:${JSON.stringify(config)}`, directory, name: names[0]!, module, files: candidates, conditions: [...new Set(conditions)] };
    return { status: 'resolved', package: target, conditions: target.conditions, proof: [evidence('filesystem', 'go-imports', module.file, undefined, `Indexed module directory/package ${directory} declares ${target.name}`)] };
  }
  packageFor(file: string, origin = file): GoResolution {
    const module = this.owner(file); if (!module?.manifest.valid) return { status: 'unsupported', reason: 'No qualified owning module' };
    const selection = this.selection(file, this.config(origin)); if (selection.status === 'inactive') return { status: 'excluded', reason: 'Compilation unit is inactive under recorded build/test inputs' };
    return this.package(module, path.posix.dirname(file), this.config(origin), true, this.context.syntax?.get(file)?.facts.go?.package?.name);
  }
  resolve(file: string, specifier: string, origin = file): GoResolution {
    if (specifier === 'C') return { status: 'unsupported', reason: 'cgo pseudo-package and generated C bindings are not executed/indexed' };
    if (!goModulePath(specifier)) return { status: 'unsupported', reason: 'Relative, malformed or unreviewed import path; GOPATH imports require a separate profile' };
    if (specifier.split('/').includes('vendor')) return { status: 'unsupported', reason: 'Vendor directories cannot be named as canonical import paths' };
    const privateIndex = specifier.split('/').lastIndexOf('internal'), owner = this.owner(file), ownPath = owner?.manifest.module && path.posix.join(owner.manifest.module, path.posix.relative(owner.root, path.posix.dirname(file)));
    if (privateIndex >= 0) { const parent = specifier.split('/').slice(0, privateIndex).join('/'); if (!parent || !ownPath || !matches(parent, ownPath)) return { status: 'unsupported', reason: 'Import crosses a Go internal-package boundary' }; }
    const env = this.environment(origin), config = this.config(origin);
    if (STANDARD.has(specifier)) return { status: 'external', module: specifier, standardLibrary: true, proof: [evidence('syntax', 'go-imports', file, undefined, 'Reviewed canonical standard-library import; module names cannot impersonate it')], conditions: [...env.conditions, ...(env.error ? [env.error.reason] : [])] };
    if (env.error) return env.error;
    const conditions = [...env.conditions], candidates: GoResolution[] = [], requirements = new Map<string, string>();
    for (const main of env.mains) for (const [module, version] of Object.entries(main.manifest.requires)) if (!requirements.has(module) || compare(version, requirements.get(module)!) > 0) requirements.set(module, version);
    for (const main of env.mains) if (matches(main.manifest.module!, specifier)) {
      const directory = path.posix.join(main.root, specifier.slice(main.manifest.module!.length).replace(/^\//, ''));
      candidates.push(this.package(main, directory, { ...config, includeTests: config.includeTests && directory === path.posix.dirname(file) }));
    }
    let external: GoResolution | undefined, externalCount = 0;
    for (const [module, version] of [...requirements].sort(([a], [b]) => b.length - a.length)) {
      if (!matches(module, specifier) || env.mains.some(main => main.manifest.module === module)) continue;
      if (env.vendor) return { status: 'unsupported', reason: 'Observed vendor tree may override dependencies/replacements; vendored module selection is not indexed or executed' };
      if (env.mains.some(main => main.manifest.excludes.some(exclude => exclude.module === module && exclude.version === version))) return { status: 'unsupported', reason: 'Excluded requirement needs a selected module graph; versions are not guessed' };
      const replacement = this.replacement(env, module, version);
      if (replacement.conflict) return { status: 'ambiguous', candidates: env.mains.map(main => this.context.files.get(main.file)!.id), reason: 'Conflicting main-module replacements need an overriding workspace replace' };
      const proof = [...env.proof, evidence('filesystem', 'go-imports', replacement.file ?? env.mains.find(main => main.manifest.requires[module])?.file, undefined, `Declared requirement ${module} ${version}${replacement.value ? `; replacement ${replacement.value.target}` : ''}; transitive version selection is not executed`)];
      if (replacement.value?.local) {
        const root = this.localRoot(replacement.root!, replacement.value.target), target = root === undefined ? undefined : this.modules.find(item => item.root === root);
        if (!target?.manifest.valid) return { status: 'excluded', reason: 'Local replacement is outside the repository or lacks an indexed valid go.mod' };
        if (target.manifest.module !== module) return { status: 'unsupported', reason: 'Local replacement module directive differs from the replaced module path' };
        const outcome = this.package(target, path.posix.join(target.root, specifier.slice(module.length).replace(/^\//, '')), { ...config, includeTests: false });
        if (outcome.status === 'resolved') { outcome.proof.push(...proof); if (replacement.value.version) outcome.conditions.push('Version-specific replacement needs full selected-module-graph qualification'); }
        candidates.push(outcome);
      } else { externalCount++; if (!external) external = { status: 'external', module: replacement.value?.target ?? module, version: replacement.value?.targetVersion ?? version, standardLibrary: false, proof, conditions: [...conditions, ...(replacement.value ? ['Remote module replacement requires a separate dependency/API profile'] : [])] }; }
    }
    const resolved = candidates.filter((item): item is Extract<GoResolution, { status: 'resolved' }> => item.status === 'resolved');
    if (resolved.length > 1) return { status: 'ambiguous', candidates: resolved.flatMap(item => item.package.files.map(file => file.id)), reason: 'Multiple selected modules provide the same import path' };
    if (resolved.length) {
      const outcome = resolved[0]!; outcome.conditions.push(...conditions); outcome.proof.push(...env.proof);
      const own = this.context.syntax?.get(file)?.facts.go?.package?.name;
      if (outcome.package.directory === path.posix.dirname(file) && own === outcome.package.name) return { status: 'unsupported', reason: 'Package imports itself; cycle cannot prove a runtime namespace' };
      if (external) outcome.conditions.push('A declared external module may also provide this import path; its source is not indexed');
      return outcome;
    }
    if (candidates.some(item => item.status === 'ambiguous')) return candidates.find(item => item.status === 'ambiguous')!;
    if (candidates.length) return candidates[0]!;
    if (externalCount > 1 && external?.status === 'external') external.conditions.push('Multiple unindexed declared modules may provide this package; source selection is unqualified');
    return external ?? { status: 'unresolved', reason: 'Import is outside the main/workspace modules and declared requirements; transitive downloads/GOPATH/vendor are not inferred' };
  }
  describe(): unknown[] { return this.modules.map(module => ({ id: module.id, ecosystem: 'go', root: module.root, manifest: module.file, package: module.manifest.module, valid: module.manifest.valid, goVersion: module.manifest.goVersion, toolchain: module.manifest.toolchain, requires: module.manifest.requires, replacements: module.manifest.replacements, excludes: module.manifest.excludes, godebug: module.manifest.godebug, tools: module.manifest.tools, retracts: module.manifest.retracts, workspaces: this.workspaces.filter(work => work.manifest.uses.some(use => this.localRoot(work.root, use) === module.root)).map(work => work.file) })); }
}
