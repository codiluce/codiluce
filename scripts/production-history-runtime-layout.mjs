import assert from 'node:assert/strict';
import path from 'node:path';

const roles={indexer:'history/indexer',worker:'history/worker',store:'history/store',git:'history/git',projection:'projection/service',graphStore:'storage/sqlite'};
const canonical=value=>typeof value==='string'&&value.length>0&&!value.startsWith('/')&&!value.includes('\\')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..');

/** A conformance descriptor owned by the observer, never target configuration.
 * Installed bytes/dependencies and the independently qualified source ledger
 * remain distinct. No source/vendor rows are invented in an installed ledger. */
export function historyRuntimeLayout(identity){
 assert.ok(identity&&Array.isArray(identity.files)&&identity.files.length,'Missing execution runtime ledger');
 let prefix='src',extension='.ts',kind='source';
 if(identity.executionLayout!==undefined){
  const layout=identity.executionLayout;
  assert.ok(layout&&layout.schema===1&&layout.kind==='installed-package','Unsupported history execution layout');
  assert.equal(layout.packageDirectory,'codiluce','Only the actual Codiluce package layout is supported');
  assert.ok(canonical(layout.packageDirectory),'Invalid package directory');
  prefix=layout.packageDirectory+'/dist/src';extension='.js';kind=layout.kind;
  const pair=identity.sourceQualification;
  assert.ok(pair&&typeof pair.root==='string'&&path.isAbsolute(pair.root),'Installed runtime requires a separately qualified source root');
  assert.ok(pair.identity&&Array.isArray(pair.identity.files)&&pair.identity.files.length,'Missing qualified source ledger');
  assert.equal(pair.identity.executionLayout,undefined,'Qualified source must be a source runtime');
  assert.equal(pair.identity.node,identity.node);assert.equal(pair.identity.platform,identity.platform);assert.equal(pair.identity.architecture,identity.architecture);
  historyRuntimeLayout(pair.identity);
 }else assert.equal(identity.sourceQualification,undefined,'A source pair requires an installed execution layout');
 const paths=new Map();
 for(const row of identity.files){assert.ok(canonical(row.file),'Invalid execution runtime path');assert.ok(!paths.has(row.file),'Duplicate execution runtime path');assert.match(row.sha256,/^[a-f\d]{64}$/);paths.set(row.file,row);}
 const modules=Object.fromEntries(Object.entries(roles).map(([role,file])=>[role,prefix+'/'+file+extension]));
 for(const file of Object.values(modules))assert.ok(paths.has(file),'Execution module absent from ledger: '+file);
 return {kind,modules,execArgv:kind==='source'?['--experimental-sqlite','--import','tsx']:['--experimental-sqlite']};
}

export function historySourceIdentity(identity){
 if(identity.executionLayout){historyRuntimeLayout(identity);return identity.sourceQualification.identity;}
 assert.equal(identity.sourceQualification,undefined,'A source pair requires an installed execution layout');
 return identity;
}

export function historyRuntimeLedgers(identity,executionRoot){
 historyRuntimeLayout(identity);assert.ok(path.isAbsolute(executionRoot),'Execution root must be absolute');
 const ledgers=[{role:'execution',root:executionRoot,identity}];
 if(identity.executionLayout)ledgers.push({role:'qualification-source',root:identity.sourceQualification.root,identity:identity.sourceQualification.identity});
 return ledgers;
}
