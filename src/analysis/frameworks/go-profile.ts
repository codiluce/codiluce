import type { GoResolver } from '../resolution/go.js';
/** The main program's recorded GODEBUG defaults; dependency modules do not
 * change ServeMux syntax. No go env/list or process environment lookup. */
export function goMuxProfile(resolver: GoResolver, origin: string): { modern: boolean; conditions: string[]; reason: string } {
  const config = resolver.config(origin), environment = resolver.environment(origin), main = resolver.owner(origin), manifest = environment.workspace?.manifest ?? main?.manifest, conditions: string[] = [];
  const version = (value: string | undefined) => value ? Number(/^1\.(\d+)/.exec(value)?.[1] ?? NaN) : undefined;
  const compiler = version(config.toolchainVersion), language = version(manifest?.goVersion) ?? 16;
  let defaults = manifest?.godebug.default?.replace(/^go/, '') ?? manifest?.goVersion ?? '1.16', setting = manifest?.godebug.httpmuxgo121;
  const directives = new Map<string, string>();
  const own = resolver.packageFor(origin);
  if (own.status === 'resolved' && own.package.name === 'main') for (const file of own.package.files) {
    const facts = resolver.context.syntax?.get(file.path)?.facts.go;
    for (const comment of facts?.comments ?? []) if (comment.start < (facts?.package?.start ?? 0) && comment.text.startsWith('//go:debug')) {
      const match = /^\/\/go:debug\s+([A-Za-z0-9]+)=([^\s]+)\s*$/.exec(comment.text);
      if (!match) { conditions.push('Malformed main-package go:debug directive'); continue; }
      if (directives.has(match[1]!)) conditions.push(`Duplicate main-package go:debug ${match[1]}`); directives.set(match[1]!, match[2]!);
    }
  }
  defaults = directives.get('default')?.replace(/^go/, '') ?? defaults; setting = directives.get('httpmuxgo121') ?? setting;
  if (setting !== undefined && !['0', '1'].includes(setting)) conditions.push('Unreviewed httpmuxgo121 default');
  if (compiler !== undefined && compiler < language) conditions.push('Recorded toolchain cannot compile the selected go directive');
  if (compiler !== undefined && compiler < 23 && Object.keys(manifest?.godebug ?? {}).length) conditions.push('Manifest godebug directives require Go 1.23 or newer');
  if (compiler !== undefined && compiler < 22 && (config.httpMuxGo121 === false || setting === '0')) conditions.push('Modern ServeMux startup override requires Go 1.22 or newer');
  if (!/^1\.\d+(?:\.\d+)?$/.test(defaults)) conditions.push('Unreviewed GODEBUG default version');
  const modern = compiler !== undefined && compiler < 22 ? false : config.httpMuxGo121 !== undefined ? !config.httpMuxGo121 : setting !== undefined ? setting === '0' : (version(defaults) ?? 16) >= 22;
  if (modern && compiler !== undefined && compiler < 22) conditions.push('Modern ServeMux syntax requires Go 1.22 or newer');
  return { modern, conditions, reason: `Static ServeMux ${modern ? '1.22+' : '1.21'} profile; main/workspace default ${defaults}${setting ? `; httpmuxgo121=${setting}` : ''}${config.httpMuxGo121 !== undefined ? `; configured startup override ${config.httpMuxGo121}` : ''}` };
}
