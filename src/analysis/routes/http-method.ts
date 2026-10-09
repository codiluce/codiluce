/** Fetch validates HTTP token bytes, rejects forbidden methods and uppercases
 * exactly six tokens. PATCH and extension methods preserve their casing. */
export function normalizeFetchMethod(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) return undefined;
  const upper = value.toUpperCase();
  if (['CONNECT', 'TRACE', 'TRACK'].includes(upper)) return undefined;
  return ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT'].includes(upper) ? upper : value;
}
