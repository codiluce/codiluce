/** Passing or returning a function as a value does not run its body. Keep
 * those references in the index, but only traverse callback registrations
 * and event bindings when drawing behavior. Actual invocations are calls. */
export function followsBehavior(type: string, metadata: Record<string, unknown>): boolean {
  if (type !== 'references') return true;
  const forms = Array.isArray(metadata.forms) ? metadata.forms : [];
  return forms.includes('handler') || forms.includes('callback');
}
