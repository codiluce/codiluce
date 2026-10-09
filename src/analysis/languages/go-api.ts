import { satisfies } from 'semver';
import type { GoResolution } from '../resolution/go.js';
/** Original API namespaces, qualified by the declared dependency rather than
 * directory spelling. These are static profiles, not downloaded dependencies. */
export const GO_API_VERSION = '1';
export const CHI_MODULE = 'github.com/go-chi/chi/v5', GIN_MODULE = 'github.com/gin-gonic/gin';
export function goApi(outcome: GoResolution, specifier: string): { kind: 'chi' | 'gin'; name: string; reviewed: boolean; conditions: string[] } | undefined {
  if (outcome.status !== 'external' || outcome.conditions.length) return undefined;
  const kind = outcome.module === CHI_MODULE && [CHI_MODULE, `${CHI_MODULE}/middleware`].includes(specifier) ? 'chi' : outcome.module === GIN_MODULE && specifier === GIN_MODULE ? 'gin' : undefined;
  if (!kind) return undefined;
  const reviewed = !!outcome.version && satisfies(outcome.version, kind === 'chi' ? '>=5.2.0 <5.3.0' : '>=1.10.0 <1.12.0');
  return { kind, name: specifier.endsWith('/middleware') ? 'middleware' : kind, reviewed, conditions: reviewed ? [] : [`Declared ${kind} version does not select the reviewed ${kind === 'chi' ? '5.2' : '1.10–1.11'} core routing profile`] };
}
