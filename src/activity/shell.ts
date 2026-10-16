interface ShellInput { tool: 'Read' | 'Grep'; input: { paths: string[]; pattern?: string } }

/** Tokenize literal commands without evaluating shell code or splitting quoted operators. */
function literalCommands(command: string): string[][] | undefined {
  if (command.includes('\0')) return undefined;
  const commands: string[][] = [];
  let words: string[] = [], word = '', started = false, quote = '', needsCommand = false;
  const flush = () => { if (started) words.push(word); word = ''; started = false; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote === "'") {
      if (char === "'") quote = ''; else word += char;
      continue;
    }
    if (char === '\\') {
      const next = command[++i];
      if (next === undefined) return undefined;
      if (next === '\n') continue;
      word += quote === '"' && !['$', '`', '"', '\\'].includes(next) ? `\\${next}` : next;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = '';
      else if (char === '$' || char === '`') return undefined;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === ';' || char === '\n' || char === '&' && command[i + 1] === '&') {
      flush();
      if (words.length) { commands.push(words); words = []; }
      else if (char !== '\n') return undefined;
      else continue;
      needsCommand = char === '&';
      if (char === '&') i++;
      continue;
    }
    if (/\s/.test(char)) { flush(); continue; }
    // Reject substitutions, globs, redirections, pipelines, groups and comments.
    if (/[|&<>$`(){}*?\[\]~]/.test(char) || char === '#' && !started) return undefined;
    word += char; started = true;
  }
  if (quote) return undefined;
  flush();
  if (words.length) commands.push(words);
  else if (needsCommand) return undefined;
  return commands.length ? commands : undefined;
}

const catFlags = new Set(['--number', '--number-nonblank', '--squeeze-blank', '--show-all', '--show-ends', '--show-tabs', '--show-nonprinting']);
const count = /^[-+]?\d+(?:[bkmgtpezyrq]|[KMGTPEZYRQ](?:B|iB)?)?$/;

function readPaths(tool: string, args: string[]): string[] | undefined {
  if (tool === 'sed') {
    if (args[0] !== '-n' || !/^\d+(,\d+)?p$/.test(args[1] ?? '')) return undefined;
    const files = args.slice(2);
    if (files[0] === '--') files.shift();
    else if (files.some(file => file.startsWith('-') && file !== '-')) return undefined;
    return files.filter(file => file !== '-');
  }
  const files: string[] = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (options && arg === '--') { options = false; continue; }
    if (options && arg.startsWith('-') && arg !== '-') {
      if (tool === 'cat') {
        if (!/^-[AbEnestTuv]+$/.test(arg) && !catFlags.has(arg)) return undefined;
      } else if (['-n', '-c', '--lines', '--bytes'].includes(arg)) {
        if (!count.test(args[++i] ?? '')) return undefined;
      } else if (/^(?:-[nc]|--(?:lines|bytes)=)/.test(arg)) {
        if (!count.test(arg.replace(/^(?:-[nc]|--(?:lines|bytes)=)/, ''))) return undefined;
      } else if (!/^-(?:\d+|[qv]+)$/.test(arg) && !['--quiet', '--silent', '--verbose'].includes(arg)) return undefined;
    } else if (arg !== '-') files.push(arg);
  }
  return files;
}

function searchInput(args: string[]): ShellInput | undefined {
  // Value-taking flags and glob searches remain unknown.
  const flags = new Set(['-n', '-l', '-i', '-w', '-F', '--hidden', '--no-heading', '--files-with-matches']);
  if (args.some(arg => arg.startsWith('-') && !flags.has(arg))) return undefined;
  const positional = args.filter(arg => !flags.has(arg));
  if (!positional.length) return undefined;
  return { tool: 'Grep', input: { pattern: positional[0], paths: positional.length > 1 ? positional.slice(1) : ['.'] } };
}

/** Only known literal reads/searches are attributed; scripts and cwd-changing commands stay unknown. */
export function shellInput(command: string): ShellInput | undefined {
  const commands = literalCommands(command);
  if (!commands) return undefined;
  const files: string[] = [], searches: ShellInput[] = [];
  let reads = false;
  for (const [tool, ...args] of commands) {
    if (tool && ['cat', 'head', 'tail', 'sed'].includes(tool)) {
      const paths = readPaths(tool, args);
      if (!paths) return undefined;
      reads = true; files.push(...paths);
    } else if (tool === 'rg' || tool === 'grep') {
      const search = searchInput(args);
      if (!search) return undefined;
      searches.push(search);
    } else return undefined;
  }
  // A hook represents one action: explicit file reads take precedence over search scopes.
  if (reads) return { tool: 'Read', input: { paths: files } };
  if (searches.some(search => search.input.pattern !== searches[0]?.input.pattern)) return undefined;
  return { tool: 'Grep', input: { pattern: searches[0]?.input.pattern, paths: searches.flatMap(search => search.input.paths) } };
}
