import { satisfies } from 'semver';
import type { GoResolution } from '../resolution/go.js';
/** Original API namespaces, qualified by the declared dependency rather than
 * directory spelling. These are static profiles, not downloaded dependencies. */
export const GO_API_VERSION = '2';
export const CHI_MODULE = 'github.com/go-chi/chi/v5', GIN_MODULE = 'github.com/gin-gonic/gin';
export const ECHO4_MODULE = 'github.com/labstack/echo/v4', ECHO5_MODULE = 'github.com/labstack/echo/v5', FIBER2_MODULE = 'github.com/gofiber/fiber/v2', FIBER3_MODULE = 'github.com/gofiber/fiber/v3', GORILLA_MODULE = 'github.com/gorilla/mux';
export type GoFramework = 'chi' | 'gin' | 'echo' | 'fiber' | 'gorilla';
const profiles: Record<string, { kind: GoFramework; name: string; range: string; label: string }> = {
  [CHI_MODULE]: { kind: 'chi', name: 'chi', range: '>=5.2.0 <5.3.0', label: '5.2' },
  [GIN_MODULE]: { kind: 'gin', name: 'gin', range: '>=1.10.0 <1.12.0', label: '1.10–1.11' },
  [ECHO4_MODULE]: { kind: 'echo', name: 'echo', range: '>=4.13.0 <4.14.0', label: '4.13' },
  [ECHO5_MODULE]: { kind: 'echo', name: 'echo', range: '>=5.4.0 <5.5.0', label: '5.4' },
  [FIBER2_MODULE]: { kind: 'fiber', name: 'fiber', range: '>=2.52.0 <2.53.0', label: '2.52' },
  [FIBER3_MODULE]: { kind: 'fiber', name: 'fiber', range: '>=3.5.0 <3.6.0', label: '3.5' },
  [GORILLA_MODULE]: { kind: 'gorilla', name: 'mux', range: '>=1.8.0 <1.9.0', label: '1.8' },
};
export function goApi(outcome: GoResolution, specifier: string): { kind: GoFramework; name: string; module: string; reviewed: boolean; conditions: string[] } | undefined {
  if (outcome.status !== 'external' || outcome.conditions.length) return undefined;
  const profile = profiles[outcome.module];
  if (!profile || !(specifier === outcome.module || profile.kind === 'chi' && specifier === `${outcome.module}/middleware` || ['echo', 'fiber'].includes(profile.kind) && specifier.startsWith(`${outcome.module}/middleware/`) || profile.kind === 'echo' && specifier === `${outcome.module}/middleware`)) return undefined;
  const reviewed = !!outcome.version && satisfies(outcome.version, profile.range);
  return { kind: profile.kind, name: specifier === outcome.module ? profile.name : specifier.split('/').at(-1)!, module: outcome.module, reviewed, conditions: reviewed ? [] : [`Declared ${profile.kind} version does not select the reviewed ${profile.label} core routing profile`] };
}
