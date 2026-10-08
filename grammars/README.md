# Structural grammar assets

These pinned WebAssembly artifacts ship with the CLI. No target-language
toolchain, dependency installation, grammar compilation or network access is
needed to index a repository. The TypeScript compiler and PHP parser remain
the authoritative parsers for their languages.

`manifest.json` records each grammar's upstream revision, artifact package and
version, SHA-256, language ABI and license. Six artifacts come from the pinned
VS Code grammar bundle; Kotlin comes from its upstream grammar package. The
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
methods for Python, Go, Ruby, Rust, Java, C# and Kotlin. Decorators/annotations,
modifiers, signatures and lexical containment are preserved where the grammar
exposes them. Local Go receivers and Rust impl methods attach only to a unique
type in the same file; cross-file ownership and language binding belong to the
resolver phases. Ruby reopenings and C# partial declarations remain individual
source declarations. Anonymous expressions, generated code, macro expansion,
arbitrary properties/fields and inferred types are outside this subset.

Non-callable declarations use the existing graph `class` type with a
`declarationKind`/`role`; properties exposed by C# use `method` with role
`property`. The inspector displays the actual kind. No new graph schema is
required. Graph symbol identities contain language, application, file,
qualified name, kind and normalized signature, without line numbers.

The parser runs in a disposable child process, with a 10-second job deadline,
a 256 MB V8 heap limit and extraction budgets. Grammars load lazily. Recovered
syntax produces partial outcomes and retains valid declarations; missing or
corrupt assets fail only the affected files. Every code file records actual
feature outcomes in `metadata.analysis`. A declaration-only adapter does not
place its files in the call/flow coverage denominator.
