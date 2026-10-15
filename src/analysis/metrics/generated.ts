// Generated and minified files: their metrics describe a generator, not code
// anyone maintains, so they are left out of health.
const GENERATED_PATH = /\.pb(\.gw)?\.go$|_pb2(_grpc)?\.pyi?$|\.generated\.[^/]+$|(^|\/)generated\/|\.min\.[cm]?js$|\.bundle\.js$/i;
/** Go's convention, `@generated` (Meta tools), and the usual banners, in the first lines. */
const GENERATED_BANNER = /Code generated .{0,200}DO NOT EDIT|@generated\b|\bauto-?generated\b|\bDO NOT EDIT\b/i;
/** Average characters per line above which a file is minified or a data dump. */
const MINIFIED_LINE = 300;

export function generatedReason(file: string, content: string): string | undefined {
  if (GENERATED_PATH.test(file)) return 'a generated or minified file, by its name';
  if (GENERATED_BANNER.test(content.slice(0, 1024))) return 'marked as generated in its first lines';
  const lines = content.split('\n', 2000).length;
  if (content.length > 4096 && content.length / lines > MINIFIED_LINE) return 'minified: very long lines';
  return undefined;
}
