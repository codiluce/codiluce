// Public history view checks include snapshots outside the cached first-parent
// registry. No private projection fields or replacement layout are used.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export async function verifyPublicHistoryViews(history,{GraphStore,ProjectionService}){
 const saved=history.layoutRegistry();assert.ok(saved);const original=JSON.stringify(saved),base=new Set(saved.snapshots),snapshots=history.snapshots(),passes=[];
 for(let pass=0;pass<2;pass++){
  const live=new GraphStore(':memory:'),service=new ProjectionService(live,{history:()=>history}),rows=[];
  try{
   for(const snapshot of snapshots){
    const view={snapshot:snapshot.id};await service.prepare(view);const meta=service.meta(view);assert.deepEqual(meta.run,snapshot.run);assert.equal(meta.snapshot.id,snapshot.id);assert.equal(meta.history.snapshots,snapshots.length);assert.equal(meta.layout.source,'timeline');assert.equal(meta.layout.holes,0,'Public history view has missing timeline slots');
    const nodes=new Map(),queue=[meta.root];let requests=0;
    for(let cursor=0;cursor<queue.length;cursor++){
     const node=queue[cursor];assert.ok(!nodes.has(node.id),'Public history node is visited twice');nodes.set(node.id,node);assert.ok(Object.values(node.rect).every(Number.isSafeInteger)&&node.rect.w>0&&node.rect.h>0);
     const children=[];
     for(let offset=0;offset<node.childCount;offset+=500){const page=service.children(node.id,{limit:500,offset,view});requests++;assert.equal(page.total,node.childCount);assert.equal(page.offset,offset);assert.ok(page.items.length>0);children.push(...page.items);}
     assert.equal(children.length,node.childCount);queue.push(...children);
     for(const child of children){const p=node.rect,r=child.rect;assert.equal(child.spatialParentId,node.id);assert.ok(r.x>=p.x&&r.y>=p.y&&r.x+r.w<=p.x+p.w&&r.y+r.h<=p.y+p.h,'Public history child escapes its parent');}
     children.sort((a,b)=>a.rect.x-b.rect.x);
     for(let left=0;left<children.length;left++)for(let right=left+1;right<children.length&&children[right].rect.x<children[left].rect.x+children[left].rect.w;right++){const a=children[left].rect,b=children[right].rect;assert.ok(b.y>=a.y+a.h||b.y+b.h<=a.y,'Public history siblings overlap');}
    }
    const entities=history.entities(snapshot.seq);assert.equal([...nodes.values()].filter(node=>node.kind==='entity').length,entities.length);
    for(const entity of entities){const node=nodes.get(entity.id);assert.ok(node&&node.kind==='entity','Original entity disappeared from public history');assert.equal(node.name,entity.name);assert.equal(node.type,entity.type);assert.equal(node.path,entity.path);assert.equal(node.language,entity.language);assert.equal(node.canonicalParentId,entity.parentId);assert.deepEqual(node.sourceRange,entity.sourceRange);}
    const rects=[...nodes].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([id,node])=>[id,node.rect]);
    rows.push({id:snapshot.id,commit:snapshot.commitSha,cachedFirstParent:base.has(snapshot.id),entities:entities.length,projectedNodes:nodes.size,childPageRequests:requests,layoutSource:meta.layout.source,holes:meta.layout.holes,rectangleSha256:createHash('sha256').update(JSON.stringify(rects)).digest('hex')});assert.equal(JSON.stringify(history.layoutRegistry()),original,'Public side-branch view changed the persisted base registry');
   }
  }finally{live.close();}
  passes.push(rows);
 }
 assert.deepEqual(passes[1],passes[0],'Fresh public history service changed snapshot positions');return {schema:1,passed:true,snapshots:passes[0],freshServicePasses:2,offFirstParentSnapshots:passes[0].filter(row=>!row.cachedFirstParent).length,persistedBaseRegistryUnchanged:true};
}
