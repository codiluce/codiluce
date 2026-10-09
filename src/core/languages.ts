// File languages: which language a file is written in, from its well-known
// name or its extension, and which of those languages are code.
//
// A language names the file on the map (label, color, syntax highlighting)
// and makes its lines measured; it does not make the file analyzed. Symbols,
// calls and flows come from the analyzers. Per-file analysis outcomes state
// what ran; `FLOW_LANGUAGES` is a fallback for older stored snapshots.

/** By lower-case extension. */
const EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.php': 'php',
  '.vue': 'vue', '.svelte': 'svelte', '.astro': 'astro', '.liquid': 'liquid', '.erb': 'erb', '.cshtml': 'razor', '.razor': 'razor',
  '.py': 'python', '.pyi': 'python', '.pyw': 'python',
  '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.sc': 'scala',
  '.cs': 'csharp', '.csx': 'csharp', '.fs': 'fsharp', '.fsi': 'fsharp', '.fsx': 'fsharp', '.vb': 'vbnet',
  '.rb': 'ruby', '.rake': 'ruby', '.gemspec': 'ruby', '.ru': 'ruby',
  // `.h` is C until its application shows otherwise (see `headerLanguage`).
  '.c': 'c', '.h': 'c',
  '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.c++': 'cpp', '.hh': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp', '.h++': 'cpp', '.ipp': 'cpp', '.tpp': 'cpp', '.inl': 'cpp',
  '.m': 'objective-c', '.mm': 'objective-c', '.swift': 'swift',
  '.css': 'css', '.scss': 'scss', '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.md': 'markdown', '.html': 'html',
  '.sql': 'sql', '.sh': 'shell', '.xml': 'xml', '.svg': 'xml',
  '.csproj': 'xml', '.fsproj': 'xml', '.vbproj': 'xml', '.props': 'xml', '.targets': 'xml', '.xaml': 'xml', '.plist': 'xml', '.storyboard': 'xml', '.xib': 'xml',
  '.gradle': 'groovy', '.groovy': 'groovy', '.cmake': 'cmake', '.proto': 'protobuf', '.graphql': 'graphql', '.gql': 'graphql', '.prisma': 'prisma', '.properties': 'properties',
};
/** Files known by their whole name. */
const NAMES: Record<string, string> = {
  Gemfile: 'ruby', 'Gemfile.lock': 'ruby-lock', Rakefile: 'ruby', Podfile: 'ruby', Fastfile: 'ruby', Appfile: 'ruby', Brewfile: 'ruby', Guardfile: 'ruby', Vagrantfile: 'ruby',
  Makefile: 'makefile', GNUmakefile: 'makefile', makefile: 'makefile', 'CMakeLists.txt': 'cmake', Jenkinsfile: 'groovy', Pipfile: 'toml', 'go.mod': 'go-module', 'go.work': 'go-workspace',
  'setup.cfg': 'ini', 'Cargo.lock': 'toml',
};
/** Languages whose files are code (the others: styles, data, configuration, documents). */
export const CODE_LANGUAGES = new Set([
  'typescript', 'javascript', 'php', 'vue', 'svelte', 'astro', 'liquid', 'erb', 'razor', 'python', 'go', 'rust', 'java', 'kotlin', 'scala',
  'csharp', 'fsharp', 'vbnet', 'ruby', 'c', 'cpp', 'objective-c', 'swift',
]);
/** Legacy flow-language fallback for snapshots without per-file analysis outcomes (PHP requires Laravel). */
export const FLOW_LANGUAGES = new Set(['typescript', 'javascript', 'php']);

export function languageOf(relative: string): string | undefined {
  const name = relative.slice(relative.lastIndexOf('/') + 1);
  if (NAMES[name]) return NAMES[name];
  if (/(?:^|\/)\.cargo\/config$/.test(relative)) return 'toml';
  if (/^requirements[\w.-]*\.txt$/.test(name)) return 'pip-requirements';
  if (/^Dockerfile(\..+)?$/.test(name) || name.endsWith('.dockerfile')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? EXTENSIONS[name.slice(dot).toLowerCase()] : undefined;
}
/**
 * The language of `.h` headers among the given code languages of their
 * application: Objective-C next to `.m` files, C++ next to C++ sources, else C.
 */
export function headerLanguage(languages: Set<string>): string {
  return languages.has('objective-c') ? 'objective-c' : languages.has('cpp') ? 'cpp' : 'c';
}
