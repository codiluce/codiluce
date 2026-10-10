# Structural grammar assets

These pinned WebAssembly artifacts ship with the CLI. No target-language
toolchain, dependency installation, grammar compilation or network access is
needed to index a repository. The TypeScript compiler and PHP parser remain
the authoritative parsers for their languages.

`manifest.json` records each grammar's upstream revision, artifact package and
version, SHA-256, language ABI and license. Six artifacts come from the pinned
VS Code grammar bundle; Kotlin, C, C++ and Objective-C come from their upstream grammar packages. The
bundle's build revision and each upstream license are retained here. The
runtime is pinned in `package.json` and the manifest.

`npm run grammars:sync` restores WASM files from the installed development
dependencies, after verifying package versions and checksums. It does not
download or compile anything. Normal CLI builds verify and copy this directory
to `dist/grammars/`. An installed package loads it relative to its own module,
so the current working directory does not affect asset lookup.

Codiluce owns `queries/<language>/declarations.scm`. Query and manifest changes
invalidate structural fact caches and historical analysis identities. A new
grammar release requires declaration, range, overload, malformed-source and
installed-package conformance checks before updating the checksum.

The current adapters extract named types, modules/namespaces, functions and
methods for Python, Go, Ruby, Rust, Java, C#, Kotlin, C, C++ and Objective-C. Decorators/annotations,
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
