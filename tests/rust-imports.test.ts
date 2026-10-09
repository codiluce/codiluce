import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { indexRepository } from '../src/pipeline/index.js';
import { resolveConfig, type ApplicationInput, type RustConfig } from '../src/core/config.js';
import { AnalysisCache } from '../src/pipeline/cache.js';
import { canonicalJson } from '../src/history/fingerprint.js';
import type { SoftwareGraph } from '../src/core/graph.js';
import { StructureParser } from '../src/analysis/tree-sitter/client.js';
import { cargoRequirement, rustPath } from '../src/analysis/resolution/rust-projects.js';
import { rustAttributes, rustCfg, rustString } from '../src/analysis/languages/rust-cfg.js';
const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, file: string, text: string) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
async function repo(files: Record<string, string>) { const root = await mkdtemp(path.join(tmpdir(), 'codiluce-rust-')); roots.push(root); for (const [file, text] of Object.entries(files))
    await put(root, file, text); return root; }
const manifest = (name = 'api', extra = '', edition = '2021') => `[package]\nname="${name}"\nversion="1.0.0"\nedition="${edition}"\n${extra}`;
const selected: RustConfig = { features: [], defaultFeatures: false };
async function index(root: string, applications: ApplicationInput[] = [{ name: 'api', path: '.', rust: selected }], cache?: AnalysisCache, revision?: string, ignore?: string[]) { return indexRepository(root, { config: await resolveConfig(root, { repository: { name: 'rust' }, applications, ignore }), cache, revision }); }
const unit = (g: SoftwareGraph, file: string) => g.entities.find(e => e.type === 'file' && e.path === file)!;
type Outcome = {
    specifier: string;
    kind: string;
    alias?: string;
    glob?: boolean;
    compilation: string;
    scope: string;
    range: {
        startLine: number;
    };
    outcome: {
        status: string;
        reason?: string;
        targets?: string[];
        declarations?: string[];
        conditions?: string[];
    };
};
const imports = (g: SoftwareGraph, file = 'src/lib.rs') => unit(g, file).metadata.importOutcomes as Outcome[];
const use = (g: SoftwareGraph, file = 'src/lib.rs') => imports(g, file).filter(o => o.kind !== 'module');
const names = (g: SoftwareGraph, o: Outcome) => o.outcome.declarations?.map(id => g.entities.find(e => e.id === id)?.name).sort();
const shape = (g: SoftwareGraph) => canonicalJson({ entities: g.entities, relations: g.relations, diagnostics: g.diagnostics.filter(d => !['git-metrics', 'indexer'].includes(d.analyzer) && d.code !== 'git-ignore-unavailable') });
test('Rust literal and cfg readers retain native three-valued predicates without evaluating source', () => {
    assert.equal(rustString('r##"a\\b"##'), 'a\\b');
    assert.equal(rustString('"a\\u{1f600}\\x2f"'), 'a😀/');
    assert.equal(rustString('"\\xFF"'), undefined);
    const env = { test: false, features: new Set(['api']), cfg: { flags: ['unix'], values: { target_os: ['linux'] } } };
    for (const [expression, result] of [['all(feature="api",unix,target_os="linux")', true], ['any(windows,feature="api")', true], ['not(test)', true], ['all()', true], ['any()', false], ['feature="other"', false], ['all(unix,)', true], ['not(unix,windows)', 'unknown'], ['all(unix,wrong())', 'unknown']] as const)
        assert.equal(rustCfg(expression, env), result, expression);
    assert.equal(rustCfg('unix', { test: false }), 'unknown');
    assert.equal(rustCfg('all(test,unknown)', { test: false }), false);
    assert.equal(rustAttributes(['#[cfg(feature="api")]', '#[cfg_attr(unix,path="linux.rs")]'], env).path, 'linux.rs');
    assert.equal(rustAttributes(['#[cfg_attr(unix,path="linux.rs")]'], { test: false }).gaps.length, 1);
    assert.equal(cargoRequirement('0.2.3'), '>=0.2.3 <0.3.0-0');
    assert.ok(cargoRequirement('>=1.0, <2.0'));
    assert.equal(cargoRequirement('1 || 2'), undefined);
    assert.equal(rustPath('src', '../shared.rs'), 'shared.rs');
    for (const value of ['../../outside.rs', 'C:\\private.rs', '/private.rs', 'other\\foo.rs'])
        assert.equal(rustPath('src', value), undefined);
});
test('Rust original grouped/aliased/raw/extern imports, attributes and lexical scopes survive CRLF and emoji', async () => {
    const parser = new StructureParser();
    try {
        const content = '// 😀 original\r\n#![no_std]\r\n#[cfg(feature="api")]\r\npub(crate) mod api;\r\nmod inline {pub use super::api::{self as parent, r#type as Alias,nested::{*,Thing}};fn load(){use crate::api::Thing;}}\r\nextern crate renamed as other;\r\npub const C:u32=1;pub static S:u32=1;pub enum E{A,B(u32)}';
        const facts = await parser.parse('rust', content);
        assert.equal(facts.rust?.complete, true);
        assert.equal(facts.rust?.imports.length, 6);
        assert.deepEqual(facts.rust?.imports.map(i => i.alias), ['parent', 'Alias', undefined, undefined, undefined, 'other']);
        assert.equal(facts.rust?.items.find(i => i.name === 'api')?.visibility, 'pub(crate)');
        assert.equal(facts.rust?.items.find(i => i.name === 'api')?.range.startLine, 4);
        assert.ok(facts.rust?.scopes.some(s => s.kind === 'block'));
        assert.ok(facts.rust?.scopes[0]?.attributes.includes('#![no_std]'));
        assert.ok(facts.declarations.some(d => d.kind === 'constant' && d.name === 'C'));
        assert.ok(facts.declarations.some(d => d.kind === 'variant' && d.name === 'B'));
    }
    finally {
        parser.close();
    }
});
test('Outlined and inline modules retain original declarations, module sources, aliases and private canonical re-exports', async () => {
    const root = await repo({ 'Cargo.toml': manifest(), 'src/lib.rs': '// 😀\r\nmod internal;\r\npub use crate::internal::{Thing as Public, run};\r\nmod child {use crate::Public;use super::run as local;}', 'src/internal.rs': 'pub struct Thing;pub fn run(){}' }), g = await index(root);
    assert.ok(imports(g).every(o => o.outcome.status === 'resolved'), JSON.stringify(imports(g)));
    assert.equal(imports(g)[0]?.range.startLine, 3);
    assert.deepEqual(use(g).map(o => names(g, o)), [['Thing'], ['run'], ['Thing'], ['run']]);
    const module = imports(g).find(o => o.kind === 'module')!;
    assert.deepEqual(module.outcome.targets, [unit(g, 'src/internal.rs').id]);
    assert.ok(g.relations.some(e => e.type === 'imports' && e.from === unit(g, 'src/lib.rs').id && e.to === unit(g, 'src/internal.rs').id));
    assert.equal((unit(g, 'src/lib.rs').metadata.analysis as any).features.references.status, 'unsupported');
    assert.equal(g.relations.filter(e => e.type === 'calls' && g.entities.find(x => x.id === e.from)?.language === 'rust').length, 0);
});
test('Rust module filename precedence refuses collisions and pruned/symlinked alternatives', async () => {
    for (const mode of ['both', 'denied', 'symlink'] as const) {
        const root = await repo({ 'Cargo.toml': manifest(), 'src/lib.rs': 'mod child;use crate::child::Thing;', 'src/child.rs': 'pub struct Thing;', 'src/child/mod.rs': 'pub struct Thing;' });
        if (mode === 'symlink') {
            await rm(path.join(root, 'src/child/mod.rs'));
            await symlink('../child.rs', path.join(root, 'src/child/mod.rs'));
        }
        const g = await index(root, undefined, undefined, undefined, mode === 'denied' ? ['src/child/mod.rs'] : undefined);
        assert.ok(!imports(g).some(o => o.outcome.status === 'resolved'), mode + JSON.stringify(imports(g)));
        assert.equal(g.relations.filter(e => e.type === 'imports' && e.metadata?.adapter === 'rust').length, 0, mode);
    }
});
test('Native path attributes and non-mod-rs nested directory rules resolve exact original files', async () => {
    const root = await repo({ 'Cargo.toml': manifest(), 'src/lib.rs': 'mod parent;use crate::parent::nested::Thing;', 'src/parent.rs': 'mod default_child;#[path="sibling.rs"]pub mod explicit;pub mod nested{#[path="other.rs"]pub mod leaf;pub use self::leaf::Thing;}', 'src/parent/default_child.rs': 'pub struct Local;', 'src/sibling.rs': 'pub struct Sibling;', 'src/parent/nested/other.rs': 'pub struct Thing;' }), g = await index(root);
    assert.deepEqual(names(g, use(g)[0]!), ['Thing']);
    assert.ok(imports(g, 'src/parent.rs').every(o => o.outcome.status === 'resolved'), JSON.stringify(imports(g, 'src/parent.rs')));
});
test('Scoped blocks do not export imports, locals or associated items into module namespaces', async () => {
    const root = await repo({ 'Cargo.toml': manifest(), 'src/lib.rs': 'mod a{pub struct Type;impl Type{pub fn method(){}}}fn f(){use crate::a::Type as Local;}mod b{use crate::Local;use crate::a::Type::method;}' }), g = await index(root), outcomes = use(g);
    assert.deepEqual(outcomes.map(o => o.outcome.status), ['resolved', 'unresolved', 'unsupported']);
    assert.equal(outcomes[0]!.alias, 'Local');
    assert.notEqual(outcomes[0]!.scope, outcomes[1]!.scope);
});
test('Private/pub-self/pub-super/pub-crate and ancestor restrictions govern original import accessibility', async () => {
    const root = await repo({ 'Cargo.toml': manifest(), 'src/lib.rs': 'mod internal{struct Private;pub(self) struct SelfOnly;pub(super) struct Parent;pub(crate) struct Crate;pub(in crate::internal) struct Restricted;mod child{use super::{Private,SelfOnly,Restricted};}}use crate::internal::{Private,SelfOnly,Parent,Crate,Restricted};' }), g = await index(root);
    assert.deepEqual(use(g).map(o => [o.specifier, o.outcome.status]), [['super::Private', 'resolved'], ['super::SelfOnly', 'resolved'], ['super::Restricted', 'resolved'], ['crate::internal::Private', 'unresolved'], ['crate::internal::SelfOnly', 'unresolved'], ['crate::internal::Parent', 'resolved'], ['crate::internal::Crate', 'resolved'], ['crate::internal::Restricted', 'unresolved']]);
});
test('Use globs retain direct/re-exported source members, explicit priority, namespaces and ambiguities', async () => {
    const root = await repo({ 'Cargo.toml': manifest(), 'src/lib.rs': 'mod a{pub struct A;pub fn run(){}pub enum E{One,Two(u32)}}mod b{pub use crate::a::*;}use crate::b::*;use crate::a::E::{One,Two};mod consumer{use crate::b::{A,run};}' }), g = await index(root);
    assert.ok(use(g).every(o => o.outcome.status === 'resolved'), JSON.stringify(use(g)));
    assert.deepEqual(names(g, use(g).find(o => o.specifier === 'crate::b::*')!), ['A', 'E', 'run']);
    await put(root, 'src/lib.rs', 'mod a{pub struct Name;}mod b{pub struct Name;}use crate::a::*;use crate::b::*;mod consumer{use crate::Name;}');
    const conflict = await index(root);
    assert.equal(use(conflict).at(-1)!.outcome.status, 'ambiguous');
});
test('Public source re-exports cross private canonical modules but cannot widen a private original item', async () => {
    const root = await repo({ 'Cargo.toml': manifest(), 'src/lib.rs': 'mod inner{pub struct Public;pub(crate) struct Limited;}pub use crate::inner::Public as Good;pub use crate::inner::Limited as Bad;' }), g = await index(root);
    assert.deepEqual(use(g).map(o => o.outcome.status), ['resolved', 'unsupported']);
    await put(root, 'src/lib.rs', 'mod inner{pub struct Public;pub(crate) struct Limited;}pub use crate::inner::Public as Good;pub use crate::inner::Limited as Bad;mod client{use crate::Good;use crate::Bad;}');
    const consumers = await index(root);
    assert.deepEqual(use(consumers).slice(-2).map(o => o.outcome.status), ['resolved', 'unsupported']);
});
test('Edition 2015 root use and 2018+ lexical/extern absolute paths keep distinct identities', async () => {
    for (const edition of ['2015', '2018', '2021', '2024']) {
        const root = await repo({ 'Cargo.toml': manifest('api', '', edition), 'src/lib.rs': 'mod a{pub struct Root;}mod b{mod a{pub struct Local;}use a::Root;use self::a::Local;use ::a::Root;}' }), g = await index(root);
        assert.deepEqual(use(g).map(o => o.outcome.status), edition === '2015' ? ['resolved', 'resolved', 'resolved'] : ['unresolved', 'resolved', 'unresolved'], edition + JSON.stringify(use(g)));
    }
});
test('Cargo renamed/local library targets, extern crate aliases and external dependency identities remain original', async () => {
    const root = await repo({ 'Cargo.toml': manifest('api', '[dependencies]\nrenamed={package="library-pkg",path="library",version="^1.0"}\nexternal="0.2"'), 'src/lib.rs': 'use renamed::Public;use external::Thing;extern crate renamed as alias;use alias::Public;', 'library/Cargo.toml': manifest('library-pkg', '[lib]\nname="actual_name"'), 'library/src/lib.rs': 'mod inner;pub use crate::inner::Public;', 'library/src/inner.rs': 'pub struct Public;' }), g = await index(root);
    assert.deepEqual(use(g).map(o => o.outcome.status), ['resolved', 'external', 'resolved', 'resolved']);
    assert.deepEqual(names(g, use(g)[0]!), ['Public']);
    assert.ok(use(g)[0]!.outcome.targets?.includes(unit(g, 'library/src/inner.rs').id));
    const old = await index(root, [{ name: 'api', path: '.', rust: selected }]);
    assert.equal(shape(g), shape(old));
});
test('Library crate names override unrenamed package names and siblings never become dependencies', async () => {
    const root = await repo({ 'Cargo.toml': manifest('app', '[dependencies]\nlibrary={path="library"}'), 'src/lib.rs': 'use actual::Public;use library::Public;use sibling::Private;', 'library/Cargo.toml': manifest('library', '[lib]\nname="actual"'), 'library/src/lib.rs': 'pub struct Public;', 'sibling/Cargo.toml': manifest('sibling'), 'sibling/src/lib.rs': 'pub struct Private;' }), g = await index(root);
    assert.deepEqual(use(g).map(o => o.outcome.status), ['resolved', 'unresolved', 'unresolved']);
});
test('Binaries and integration tests see the library through a separate crate boundary', async () => {
    const root = await repo({ 'Cargo.toml': manifest('app'), 'src/lib.rs': 'pub struct Public;pub(crate) struct Private;', 'src/main.rs': 'use app::{Public,Private};fn main(){}', 'tests/check.rs': 'use app::{Public,Private};' }), g = await index(root, [{ name: 'app', path: '.', rust: { ...selected, includeTests: true } }]);
    assert.deepEqual(use(g, 'src/main.rs').map(o => o.outcome.status), ['resolved', 'unresolved']);
    assert.deepEqual(use(g, 'tests/check.rs').map(o => o.outcome.status), ['resolved', 'unresolved']);
});
test('Selected Cargo target and native automatic discovery keep shared source compilations separate', async () => {
    const root = await repo({ 'Cargo.toml': manifest('app', '[[bin]]\nname="one"\npath="shared.rs"\n[[bin]]\nname="two"\npath="shared.rs"'), 'shared.rs': 'use app::Public;fn main(){}', 'src/lib.rs': 'pub struct Public;', 'src/bin/auto.rs': 'fn main(){}' }), all = await index(root);
    assert.equal((unit(all, 'shared.rs').metadata.rustCompilationContexts as unknown[]).length, 2);
    const one = await index(root, [{ name: 'app', path: '.', rust: { ...selected, target: { kind: 'bin', name: 'one' } } }]);
    assert.equal((unit(one, 'shared.rs').metadata.rustCompilationContexts as unknown[]).length, 1);
    assert.equal((unit(one, 'src/bin/auto.rs').metadata.analysis as any).features.imports.status, 'disabled');
});
test('Cargo workspace inheritance resolves declared local dependencies without exporting all member crates', async () => {
    const root = await repo({ 'Cargo.toml': '[workspace]\nmembers=["crates/*"]\nexclude=["crates/excluded"]\nresolver="2"\n[workspace.package]\nversion="1.0.0"\nedition="2021"\n[workspace.dependencies]\nshared={path="crates/shared",package="shared",default-features=false}', 'crates/app/Cargo.toml': '[package]\nname="app"\nversion.workspace=true\nedition.workspace=true\n[dependencies]\nshared.workspace=true', 'crates/app/src/lib.rs': 'use shared::Public;use other::Other;', 'crates/shared/Cargo.toml': manifest('shared'), 'crates/shared/src/lib.rs': 'pub struct Public;', 'crates/other/Cargo.toml': manifest('other'), 'crates/other/src/lib.rs': 'pub struct Other;' }), g = await index(root, [{ name: 'app', path: 'crates/app', rust: selected }]);
    assert.deepEqual(use(g, 'crates/app/src/lib.rs').map(o => o.outcome.status), ['resolved', 'unresolved']);
});
test('Recorded features, default activation and cfg_attr paths select exact native module alternatives', async () => {
    const root = await repo({ 'Cargo.toml': manifest('app', '[features]\ndefault=["api"]\napi=[]'), 'src/lib.rs': '#[cfg(feature="api")]#[cfg_attr(unix,path="unix.rs")]#[cfg_attr(windows,path="windows.rs")]mod selected;#[cfg(feature="api")]use crate::selected::Platform;', 'src/selected.rs': 'pub struct Platform;', 'src/unix.rs': 'pub struct Platform;', 'src/windows.rs': 'pub struct Platform;' });
    for (const flags of [['unix'], ['windows']] as const) {
        const g = await index(root, [{ name: 'app', path: '.', rust: { features: [], defaultFeatures: true, cfg: { flags: [...flags] } } }]);
        const use_ = use(g).find(o => o.outcome.status === 'resolved')!;
        assert.ok(use_.outcome.targets?.includes(unit(g, `src/${flags[0]}.rs`).id), JSON.stringify(use(g)));
    }
    const inactive = await index(root);
    assert.ok(imports(inactive).every(o => o.outcome.status === 'excluded'));
    const unknown = await index(root, [{ name: 'app', path: '.' }]);
    assert.ok(!imports(unknown).some(o => o.outcome.status === 'resolved'));
});
test('Optional dep and strong/weak dependency features unify inside the original invocation', async () => {
    const files = { 'Cargo.toml': manifest('app', '[dependencies]\noptional-dep={path="dep",package="dep",optional=true,default-features=false}\n[features]\nactivate=["dep:optional-dep","optional-dep?/extra"]\nweak=["optional-dep?/extra"]\nstrong=["optional-dep/extra"]'), 'src/lib.rs': 'use optional_dep::Extra;', 'dep/Cargo.toml': manifest('dep', '[features]\nextra=[]'), 'dep/src/lib.rs': '#[cfg(feature="extra")]pub struct Extra;' };
    const root = await repo(files);
    for (const feature of ['activate', 'strong']) {
        const g = await index(root, [{ name: 'app', path: '.', rust: { features: [feature], defaultFeatures: false, package: 'Cargo.toml' } }]);
        assert.equal(use(g)[0]!.outcome.status, 'resolved', feature + JSON.stringify(use(g)));
    }
    for (const feature of ['weak', 'optional-dep']) {
        const g = await index(root, [{ name: 'app', path: '.', rust: { features: [feature], defaultFeatures: false, package: 'Cargo.toml' } }]);
        assert.ok(use(g)[0]!.outcome.status !== 'resolved', feature);
    }
});
test('Target cfg and normal/dev/build dependency scopes cannot borrow source libraries from another compilation', async () => {
    const root = await repo({ 'Cargo.toml': manifest('app', '[target.\'cfg(unix)\'.dependencies]\nplatform={path="platform"}\n[dev-dependencies]\ndev={path="dev"}'), 'src/lib.rs': 'use platform::Public;use dev::Public;', 'tests/check.rs': 'use platform::Public;use dev::Public;', 'platform/Cargo.toml': manifest('platform'), 'platform/src/lib.rs': 'pub struct Public;', 'dev/Cargo.toml': manifest('dev'), 'dev/src/lib.rs': 'pub struct Public;' }), g = await index(root, [{ name: 'app', path: '.', rust: { ...selected, package: 'Cargo.toml', includeTests: true, cfg: { flags: ['unix'] } } }]);
    const contexts = [...new Set(use(g).map(o => o.compilation))];
    assert.equal(contexts.length, 2);
    for (const compilation of contexts)
        assert.deepEqual(use(g).filter(o => o.compilation === compilation).map(o => o.outcome.status), ['resolved', 'unresolved']);
    assert.deepEqual(use(g, 'tests/check.rs').map(o => o.outcome.status), ['resolved', 'resolved']);
    const other = await index(root, [{ name: 'app', path: '.', rust: { ...selected, package: 'Cargo.toml', cfg: { flags: ['windows'] } } }]);
    assert.equal(use(other)[0]!.outcome.status, 'excluded');
});
test('Build scripts, source overrides, proc macros, generated source and unknown cfg remain explicit gaps', async () => {
    for (const extra of ['build="build.rs"\n', '[patch.crates-io]\nexternal={path="dep"}\n', '[lib]\nproc-macro=true\n']) {
        const root = await repo({ 'Cargo.toml': manifest('app', extra), 'src/lib.rs': 'mod a{pub struct Public;}use crate::a::Public;' }), g = await index(root);
        assert.equal(use(g)[0]!.outcome.status, 'unsupported', extra + JSON.stringify(use(g)));
    }
    const root = await repo({ 'Cargo.toml': manifest(), 'src/lib.rs': 'include!("generated.rs");mod a{pub struct Public;}use crate::a::Public;', 'generated.rs': 'pub struct Generated;' }), g = await index(root);
    assert.equal(use(g)[0]!.outcome.status, 'unsupported');
    assert.equal((unit(g, 'generated.rs').metadata.analysis as any).features.imports.status, 'disabled');
});
test('Std/core/alloc and no_std/no_implicit_prelude preserve native extern identities and original shadows', async () => {
    for (const [source, statuses] of [['use std::collections::HashMap;use core::option::Option;', ['external', 'external']], ['#![no_std]\nuse std::collections::HashMap;use core::option::Option;extern crate alloc;use alloc::vec::Vec;', ['unresolved', 'external', 'external', 'external']], ['#![no_implicit_prelude]\nuse std::collections::HashMap;extern crate std as explicit;use explicit::collections::HashMap;', ['unresolved', 'external', 'external']], ['mod std{pub struct Local;}use std::Local;use std::collections::HashMap;', ['resolved', 'unresolved']]] as const) {
        const root = await repo({ 'Cargo.toml': manifest(), 'src/lib.rs': source }), g = await index(root);
        assert.deepEqual(use(g).map(o => o.outcome.status), statuses, source + JSON.stringify(use(g)));
    }
});
test('Rust cache/revision replay invalidates source, features, manifests, locations and denied imports', async () => {
    const root = await repo({ 'Cargo.toml': manifest('app', '[features]\napi=[]'), 'src/lib.rs': 'mod a;use crate::a::Public;', 'src/a.rs': 'pub struct Public;' }), state = await repo({});
    async function replay(config: RustConfig = selected, ignore?: string[]) { const cache = new AnalysisCache(state), g = await index(root, [{ name: 'app', path: '.', rust: config }], cache, undefined, ignore); assert.equal(shape(g), shape(await index(root, [{ name: 'app', path: '.', rust: config }], undefined, 'recorded', ignore))); return { g, events: cache.events }; }
    await replay();
    const warm = await replay();
    assert.ok(warm.events.some(e => e.analyzer === 'rust-imports' && e.hit));
    const before = names(warm.g, use(warm.g)[0]!);
    await put(root, 'src/a.rs', '// shifted 😀\r\npub struct Public;');
    let { g } = await replay();
    assert.deepEqual(names(g, use(g)[0]!), before);
    assert.equal(g.entities.find(e => e.path === 'src/a.rs' && e.name === 'Public')?.sourceRange?.startLine, 2);
    await put(root, 'src/a.rs', '#[cfg(feature="api")]pub struct Public;');
    g = (await replay()).g;
    assert.equal(use(g)[0]!.outcome.status, 'unresolved');
    g = (await replay({ ...selected, features: ['api'] })).g;
    assert.equal(use(g)[0]!.outcome.status, 'resolved');
    g = (await replay({ ...selected, features: ['api'] }, ['src/a.rs'])).g;
    assert.equal(use(g)[0]!.outcome.status, 'unsupported');
});
test('Malformed/denied Cargo manifests and unknown targets never infer a crate from nearby Rust filenames', async () => {
    const root = await repo({ 'Cargo.toml': '[package', 'src/lib.rs': 'mod a{pub struct Public;}use crate::a::Public;', 'extra.rs': 'use std::io;' }), g = await index(root);
    assert.equal((unit(g, 'src/lib.rs').metadata.analysis as any).features.imports.status, 'disabled');
    assert.equal((unit(g, 'extra.rs').metadata.analysis as any).features.imports.status, 'disabled');
    for (const rust of [{ features: ['../bad'] }, { package: '../../Cargo.toml' }, { target: { kind: 'tool', name: 'x' } }, { cfg: { flags: ['test'] } }, { cfg: { values: { feature: ['x'] } } }, { unknown: true }])
        await assert.rejects(() => resolveConfig(root, { applications: [{ name: 'app', path: '.', rust }] } as any), /Rust|escapes|outside/);
});
test('Private source and binary aliases do not export their targets to other modules', async () => {
    const root = await repo({ 'Cargo.toml': manifest('app', '[dependencies]\nexternal="1"'), 'src/lib.rs': 'mod origin{pub struct Public;}mod hidden{use crate::origin::Public as PrivateAlias;use external::Type as ExternalAlias;}mod client{use crate::hidden::{PrivateAlias,ExternalAlias};}' }), g = await index(root);
    assert.deepEqual(use(g).map(o => o.outcome.status), ['resolved', 'external', 'unresolved', 'unresolved']);
    assert.ok(!g.relations.some(edge => edge.type === 'imports' && edge.metadata?.specifier === 'crate::hidden::PrivateAlias'));
});
test('Source types and values share a spelling only across native disjoint namespaces', async () => {
    const root = await repo({ 'Cargo.toml': manifest(), 'src/lib.rs': 'mod types{pub struct Both{field:u32}}mod values{pub fn Both(){}}use crate::types::Both;use crate::values::Both;mod client{use crate::Both;}' }), g = await index(root);
    assert.deepEqual(use(g).map(o => o.outcome.status), ['resolved', 'resolved', 'resolved']);
    assert.equal(use(g).at(-1)!.outcome.declarations?.length, 2);
    await put(root, 'src/lib.rs', 'pub struct Both{field:u32}mod values{pub fn Both(){}}use crate::values::Both;mod client{use crate::Both;}');
    const valid = await index(root);
    assert.deepEqual(use(valid).map(o => o.outcome.status), ['resolved', 'resolved']);
    assert.equal(use(valid).at(-1)!.outcome.declarations?.length, 2);
    await put(root, 'src/lib.rs', 'pub struct Both;mod values{pub fn Both(){}}use crate::values::Both;mod client{use crate::Both;}');
    const unitStruct = await index(root);
    assert.equal(use(unitStruct).at(-1)!.outcome.status, 'ambiguous');
});
test('Absolute globs, grouped comments and raw cfg/path strings retain native parsing', async () => {
    const root = await repo({ 'Cargo.toml': manifest('app', '[dependencies]\nexternal="1"'), 'src/lib.rs': 'mod external{pub struct Local;}use ::external::*;mod a{pub struct One;pub struct Two;}use crate::a::{One,/* 😀 */Two};#[cfg_attr(unix,path=r##"comma\",quoted.rs"##)]mod raw;use crate::raw::Public;', 'src/comma",quoted.rs': 'pub struct Public;' }), g = await index(root, [{ name: 'app', path: '.', rust: { ...selected, cfg: { flags: ['unix'] } } }]);
    assert.deepEqual(use(g).map(o => o.outcome.status), ['external', 'resolved', 'resolved', 'resolved']);
    assert.equal(use(g)[0]!.specifier, '::external::*');
    assert.equal(rustCfg('custom=r##"a\",b"##', { test: false, cfg: { values: { custom: ['a",b'] } } }), true);
    assert.equal(rustString('r#"a"#b"#'), undefined);
});
test('Recorded target triples select dependency tables without inferring host cfg', async () => {
    const root = await repo({ 'Cargo.toml': manifest('app', '[target.x86_64-unknown-linux-gnu.dependencies]\nplatform={path="platform"}'), 'src/lib.rs': 'use platform::Public;', 'platform/Cargo.toml': manifest('platform'), 'platform/src/lib.rs': 'pub struct Public;' });
    for (const [targetTriple, status] of [[undefined, 'unsupported'], ['x86_64-unknown-linux-gnu', 'resolved'], ['x86_64-pc-windows-msvc', 'excluded']] as const) {
        const g = await index(root, [{ name: 'app', path: '.', rust: { ...selected, package: 'Cargo.toml', ...(targetTriple ? { targetTriple } : {}) } }]);
        assert.equal(use(g)[0]!.outcome.status, status);
    }
    await put(root, 'Cargo.toml', manifest('app', '[features]\napi=[]\n[target.\'cfg(feature="api")\'.dependencies]\nplatform={path="platform"}'));
    const unsupported = await index(root, [{ name: 'app', path: '.', rust: { ...selected, features: ['api'], cfg: { flags: [] } } }]);
    assert.equal(use(unsupported)[0]!.outcome.status, 'unsupported', 'Cargo dependency cfg cannot borrow source feature predicates');
});
test('Cyclic path dependencies, duplicate automatic targets and denied ancestor Cargo config retain gaps', async () => {
    const root = await repo({ 'Cargo.toml': manifest('app', '[dependencies]\ndep={path="dep"}'), 'src/lib.rs': 'use dep::Public;', 'dep/Cargo.toml': manifest('dep', '[dependencies]\napp={path=".."}'), 'dep/src/lib.rs': 'pub struct Public;' }), g = await index(root);
    assert.equal(use(g)[0]!.outcome.status, 'unsupported');
    const duplicate = await repo({ 'Cargo.toml': manifest('app'), 'src/lib.rs': 'pub struct Public;', 'src/bin/tool.rs': 'use app::Public;fn main(){}', 'src/bin/tool/main.rs': 'use app::Public;fn main(){}' }), duplicated = await index(duplicate);
    assert.equal(use(duplicated, 'src/bin/tool.rs')[0]!.outcome.status, 'unsupported');
    assert.equal((unit(duplicated, 'src/bin/tool/main.rs').metadata.analysis as any).features.imports.status, 'disabled');
    const config = await repo({ '.cargo/config.toml': '[build]\nrustflags=["--cfg","custom"]', 'nested/Cargo.toml': manifest(), 'nested/src/lib.rs': 'mod a{pub struct Public;}use crate::a::Public;' }), configured = await index(config, [{ name: 'nested', path: 'nested', rust: selected }], undefined, undefined, ['.cargo']);
    assert.equal(use(configured, 'nested/src/lib.rs')[0]!.outcome.status, 'unsupported');
});
test('Invalid inherited dependency overrides and unreviewed item attributes cannot certify generated bindings', async () => {
    const root = await repo({ 'Cargo.toml': '[workspace]\nmembers=["app","dep"]\nresolver="2"\n[workspace.dependencies]\ndep={path="dep"}', 'app/Cargo.toml': manifest('app', '[dependencies]\ndep={workspace=true,path="../dep"}'), 'app/src/lib.rs': 'use dep::Public;', 'dep/Cargo.toml': manifest('dep'), 'dep/src/lib.rs': 'pub struct Public;' }), g = await index(root, [{ name: 'app', path: 'app', rust: selected }]);
    assert.equal(use(g, 'app/src/lib.rs')[0]!.outcome.status, 'unsupported');
    const generated = await repo({ 'Cargo.toml': manifest(), 'src/lib.rs': '#[custom::generate]fn generated(){}mod a{pub struct Public;}use crate::a::Public;' }), gap = await index(generated);
    assert.equal(use(gap)[0]!.outcome.status, 'unsupported');
});
test('Cargo optional version defaults and implicit workspace path members retain original metadata', async () => {
    const root = await repo({ 'Cargo.toml': '[workspace]\nmembers=["app"]\nresolver="2"\n[workspace.package]\nedition="2021"\n[workspace.dependencies]\ndep={path="dep"}', 'app/Cargo.toml': '[package]\nname="app"\nedition.workspace=true\n[dependencies]\ndep.workspace=true', 'app/src/lib.rs': 'use dep::Public;', 'dep/Cargo.toml': '[package]\nname="dep"\nedition.workspace=true', 'dep/src/lib.rs': 'pub struct Public;' }), g = await index(root, [{ name: 'app', path: 'app', rust: selected }]);
    assert.equal(use(g, 'app/src/lib.rs')[0]!.outcome.status, 'resolved');
    const projects = g.entities.find(e => e.type === 'repository')!.metadata.rustProjects as any[];
    assert.ok(projects.every(p => p.version === '0.0.0' && p.workspace === '.' && p.edition === '2021'));
});
test('Malformed Cargo metadata produces an inspectable manifest diagnostic with replay equality', async () => {
    const root = await repo({ 'Cargo.toml': '[package', 'src/lib.rs': 'pub struct Public;' }), state = await repo({}), g = await index(root, undefined, new AnalysisCache(state)), warm = await index(root, undefined, new AnalysisCache(state));
    assert.equal(shape(g), shape(warm));
    assert.ok(g.diagnostics.some(d => d.code === 'rust-manifest-gap' && d.file === 'Cargo.toml'));
    assert.deepEqual(g.entities.find(e => e.type === 'repository')!.metadata.rustManifestOutcomes, [{ file: 'Cargo.toml', status: 'failed', gaps: ['Original Cargo manifest is malformed/denied/unavailable'] }]);
});
test('Root extern crate aliases populate the native 2018+ prelude while no_implicit_prelude disables it', async () => {
    const root = await repo({ 'Cargo.toml': manifest('app', '[dependencies]\ndep={path="dep"}'), 'src/lib.rs': 'extern crate alloc;extern crate dep as renamed;mod child{use alloc::vec::Vec;use renamed::Public;use ::renamed::Public;}', 'dep/Cargo.toml': manifest('dep'), 'dep/src/lib.rs': 'pub struct Public;' }), g = await index(root);
    assert.deepEqual(use(g).map(o => o.outcome.status), ['external', 'resolved', 'external', 'resolved', 'resolved']);
    await put(root, 'src/lib.rs', '#![no_implicit_prelude]\nextern crate dep;use dep::Public;use ::dep::Public;mod child{use dep::Public;use crate::dep::Public;}');
    const none = await index(root);
    assert.deepEqual(use(none).map(o => o.outcome.status), ['resolved', 'resolved', 'unresolved', 'unresolved', 'resolved']);
    await put(root, 'Cargo.toml', manifest('app', '', '2015'));
    await put(root, 'src/lib.rs', '#![no_std]\nuse core::option::Option;');
    assert.equal(use(await index(root))[0]!.outcome.status, 'external');
});
test('Source-neutral Cargo config is recorded; compilation flags and malformed config invalidate replay', async () => {
    const root = await repo({ 'Cargo.toml': manifest(), '.cargo/config': '[resolver]\nincompatible-rust-versions="fallback"\n[alias]\ncheck-all="check --workspace"', 'src/lib.rs': 'mod a{pub struct Public;}use crate::a::Public;' }), state = await repo({});
    const g = await index(root, undefined, new AnalysisCache(state));
    assert.equal(use(g)[0]!.outcome.status, 'resolved');
    const warmCache = new AnalysisCache(state), warm = await index(root, undefined, warmCache);
    assert.equal(shape(g), shape(warm));
    assert.ok(warmCache.events.some(e => e.analyzer === 'rust-imports' && e.hit));
    const projects = g.entities.find(e => e.type === 'repository')!.metadata.rustProjects as any[];
    assert.equal(projects[0].configuration[0].status, 'source-neutral');
    assert.equal(projects[0].configuration[0].inputs.resolver['incompatible-rust-versions'], 'fallback');
    for (const config of ['[build]\nrustflags=["--cfg","changed"]', '[build', 'alias=42','resolver=[]']) {
        await put(root, '.cargo/config', config);
        const cache = new AnalysisCache(state), changed = await index(root, undefined, cache);
        assert.equal(use(changed)[0]!.outcome.status, 'unsupported');
        assert.ok(cache.events.some(e => e.analyzer === 'rust-imports' && !e.hit));
        assert.equal(shape(changed), shape(await index(root, undefined, undefined, 'recorded')));
    }
});
test('Invalid path package identities, version requirements and library names retain gaps', async () => {
    for (const definition of ['{path="dep",package=42}', '{path="dep",version="^2.0"}']) {
        const root = await repo({ 'Cargo.toml': manifest('app', `[dependencies]\ndep=${definition}`), 'src/lib.rs': 'use dep::Public;', 'dep/Cargo.toml': manifest('dep'), 'dep/src/lib.rs': 'pub struct Public;' });
        assert.equal(use(await index(root))[0]!.outcome.status, 'unsupported');
    }
    const root = await repo({ 'Cargo.toml': manifest('app', '[lib]\nname="invalid-name"'), 'src/lib.rs': 'mod a{pub struct Public;}use crate::a::Public;' });
    assert.equal(use(await index(root))[0]!.outcome.status, 'unsupported');
    for(const cargo of [manifest('app','[lib]\nname=true'),manifest('app','[lib]\nharness=42'),'lib=42\n'+manifest('app')]){const invalid=await repo({'Cargo.toml':cargo,'src/lib.rs':'mod a{pub struct Public;}use crate::a::Public;'});assert.equal(use(await index(invalid))[0]!.outcome.status,'unsupported');}
    const edition=await repo({'Cargo.toml':'[package]\nname="app"\nversion="1.0.0"\nedition=2021\nresolver=2','src/lib.rs':'mod a{pub struct Public;}use crate::a::Public;'});assert.equal(use(await index(edition))[0]!.outcome.status,'unsupported');
});

test('Restricted visibility requires an original ancestor module and preserves the 2015 root path rule',async()=>{
  for(const edition of ['2015','2021']){const root=await repo({'Cargo.toml':manifest('app','',edition),'src/lib.rs':'mod outer{pub(in outer)struct Old;pub(in crate::outer)struct Modern;pub(in crate::sibling)struct Invalid;mod child{use super::{Old,Modern,Invalid};}}mod sibling{}'}),g=await index(root);assert.deepEqual(use(g).map(o=>o.outcome.status),edition==='2015'?['resolved','resolved','unresolved']:['unresolved','resolved','unresolved']);}
});
