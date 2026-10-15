# Structural grammar assets

These pinned WebAssembly artifacts ship with the CLI. No target-language
toolchain, dependency installation, grammar compilation or network access is
needed to index a repository. The TypeScript compiler and PHP parser remain
the authoritative parsers for their languages.

`manifest.json` records each grammar's upstream revision, artifact package and
version, SHA-256, language ABI and license. Six artifacts come from the pinned
VS Code grammar bundle; Kotlin, C, C++, Objective-C, ERB and auxiliary HTML come from their upstream grammar packages. The
bundle's build revision and each upstream license are retained here. Swift 0.7.3 and Scala 0.26.2 come from pinned upstream release WASM assets,
with immutable source revisions and artifact URLs/checksums; these are not npm artifacts. F# uses the distinct upstream 0.3.12 implementation/signature releases (ABI 15), with the original MIT notice. The public language stays `fsharp`; `.fsi` selects `fsharp-signature`, while `.fs`/`.fsx` select `fsharp`. Both artifact/query hashes participate in cache identity. The
runtime is pinned in `package.json` and the manifest. Groovy uses generated C from the
community `@dekobon/tree-sitter-groovy` 0.3.0 package, built once with pinned
Tree-sitter CLI 0.26.9, wasi-sdk 29.0 and a Linux container digest. Its MIT license
option is retained. `artifactBuild` records source SHA-512, toolchain SHA-256,
container and rebuild script; its WASM is a source build, not an upstream WASM release.

`npm run grammars:sync` restores the twelve npm WASM artifacts from installed
development dependencies after verifying versions/checksums, and verifies the
committed Swift/Scala/F# source and signature release assets and source-built Groovy/VB.NET assets. It runs offline and compiles nothing. To restore
the Swift/Scala/F# source and signature release assets explicitly, run
`npm run grammars:sync -- --download-releases`; this downloads the pinned URL
and verifies its checksum before writing it. Normal CLI builds verify and copy this directory
to `dist/grammars/`. An installed package loads it relative to its own module,
so the current working directory does not affect asset lookup. An explicit maintainer
rebuild runs `node scripts/build-groovy-grammar.mjs`: verified published generated
C, CLI and SDK archives compile inside the pinned Linux/amd64 Docker container,
without network or upstream npm/grammar-generation scripts. The result must match
the committed checksum before replacement. Optional `--artifacts DIRECTORY` reads
offline `source.tgz`, `cli.gz`, `sdk.tgz` mirrors with the same checksum checks.

Codiluce owns `queries/<language>/declarations.scm`. Query and manifest changes
invalidate structural fact caches and historical analysis identities. A new
grammar release requires declaration, range, overload, malformed-source and
installed-package conformance checks before updating the checksum.

`queries/<language>/metrics.scm` describe the syntax behind code health metrics
(function length, complexity, nesting, parameters) for one shared engine,
`src/analysis/metrics/measure.ts`, whose header defines the captures and rules.
`tests/fixtures/health/` writes the same functions in each language and
`tests/health-metrics.test.ts` requires identical metrics. Metrics queries
exist for Python and Go, and for TypeScript (with TSX), JavaScript and PHP,
whose grammars are not shipped yet: the prototype loads those three from the
`@vscode/tree-sitter-wasm` development dependency. Metrics queries do not take
part in structural cache identities.

The current adapters extract named types, modules/namespaces, functions and
methods for Python, Go, Ruby, Rust, Java, C#, Kotlin, C, C++, Objective-C, Swift, Scala, Groovy, F# and VB.NET. Decorators/annotations,
modifiers, signatures and lexical containment are preserved where the grammar
exposes them. Local Go receivers and Rust impl methods attach only to a unique
type in the same file; cross-file ownership and language binding belong to the
resolver phases. Ruby reopenings and C# partial declarations remain individual
source declarations. Anonymous expressions, generated code, macro expansion,
inferred types are outside this subset. Properties/fields are language-specific;
C/C++ retain original fields, variables, typedefs, enum members, macros,
namespaces, aliases, concepts, constructors/destructors and callable signatures.

C 0.24.1 (ABI 15) and C++ 0.23.4 (ABI 14) ship their official MIT-licensed
WASM artifacts. Declarator operator order distinguishes prototypes/definitions
from function-pointer data, including function-returning pointers/references.
`declarationForm` keeps original declarations and body-bearing/explicitly
initialized definitions separate. Uninitialized data and field syntax remain
declarations; the adapter does not classify compiler-level tentative definitions. Includes
and preprocessor branch headers are retained as syntax in `cfamilySyntax`;
`sourceConditions` record enclosing source directives, not evaluated predicates.
Both branches remain visible. Anonymous scopes explicitly record anonymous
metadata. No includes, macros, compiler, target dependencies or template
instantiations execute. Imports/references/framework/effects/guards remain
unsupported. Out-of-line C++ definitions attach only to a unique exact original
type in the same file and directive context. Others retain qualified names and
an explicit translation-unit/type-binding condition; headers cannot supply
inferred ownership. See [original-source qualification](../docs/cfamily-source-accuracy.html).

