import type { Entity } from '../../core/graph.js';
import type { RoutingContract } from './contracts.js';
/** WebFlux.fn tests composed routes in order, without MVC path specificity.
 * A prior opaque predicate remains a competitor. Bean order is only shared
 * across roots when the pack proves unique original ordering inputs. */
export function preferWebFluxRoutes(entities:Entity[],contractFor:(entity:Entity)=>RoutingContract|undefined):Entity[]{
  const groups=new Map<string,Entity[]>();
  for(const entity of entities){const dispatch=contractFor(entity)?.dispatch;if(dispatch?.dialect!=='spring-webflux')continue;const group=groups.get(dispatch.root)??[];group.push(entity);groups.set(dispatch.root,group);}
  const removed=new Set<string>();
  for(const group of groups.values()){
    group.sort((a,b)=>contractFor(a)!.dispatch!.order-contractFor(b)!.dispatch!.order);
    const first=group[0];if(!first||first.metadata.constraintsUnresolved||contractFor(first)!.pattern.status!=='exact')continue;
    for(const later of group.slice(1))removed.add(later.id);
  }
  return entities.filter(entity=>!removed.has(entity.id));
}
