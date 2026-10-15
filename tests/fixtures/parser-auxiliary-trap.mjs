import {Parser} from 'web-tree-sitter';
const setLanguage=Parser.prototype.setLanguage,parse=Parser.prototype.parse,auxiliary=new WeakSet();
let loaded=0;
Parser.prototype.setLanguage=function(language){if(++loaded===2)auxiliary.add(this);return setLanguage.call(this,language);};
Parser.prototype.parse=function(...args){if(auxiliary.has(this))throw new WebAssembly.RuntimeError('Owned auxiliary C++ runtime trap');return parse.apply(this,args);};
await import(process.env.CODILUCE_OWNED_TRAP_WORKER??new URL('../../src/analysis/tree-sitter/native-worker.mjs',import.meta.url));