Objective-C uses the official `tree-sitter-objc` 3.0.2 WASM (ABI 14, MIT).
Interfaces, implementations, categories/extensions, protocols, forward
declarations and compatibility aliases remain separate original declarations.
Methods retain selector spelling, `dispatch` (class/instance), signed qualified
names and declaration/definition forms. Properties, ivars, atomic/bitfield
declarations, block-pointer data, C helpers/typedefs and original module/import,
synthesis and dynamic syntax are retained. Synthesized ivars/accessors and
message dispatch never produce entities or semantic edges. Ownership is lexical;
logical interface/implementation merging and header/type binding remain open.

When annotation/macro syntax hides a container from the full-file parse, the
adapter can parse an exact self-contained original Objective-C region and
remap its ranges to the original file. It does not rewrite, prefix or expand
source; every recovered declaration records a source-context gap. Discovery
excludes strings, raw C++ strings, comments and preprocessor lines. Recovered
files remain partial. `objcSyntax` stores original module/property-implementation
syntax and recovery ranges. The current grammar extends C.

P10a2b adds original `NS_ENUM`, `NS_CLOSED_ENUM`, `NS_OPTIONS`, `CF_ENUM`,
`CF_CLOSED_ENUM` and `CF_OPTIONS` source profiles. Explicit type/member names,
raw initializers and directive alternatives are retained without evaluating values
or expanding macros. Source definitions/undefinitions invalidate standard profiles;
oversized/unreviewed directive context prevents profiling. SDK types and ABI remain
unverified, and unsupported macro argument/member forms produce explicit gaps.

Mixed `.mm` files and recognized C++-bearing Objective-C headers read the same
original bytes through separate Objective-C and C++ grammars. Native namespaces,
classes/templates/aliases and callable headers coexist with original Objective-C
containers/selectors. Original C++ AST subtrees can retain declarations obscured
by surrounding macro/parser recovery, with explicit context conditions. A bounded
selector-header profile retains raw C++ return/parameter syntax. Native namespace
containment is lexical; C++ facts cannot originate inside Objective-C containers.
There is no source rewrite, synthetic prefix, SDK/compiler execution, macro
expansion, shared type/import binding or runtime message dispatch. Mixed files
remain explicitly partial. C++ ivar fields, nested native types inside Objective-C
method bodies, arbitrary macro wrappers and broader annotation/template syntax
still require qualification.

Primary and auxiliary grammar/query hashes participate in cache identities;
assets are checked on warm reads. Missing C++ assets retain original Objective-C
containers/selectors with an explicit gap, while standalone C remains usable.
Imports, references, framework, effects and guards remain unsupported. See
[macro/mixed original-source qualification](../docs/objc-cpp-source-accuracy.html)
and the [historical P10a2a source inventory](../docs/objc-source-accuracy.html).

Swift uses the official upstream 0.7.3 release WASM (ABI 15, MIT). Original
classes/structs/enums/actors/protocols/extensions retain separate lexical owners;
there is no extension/type merging. Original functions/methods, parameter labels
(`swiftName`), overloaded signatures, async/typed throws, generic constraints,
initializers/deinitializers/subscripts, native operators/precedence groups,
properties, enum cases, aliases and associated types retain original ranges.
Local bindings and generated accessors/memberwise initializers/enum factories
add no declarations. Headers remove actual AST comments without rewriting source.

`swiftSyntax` stores original imports, conditional directives and macro invocations.
Branches retain source conditions without evaluation. Unknown potentially generating
attributes and macro invocations produce explicit expansion gaps. The pinned grammar
can emit a zero-width recovery error for `#if` directly inside a type body: valid
headers/branch context survive with a partial outcome. Invalid headers add no guessed
facts. No Swift compiler, SDK, SwiftPM manifest, target dependencies or application
executes. Imports, cross-file extension/type binding, references, frameworks, effects
and guards remain unsupported. Asset/query/source-version changes invalidate caches;
missing Swift assets fail Swift files independently. See the
[original Swift source audit](../docs/swift-source-accuracy.html).

