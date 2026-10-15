import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {FlowSummary} from '../../src/projection/dto.js';
import {CATALOG_TABS,evidenceOf,visibleCatalog,kindsOf} from '../lib/catalog';

const flow=(name:string,kind:FlowSummary['kind'],scope:FlowSummary['scope'],evidenceCoverage:FlowSummary['evidenceCoverage']):FlowSummary=>({id:name,name,kind,entry:{id:name,name,type:'user_flow'},scope,evidenceCoverage,group:kind,detail:'lanes',entities:1,files:1});
test('flow channels and evidence are independent of HTTP topology and source scope',()=>{
  const entries=[flow('Index','cli','application','no-known-gaps'),flow('Tool call','mcp','application','known-gaps'),flow('Worker fixture','worker','fixture','known-gaps'),flow('Worker test','worker','test','no-known-gaps')];
  const ids=(tab:Parameters<typeof visibleCatalog>[1]['tab'],scope:Parameters<typeof visibleCatalog>[1]['scope'],coverage?:Parameters<typeof visibleCatalog>[1]['coverage'])=>visibleCatalog(entries,{tab,scope,coverage,query:''}).flatMap(group=>group.items.map(item=>item.name));
  assert.deepEqual(CATALOG_TABS,['all','cli','http','ui','mcp','worker','function']);
  assert.deepEqual(ids('all','application'),['Index','Tool call']);
  assert.deepEqual(ids('all','all','known-gaps'),['Tool call','Worker fixture']);
  assert.deepEqual(ids('worker','fixture'),['Worker fixture']);
  assert.deepEqual(ids('worker','test'),['Worker test']);
  assert.deepEqual(kindsOf('cli'),['cli','schedule','command']);
  assert.deepEqual(kindsOf('http'),['request','unmatched']);
  assert.deepEqual(kindsOf('ui'),['page']);
  assert.equal(evidenceOf({...entries[0]!,status:'partial'}),'no-known-gaps','generic entry coverage does not depend on HTTP stages');
});
