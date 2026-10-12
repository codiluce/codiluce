import {ast, nodes, type Ast} from '../../analyzers/php-ast.js';

const copy=(value:string)=>Buffer.from(value,'utf16le').toString('utf16le');
const common=['name','resolution','isFinal','isAbstract','isStatic','nullable','byref','variadic','flags','visibility'];
const fieldsByKind=new Map<string,readonly string[]>();
for(const [kinds,extra]of [
  [['selfreference','parentreference','staticreference','typereference'],['raw']],
  [['class','interface','trait','enum'],['extends','implements']],
  [['function','method','closure','arrowfunc'],['type','arguments']],
  [['propertyhook','parameter','property'],['type']],
  [['call','new'],['arguments','what','offset']],
  [['propertylookup','nullsafepropertylookup','staticlookup'],['what','offset']],
  [['array'],['items']],
  [['entry'],['value','key','unpack']],
  [['namedargument','string','number','boolean','nowdoc'],['value']],
] as const)for(const kind of kinds)fieldsByKind.set(kind,[...common,...extra]);
/** Detached inputs for the bounded PHP binding profile. Callable bodies,
 * statements, comments, tokens and parser-owned objects are never retained.
 * Unknown expressions preserve their kind/location, so they still produce
 * the same explicit unsupported outcome rather than an invented binding. */
export function bindingNode(node:Ast, known=new WeakMap<Ast,Ast>()):Ast {
  const previous=known.get(node);if(previous)return previous;
  const result:Ast={kind:node.kind};known.set(node,result);
  const pending:[Ast,Ast][]=[[node,result]];
  const child=(node:Ast):Ast=>{
    const previous=known.get(node);if(previous)return previous;
    const result:Ast={kind:node.kind};known.set(node,result);pending.push([node,result]);return result;
  };
  while(pending.length){
    const [node,result]=pending.pop()!;
    if(node.loc)result.loc={start:{...node.loc.start},end:{...node.loc.end}};
    const fields=fieldsByKind.get(node.kind)??common;
    for(const field of fields){
      const value=node[field];
      if(typeof value==='string')result[field]=copy(value);
      else if(typeof value==='boolean'||typeof value==='number'||value===null)result[field]=value;
      else if(ast(value))result[field]=child(ast(value)!);
      else if(Array.isArray(value))result[field]=nodes(value).map(child);
    }
  }
  return result;
}