Scala uses the official upstream v0.26.2 release WASM (ABI 15, MIT). Consecutive
unbraced packages and explicit braced/indented package bodies retain native
lexical namespace context, without extending original package-clause ranges.
Classes, traits, objects and package objects remain separate original declarations;
case-class companions, primary constructors, inferred constructor properties and
accessors are not synthesized. Explicit val/var constructor properties, native
functions/methods, secondary constructors, curried/implicit/using headers, symbolic
and escaped names, aliases/opaque/match types, enum cases, pattern bindings and
named givens retain original syntax. Local values/parameters stay excluded.

Extension methods retain original receiver/context headers in signatures and
`scalaExtension`, while their ranges start at the actual method declaration.
No receiver-type/extension dispatch binding is inferred. `scalaSyntax` records
package headers (`explicitBody` distinguishes enclosing package bodies), imports,
exports, givens, extensions, Scala CLI directives and staged source syntax.
Anonymous given/instance members keep their original names with explicit owner
gaps, without generated class/given names. Derives and macro/quote/splice syntax
remain unexpanded; quoted/generated declarations do not produce entities. Imports,
type/implicit/reference/framework/effect/guard binding remain unsupported. No JVM,
Scala compiler, sbt/Scala CLI, target configuration/build script, dependency or
application executes. Missing Scala assets affect its own files; asset/query/source
versions invalidate cache and history identities. See the
[original Scala source audit](../docs/scala-source-accuracy.html).

Non-callable declarations use the existing graph `class` type with a
`declarationKind`/`role`; properties exposed by C# use `method` with role
`property`. The inspector displays the actual kind. No new graph schema is
required. Graph symbol identities contain language, application, file,
qualified name, kind and normalized signature, without line numbers. C/C++
identities also include declaration form; existing language identities are unchanged.

The parser runs in a disposable child process, with a 10-second job deadline,
a 256 MB V8 heap limit and extraction budgets. Grammars load lazily. Recovered
syntax produces partial outcomes and retains valid declarations; missing or
corrupt assets fail only the affected files. Every code file records actual
feature outcomes in `metadata.analysis`. A declaration-only adapter does not
place its files in the call/flow coverage denominator.

Groovy uses the community dekobon v0.3.0 grammar (ABI 15; dual Apache-2.0/MIT,
MIT option retained), not a Java facade or an Apache-maintained grammar. Original
packages establish lexical ownership without extending source ranges. Native
classes/traits/interfaces/annotation types/enums/records/components, constructors,
methods/script functions, quoted names, generic/default/vararg/throws headers,
properties/explicit-access fields and script bindings retain source spelling.
Untyped class-body callables are constructors only when their original name
matches the enclosing type. Properties, records, traits and scripts never
synthesize accessors, helpers, script classes or run/main methods. Closures and
DSL invocations never become inferred named callbacks or registrations.

`groovySyntax` records bounded packages/import aliases/static stars, annotations
and DSL headers. Import/type/receiver/delegate/metaprogramming binding, references,
frameworks, effects and guards remain unsupported. Recognized AST-generation and
Grape annotations retain explicit gaps; custom annotation resolution is unverified.
The grammar does not qualify annotated parameters, nested types, Unicode names,
some command-style named arguments or typed script declarations without initializers.
Groovy 5 contextual keywords and newer compiler semantics remain unqualified.
Malformed native headers, reserved parameter names and interpolated quoted callable names omit callables. Damaged
class-body recovery retains original type headers with header-only ranges and
omits member/script declarations across that file to prevent ownership spills;
this intentionally sacrifices recall. Errors inside otherwise valid method bodies
retain their original method headers. Limits cover nodes/declarations/metadata,
diagnostics/context depth/query matches, with explicit partial outcomes.

Groovy sources, Gradle, Jenkinsfile and upstream gvy/gy extensions are code. No
JVM/Groovy compiler, AST transform, Grape download, Gradle/Jenkins, target build
script, dependency or application executes. Asset/query/source changes invalidate
fact/history identities; warm reads verify assets. Missing Groovy assets affect
only its files. Twenty-nine cases and the
[original Groovy source audit](../docs/groovy-source-accuracy.html) cover the initial
subset and negative profiles, including ten deliberately omitted FileTreeBuilder
members. Wider grammar/source accuracy and native OS qualification remain open.

F# source/signature profiles retain original namespaces/modules, clear bindings,
records/fields/unions/cases/named payloads, enums/exceptions/delegates, explicit
class/struct/member/property/new-constructor headers, operators/active patterns,
source attributes/directives and original extension/interface context. No compiler/FSI,
project build, signature/implementation merge, assembly load, type provider,
quotation execution or compiler-created CLR entity is inferred.

Qualification remains bounded: class signatures, equality constraints and newer
nullable types have known grammar gaps. Bare single-case union/type aliases and
capitalized binding/pattern heads retain explicit ambiguity gaps. External declarations
and named functions inside anonymous lambdas/computations remain unqualified. An
upstream WASM trap on a 1,000-statement function fails its own file; the process is
discarded before later jobs. Thirty-three conformance cases and the
[original F# source/signature audit](../docs/fsharp-source-accuracy.html) preserve
147/158 reviewed declarations, with eleven documented omissions and zero extras.
Broader source accuracy, project/import binding and native-platform/mixed-memory
qualification remain open.


VB.NET uses `CodeAnt-AI/tree-sitter-vb-dotnet` 0.1.9 generated C at
`cfca210ce8fdcb5245bd9cd5c47ce0a21a8488d5`, with the same pinned CLI/SDK/container
as Groovy. `node scripts/build-vbnet-grammar.mjs [--artifacts DIRECTORY]` compiles
only the published generated C inside an isolated network-free container and
requires the exact committed 1,496,364-byte ABI-14 WASM checksum. Normal sync and
installed indexing compile nothing and use no network. The archive/source tree
has no separate LICENSE file: the exact original grammar.js author/MIT header
and package/tree-sitter MIT declarations are retained with standard MIT terms
in `licenses/vbnet.txt`; no copyright holder/year is invented.

The bounded original VB profile retains namespaces/modules, classes/structures/
interfaces/enums/members, delegates, module procedures/type methods, each field/
constant binder, properties/accessor headers, regular events and explicit source
`Sub New` constructors. Original Option, Imports, attributes and native conditional
directives retain UTF-16 source evidence. ASCII identifier/keyword case and bracket
spelling are canonicalized only for source IDs; original names, signatures, evidence
and literal spelling remain intact. Unicode compiler case equivalence and identifier
type-character agreement remain unverified. No implicit project root namespace,
partial merge, Imports resolution, Handles/Implements binding, CLR/generated helper,
preprocessor branch, runtime, target dependency or application is inferred/executed.

Valid generic/nested-type/inheritance layouts, custom events, LINQ/XML and import
aliases have known upstream grammar gaps. Recovered scope bodies retain only intact
original headers and quarantine uncertain members; damaged headers are omitted.
Root recovery also quarantines potentially spilled members. Header/node/query/
metadata/diagnostic limits are explicit. The conformance cases and
[immutable original VB source audit](../docs/vbnet-source-accuracy.html) qualify this
limited profile; wider VB grammar/project/import/framework accuracy, mixed process-tree
memory and native OS release gates remain open.


ERB adds a sixteenth structural adapter and two pinned MIT npm WASM assets:
`tree-sitter-embedded-template` 0.25.0 (ABI 15, 5,531 bytes) and auxiliary
`tree-sitter-html` 0.23.2 (ABI 14, 18,385 bytes). Together with the existing
Ruby grammar these preserve native original ERB code/output/comment/literal
regions, original Ruby module/class/method headers and lexical owners spanning
template blocks. `.html.erb`, legacy `.rhtml` and an original leading HTML doctype also select HTML and retain original HTML
script/style ranges, literal attributes and named literal JavaScript functions/callable variable initializers,
classes, methods/accessors and explicit constructors. Other ERB host extensions
retain Ruby source without guessing HTML. One original template component owns
source declarations; no generated render function, output helper or virtual graph
file is created. Ruby/HTML artifact/query hashes and the actual TypeScript version/literal-JavaScript profile participate in cache identity;
missing auxiliary assets preserve the independent source regions.

ERB processing precedes HTML, including tags inside HTML comments and script
strings. Ruby/host syntax projections preserve UTF-16 positions and newlines;
only original code bytes enter the Ruby projection, with delimiter separators.
Original headers retain literal spelling. Unknown percent-line engine options,
EJS/Erubi extension delimiters, trim/escape agreement, recovery and rendered
client interpolation produce explicit gaps. Only literal JavaScript in explicit
HTML hosts is qualified; processor/data/external/dynamic scripts and typed syntax
are excluded. JavaScript syntax checks use an in-memory host with no filesystem
reads, resolution, emit or target execution. CSS retains regions only.
Imports/references/framework/effects/guards, Rails rendering/layout/partial binding,
view/receiver/runtime ownership, compiled-output equivalence and Razor/Liquid
remain unimplemented. Bounded conformance, installed-package/history/isolation,
and the [immutable original ERB region audit](../docs/erb-source-accuracy.html)
qualify this initial profile; broader grammar/template/engine accuracy and native
platform/process-tree budgets remain open.
