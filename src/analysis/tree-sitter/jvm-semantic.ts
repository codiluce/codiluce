import type { Node } from 'web-tree-sitter';
import type { DeclarationFact, JvmAnnotationFact, JvmArgument, JvmBindingFact, JvmDefinitionFact, JvmExpression, JvmParameterFact, JvmScopeFact, JvmSemanticFacts } from '../facts.js';
import type { SourceText } from '../source-map.js';

const MAX_NODES = 200_000, MAX_SITES = 50_000;
const callable = new Set(['method','function','constructor']);
const typeKinds = new Set(['class','interface','enum','record','annotation','object','typealias']);
const unescapeName = (text: string) => text.replace(/`([^`]+)`|\s+/g, (_match, escaped: string | undefined) => escaped ?? '');
const child = (node: Node, ...names: string[]) => node.namedChildren.find(item=>names.includes(item.type));
const named = (node: Node, field: string, ...types: string[]) => node.childForFieldName(field) ?? child(node,...types);
const typeNodes = new Set(['type_identifier','scoped_type_identifier','generic_type','user_type','nullable_type','function_type','array_type','integral_type','floating_point_type','boolean_type','void_type']);

/** Original syntax only. No Java/Kotlin compiler, bytecode, build or annotation
 * processor runs. Unsupported dispatch/configuration is decided by consumers. */
export function extractJvmSemantic(root: Node, language: string, declarations: DeclarationFact[], source: SourceText): JvmSemanticFacts {
  const facts: JvmSemanticFacts = {scopes:[],definitions:[],bindings:[],writes:[],references:[],calls:[],returns:[],complete:!root.hasError,gaps:[]};
  const site = (node: Node) => ({start:node.startIndex,end:node.endIndex,range:source.range(node.startIndex,node.endIndex)});
  const unknown = (node: Node): JvmExpression => ({...site(node),kind:'unknown',text:node.text.slice(0,300)});
  const bySite = new Map(declarations.map(declaration=>[`${declaration.start}:${declaration.end}`,declaration]));
  const lambdaKeys = new Map<number,string>();
  let expressionNodes=0, lambdaOrdinal=0, scopeOrdinal=0, nodes=0;
  const lambdaKey=(node:Node) => {let key=lambdaKeys.get(node.id);if(!key){key=`jvm-lambda:${lambdaOrdinal++}`;lambdaKeys.set(node.id,key);}return key;};
  const args = (node: Node | undefined, depth=0): JvmArgument[] => {
    if(!node)return [];
    if(node.namedChildren.length>128){facts.complete=false;facts.gaps.push('JVM argument budget exceeded');return [];}
    return node.namedChildren.filter(item=>item.type!=='comment').map(item=>{
      if(item.type==='element_value_pair')return {name:unescapeName(item.childForFieldName('key')?.text??''),value:expression(item.childForFieldName('value')??item,depth+1)};
      if(item.type==='value_argument'){
        const assignment=item.children.some(part=>part.type==='='), value=item.namedChildren.at(-1)??item;
        return {...assignment?{name:unescapeName(item.namedChildren[0]?.text??'')}:{},value:expression(value,depth+1),...item.children.some(part=>part.type==='*')?{spread:true}:{}};
      }
      return {value:expression(item,depth+1)};
    });
  };
  const expression = (node: Node, depth=0): JvmExpression => {
    if(++expressionNodes>MAX_NODES||depth>32){facts.complete=false;return unknown(node);}
    const base=site(node), parts=node.namedChildren.filter(part=>part.type!=='comment');
    if(node.type==='identifier'&&['true','false'].includes(node.text))return{...base,kind:'literal',value:node.text==='true',literalType:'boolean'};
    if(node.type==='generic_type'||node.type==='user_type'&&parts.some(part=>part.type==='type_arguments')){
      const container=child(node,'type_arguments'), names=parts.filter(part=>part!==container), text=names.map(part=>part.text).join('.');
      return container&&names.length?{...base,kind:'generic-type',name:{...base,kind:'name',name:unescapeName(text)},arguments:container.namedChildren.map(part=>expression(part.type==='type_projection'&&part.namedChildren.length===1&&!/^(?:in|out)\b/.test(part.text)?part.namedChildren[0]!:part,depth+1))}:unknown(node);
    }
    if(['identifier','type_identifier','scoped_identifier','scoped_type_identifier','qualified_identifier','user_type','integral_type','floating_point_type','boolean_type','void_type'].includes(node.type)) {
      if(node.type==='user_type'&&parts.some(part=>part.type==='type_arguments'))return unknown(node);
      return {...base,kind:'name',name:unescapeName(node.text)};
    }
    if(['this_expression','super_expression'].includes(node.type)&&!['this','super'].includes(node.text))return unknown(node);
    if(['this','this_expression','super','super_expression'].includes(node.type))return {...base,kind:'name',name:node.type.startsWith('this')?'this':'super'};
    if(['parenthesized_expression','parenthesized_type'].includes(node.type)&&parts[0])return expression(parts[0],depth+1);
    if(['true','false','boolean_literal'].includes(node.type))return {...base,kind:'literal',value:node.text==='true',literalType:'boolean'};
    if(['null_literal','null'].includes(node.type))return {...base,kind:'literal',value:null,literalType:'null'};
    if(/^(?:decimal|hex|octal|binary)_integer_literal$|^integer_literal$/.test(node.type)||node.type==='number_literal'&&!/[.eEfFuU]/.test(node.text)){
      const text=node.text.replaceAll('_',''), long=/[lL]$/.test(text), raw=text.replace(/[lL]$/,'');
      const value=/^0[0-7]+$/.test(raw)&&language==='java'?parseInt(raw,8):Number(raw);
      return Number.isSafeInteger(value)?{...base,kind:'literal',value,literalType:long?'long':'int'}:unknown(node);
    }
    if(/floating_point_literal|real_literal/.test(node.type)||node.type==='number_literal'&&/^(?:\d[\d_]*\.[\d_]+|\d[\d_]*[eE][+-]?[\d_]+)(?:[fF])?$/.test(node.text)){const value=Number(node.text.replaceAll('_','').replace(/[fFdD]$/,''));return Number.isFinite(value)?{...base,kind:'literal',value,literalType:/[fF]$/.test(node.text)?'float':'double'}:unknown(node);}
    if(node.type==='string_literal'){
      if(language==='kotlin'&&parts.some(part=>/interpolation/.test(part.type)))return unknown(node);
      const text=node.text;
      if(text.startsWith('"""'))return language==='kotlin'&&!text.includes('$')?{...base,kind:'literal',value:text.slice(3,-3),literalType:'String'}:unknown(node);
      if(language==='kotlin'&&/(?<!\\)\$/.test(text))return unknown(node);
      try {return {...base,kind:'literal',value:JSON.parse(language==='kotlin'?text.replace(/\\\$/g,'$'):text),literalType:'String'};}catch{return unknown(node);}
    }
    if(['element_value_array_initializer','array_initializer','collection_literal'].includes(node.type))return {...base,kind:'array',items:parts.map(part=>expression(part,depth+1))};
    if(node.type==='field_access'){
      const object=node.childForFieldName('object'), name=node.childForFieldName('field');return object&&name?{...base,kind:'member',object:expression(object,depth+1),name:unescapeName(name.text)}:unknown(node);
    }
    if(node.type==='navigation_expression'&&parts.length>=2){
      const object=parts[0]!, name=parts.at(-1)!;
      return node.children.some(part=>part.type==='::')?{...base,kind:'method-reference',object:expression(object,depth+1),name:unescapeName(name.text)}:{...base,kind:'member',object:expression(object,depth+1),name:unescapeName(name.text),...node.children.some(part=>part.type==='?.')?{safe:true}:{}};
    }
    if(node.type==='method_invocation'){
      const name=node.childForFieldName('name'), object=node.childForFieldName('object');if(!name)return unknown(node);
      const callee:JvmExpression=object?{...site(name),kind:'member',object:expression(object,depth+1),name:unescapeName(name.text)}:{...site(name),kind:'name',name:unescapeName(name.text)};
      return {...base,kind:'call',callee,args:args(node.childForFieldName('arguments')??undefined,depth+1),...node.childForFieldName('type_arguments')?{typeArguments:true}:{}};
    }
    if(node.type==='call_expression'){
      const callee=parts[0], argumentList=child(node,'value_arguments'), lambda=child(node,'annotated_lambda','lambda_literal');if(!callee)return unknown(node);
      const values=args(argumentList,depth+1);if(lambda)values.push({value:expression(lambda,depth+1)});
      if(lambda&&!argumentList&&callee.type==='call_expression'){
        const target=expression(callee,depth+1);if(target.kind==='call')return{...base,...target,start:base.start,end:base.end,range:base.range,args:[...target.args,...values]};
      }
      return {...base,kind:'call',callee:expression(callee,depth+1),args:values,...parts.some(part=>part.type==='type_arguments')?{typeArguments:true}:{}};
    }
    if(node.type==='object_creation_expression'||node.type==='constructor_invocation'){
      const type=named(node,'type','user_type'), argumentsNode=named(node,'arguments','value_arguments');return type?{...base,kind:'new',type:expression(type,depth+1),args:args(argumentsNode,depth+1),...child(node,'class_body')?{anonymous:true}:{}}:unknown(node);
    }
    if(node.type==='method_reference'||node.type==='callable_reference'){
      const name=parts.at(-1), object=parts.length>1?parts[0]:undefined;return name?{...base,kind:'method-reference',...object?{object:expression(object,depth+1)}:{},name:unescapeName(name.text)}:unknown(node);
    }
    if(['lambda_expression','lambda_literal'].includes(node.type))return {...base,kind:'lambda',key:lambdaKey(node)};
    if(node.type==='annotated_lambda'){const lambda=child(node,'lambda_literal');return lambda?expression(lambda,depth+1):unknown(node);}
    if(['binary_expression','infix_expression','additive_expression','multiplicative_expression','comparison_expression','equality_expression','conjunction_expression','disjunction_expression','elvis_expression','range_expression'].includes(node.type)&&parts.length>=2){
      const left=node.childForFieldName('left')??parts[0]!,right=node.childForFieldName('right')??parts.at(-1)!, operator=node.childForFieldName('operator')?.text??node.children.find(part=>!part.isNamed)?.text??(node.type==='infix_expression'?parts.slice(1,-1).find(part=>part.type==='identifier')?.text:undefined)??'';return {...base,kind:'binary',operator,left:expression(left,depth+1),right:expression(right,depth+1)};
    }
    if(['unary_expression','prefix_expression','postfix_expression'].includes(node.type)&&parts[0])return {...base,kind:'unary',operator:node.children.find(part=>!part.isNamed)?.text??'',object:expression(parts[0],depth+1)};
    if(['array_access','indexing_expression'].includes(node.type)){const object=node.childForFieldName('array')??parts[0],index=node.childForFieldName('index')??parts[1];return object?{...base,kind:'index',object:expression(object,depth+1),...index?{index:expression(index,depth+1)}:{}}:unknown(node);}
    if(node.type==='cast_expression'){const type=node.childForFieldName('type'),value=node.childForFieldName('value');return type&&value?{...base,kind:'cast',type:expression(type,depth+1),value:expression(value,depth+1)}:unknown(node);}
    if(node.type==='class_literal'&&parts[0])return {...base,kind:'class',type:expression(parts[0],depth+1)};
    return unknown(node);
  };
  const annotation = (node:Node):JvmAnnotationFact => {
    const invocation=child(node,'constructor_invocation'), type=node.childForFieldName('name')??child(node,'user_type')??(invocation&&child(invocation,'user_type'));
    const target=child(node,'use_site_target');
    return {...site(node),type:type?expression(type):unknown(node),args:args(named(node,'arguments','annotation_argument_list')??(invocation&&child(invocation,'value_arguments'))),...target?{target:target.text}:{}};
  };
  const annotations=(node:Node) => {
    const result:JvmAnnotationFact[]=[];
    const scan=(part:Node) => {if(['annotation','marker_annotation'].includes(part.type))result.push(annotation(part));else if(['modifiers','parameter_modifiers','annotated_type'].includes(part.type))for(const nested of part.namedChildren)scan(nested);};
    for(const part of node.namedChildren)scan(part);return result;
  };
  const scope = (node:Node, kind:JvmScopeFact['kind'], parent?:JvmScopeFact, owner?:string, conditional?:string):JvmScopeFact => {
    const value:JvmScopeFact={...site(node),key:`jvm-scope:${scopeOrdinal++}`,kind,...parent?{parent:parent.key}:{},...owner?{owner}:{},...conditional?{conditional}:{},...kind==='lambda'?{deferred:true}:{},gaps:[]};facts.scopes.push(value);return value;
  };
  const parameters=(node:Node, container:Node|undefined):JvmParameterFact[] => {
    if(!container)return [];
    const values:JvmParameterFact[]=[];
    const entries=container.type==='identifier'?[container]:container.namedChildren;
    for(let i=0;i<entries.length;i++){
      const parameter=entries[i]!;
      if(!['formal_parameter','spread_parameter','parameter','class_parameter','variable_declaration','identifier','receiver_parameter'].includes(parameter.type))continue;
      const name=parameter.childForFieldName('name')??child(parameter,'identifier'), type=parameter.childForFieldName('type')??parameter.namedChildren.find(part=>typeNodes.has(part.type));
      const next=entries[i+1], isDefault=next&&!['parameter','parameter_modifiers','formal_parameter'].includes(next.type)&&container.text.slice(parameter.endIndex-container.startIndex,next.startIndex-container.startIndex).includes('=');
      values.push({name:unescapeName(name?.text??(parameter.type==='identifier'?parameter.text:''))||undefined,...type?{type:expression(type)}:{},...isDefault?{default:expression(next!)}:{},...parameter.type==='spread_parameter'||/\bvararg\b/.test(parameter.text)?{variadic:true}:{},...parameter.type==='class_parameter'&&parameter.children.some(part=>['val','var'].includes(part.type))?{property:true}:{},annotations:[...annotations(parameter),...language==='kotlin'&&container.namedChildren[i-1]?.type==='parameter_modifiers'?annotations(container.namedChildren[i-1]!):[]]});
      if(isDefault)i++;
    }
    return values;
  };
  const bind=(node:Node,name:string,where:JvmScopeFact,kind:JvmBindingFact['kind'],type?:Node,value?:Node,immutable=false) => {facts.bindings.push({...site(node),name:unescapeName(name),scope:where.key,kind,...type?{type:expression(type)}:{},...value?{value:expression(value)}:{},immutable});};
  const definition = (node:Node, declaration:DeclarationFact, where:JvmScopeFact):JvmDefinitionFact => {
    const params=named(node,'parameters','formal_parameters','function_value_parameters')??child(child(node,'primary_constructor')??node,'class_parameters');
    const body=named(node,'body','function_body','class_body','enum_body','annotation_type_body','block','constructor_body');
    const resultType=node.childForFieldName('type')??(language==='kotlin'?node.namedChildren.find(part=>typeNodes.has(part.type)&&part.startIndex>declaration.nameEnd):undefined);
    const typeParameters=child(node,'type_parameters')?.namedChildren.flatMap(part=>part.namedChildren.filter(name=>['type_identifier','identifier'].includes(name.type)).slice(0,1).map(name=>unescapeName(name.text)))??[];
    const bases:JvmExpression[]=[];
    for(const heritage of node.namedChildren.filter(part=>['superclass','super_interfaces','extends_interfaces','delegation_specifiers'].includes(part.type))){
      const scan=(part:Node)=>{if(typeNodes.has(part.type)){bases.push(expression(part));return;}if(part.type==='constructor_invocation'){const type=child(part,'user_type');if(type)bases.push(expression(type));return;}for(const item of part.namedChildren)scan(item);};scan(heritage);
    }
    const valueNode=node.type==='variable_declarator'?node.childForFieldName('value'):node.type==='property_declaration'&&node.children.some(part=>part.type==='=')?node.namedChildren.at(-1):undefined;
    const type=declaration.kind==='property'?(node.parent?.childForFieldName('type')??child(child(node,'variable_declaration')??node,'user_type','nullable_type')):undefined;
    const def:JvmDefinitionFact={...site(node),key:declaration.key,name:unescapeName(declaration.name),kind:declaration.kind,scope:where.key,...declaration.parent?{parent:declaration.parent}:{},parameters:parameters(node,params),...resultType?{returnType:expression(resultType)}:{},...type?{returnType:expression(type)}:{},bases,typeParameters,annotations:annotations(node.type==='variable_declarator'?node.parent??node:node),...valueNode?{value:expression(valueNode)}:{},modifiers:declaration.modifiers??[],gaps:[]};
    if(language==='kotlin'&&callable.has(declaration.kind)){const receiver=node.namedChildren.find(part=>typeNodes.has(part.type)&&part.endIndex<declaration.nameEnd);if(receiver){def.receiverType=expression(receiver);def.gaps.push('Kotlin extension dispatch requires a reviewed receiver/overload profile');}}
    if(def.kind==='property')def.immutable=language==='java'?def.modifiers.includes('final'):node.children.some(part=>part.type==='val');
    if(language==='kotlin'&&node.namedChildren.some(part=>['getter','setter','property_delegate'].includes(part.type)))def.gaps.push('Custom/delegated Kotlin property requires a reviewed access profile');
    if(node.type==='enum_constant')def.gaps.push('Enum construction and anonymous constant bodies require a reviewed compiler profile');
    if(body){const selected=scope(body,typeKinds.has(def.kind)?'type':'function',where,def.key);if(typeKinds.has(def.kind))def.typeScope=selected.key;else def.bodyScope=selected.key;}
    facts.definitions.push(def);return def;
  };
  const fileScope=scope(root,'file');
  const reference=(node:Node,where:JvmScopeFact,kind:'value'|'type'|'method-reference'='value') => facts.references.push({...site(node),scope:where.key,expression:expression(node),kind});
  const visit=(node:Node,where:JvmScopeFact,suppressed=false):void => {
    if(++nodes>MAX_NODES||facts.calls.length+facts.references.length+facts.bindings.length>MAX_SITES){facts.complete=false;return;}
    if(['package_declaration','package_header','import','import_declaration','line_comment','block_comment','comment'].includes(node.type))return;
    const declaration=bySite.get(`${node.startIndex}:${node.endIndex}`);
    if(declaration){
      const def=definition(node,declaration,where), bodyKey=def.bodyScope??def.typeScope, bodyScope=bodyKey?facts.scopes.find(item=>item.key===bodyKey):undefined;
      const body=bodyScope?node.namedChildren.find(part=>part.startIndex===bodyScope.start&&part.endIndex===bodyScope.end):undefined;
      if(def.kind==='property'&&!['file','type','opaque'].includes(where.kind))facts.bindings.push({...site(node),scope:where.key,declaration:def.key,kind:'local',name:def.name,...def.returnType?{type:def.returnType}:{},...def.value?{value:def.value}:{},immutable:node.children.some(part=>part.type==='val')});
      if(bodyScope){
        for(const parameter of def.parameters){if(parameter.name)facts.bindings.push({...site(node),name:parameter.name,scope:bodyScope.key,kind:'parameter',...parameter.type?{type:parameter.type}:{},immutable:language==='kotlin'});}
        if(body){
          if(language==='kotlin'&&body.type==='function_body'&&body.children.some(part=>part.type==='=')&&body.namedChildren.length===1)facts.returns.push({...site(body),scope:bodyScope.key,value:expression(body.namedChildren[0]!)});
          visitChildren(body,bodyScope);
        }
      }
      // Initializers are evaluated in the declaration's original scope; their
      // nested lambdas retain separate deferred ownership.
      if(def.value){const valueNode=node.type==='variable_declarator'?node.childForFieldName('value'):node.namedChildren.at(-1);if(valueNode){const initializer=['file','type'].includes(where.kind)?scope(valueNode,'initializer',where,def.key):where;visit(valueNode,initializer);}}
      const header=node.namedChildren.filter(part=>part!==body&&part.endIndex<= (body?.startIndex??node.endIndex)&&part!==node.childForFieldName('name'));
      for(const part of header){if(typeNodes.has(part.type))reference(part,where,'type');}
      return;
    }
    if(['annotation','marker_annotation'].includes(node.type))return;
    if(['lambda_expression','lambda_literal'].includes(node.type)){
      const key=lambdaKey(node), own=scope(node,'lambda',where,key), params=named(node,'parameters','formal_parameters','lambda_parameters');
      const def:JvmDefinitionFact={...site(node),key,name:'<lambda>',kind:'lambda',scope:where.key,bodyScope:own.key,parameters:parameters(node,params),bases:[],typeParameters:[],annotations:[],modifiers:[],gaps:[]};facts.definitions.push(def);
      for(const parameter of def.parameters)if(parameter.name)facts.bindings.push({...site(node),scope:own.key,kind:'parameter',name:parameter.name,...parameter.type?{type:parameter.type}:{},immutable:language==='kotlin'});
      if(!params&&language==='kotlin')own.gaps.push('Implicit Kotlin lambda parameter/receiver requires a selected callable type');
      for(const part of node.namedChildren)if(part.id!==params?.id)visit(part,own);return;
    }
    if(['class_body','enum_body','annotation_type_body'].includes(node.type)){
      const own=scope(node,'opaque',where);own.gaps.push('Anonymous/local JVM type body requires a reviewed owning-type profile');visitChildren(node,own);return;
    }
    if(['companion_object','object_literal'].includes(node.type)){
      const own=scope(node,'opaque',where);own.gaps.push('Companion/anonymous-object receiver and generated bridges require a reviewed JVM profile');visitChildren(node,own);return;
    }
    if(['block','constructor_body'].includes(node.type)){const own=scope(node,'block',where);visitChildren(node,own);return;}
    if(['if_statement','if_expression','switch_expression','when_expression','while_statement','while_expression','do_statement','do_while_expression','for_statement','enhanced_for_statement','try_statement','try_expression','catch_clause','when_entry','switch_block_statement_group'].includes(node.type)){
      const own=scope(node,'control',where,undefined,`${node.type} body may execute conditionally`);
      if(node.type==='enhanced_for_statement'){const name=node.childForFieldName('name'), type=node.childForFieldName('type');if(name)bind(name,name.text,own,'loop',type??undefined);}
      if(language==='kotlin'&&node.type==='for_statement'){const variable=child(node,'variable_declaration'),name=variable&&child(variable,'identifier');if(name)bind(variable!,name.text,own,'loop',variable?.namedChildren.find(part=>typeNodes.has(part.type)));}
      if(node.type==='catch_clause'){const param=child(node,'catch_formal_parameter','parameter'),name=param&&named(param,'name','identifier');if(name)bind(param!,name.text,own,'catch',param?.childForFieldName('type')??undefined);}
      visitChildren(node,own);return;
    }
    if(node.type==='local_variable_declaration'){
      const type=node.childForFieldName('type');for(const variable of node.namedChildren.filter(part=>part.type==='variable_declarator')){const name=variable.childForFieldName('name'),value=variable.childForFieldName('value');if(name)bind(variable,name.text,where,'local',type??undefined,value??undefined,node.namedChildren.some(part=>part.type==='modifiers'&&/\bfinal\b/.test(part.text)));if(value)visit(value,where);}if(type)reference(type,where,'type');return;
    }
    if(node.type==='property_declaration'){
      const variable=child(node,'variable_declaration'),name=variable&&child(variable,'identifier'),type=variable?.namedChildren.find(part=>typeNodes.has(part.type)),value=node.children.some(part=>part.type==='=')?node.namedChildren.at(-1):undefined;
      if(name)bind(node,name.text,where,'local',type,value,node.children.some(part=>part.type==='val'));
      if(value)visit(value,where);if(type)reference(type,where,'type');if(!name)where.gaps.push('Destructuring/delegated Kotlin bindings need a selected type profile');return;
    }
    if(['assignment_expression','assignment','update_expression'].includes(node.type)){
      const target=node.childForFieldName('left')??node.namedChildren[0],value=node.childForFieldName('right')??node.namedChildren[1],operator=node.childForFieldName('operator')?.text??node.children.find(part=>!part.isNamed)?.text??'=';
      if(target)facts.writes.push({...site(node),scope:where.key,target:expression(target),...value?{value:expression(value)}:{},operator});if(value)visit(value,where);if(target&&target.type!=='identifier')visit(target,where);return;
    }
    if(['instanceof_expression','type_pattern','record_pattern','as_expression'].includes(node.type))where.gaps.push('Pattern/smart-cast binding requires a reviewed control-flow type profile');
    if(['return_statement','return_expression'].includes(node.type)){const value=node.namedChildren.at(-1);if(value){facts.returns.push({...site(node),scope:where.key,value:expression(value)});visit(value,where);}return;}
    if(['method_invocation','call_expression','object_creation_expression','explicit_constructor_invocation'].includes(node.type)){
      facts.calls.push({...site(node),scope:where.key,expression:expression(node),kind:node.type==='object_creation_expression'?'new':node.type==='explicit_constructor_invocation'?node.children.some(part=>part.type==='super')?'super':'this':'call'});
      // Arguments, receiver expressions and nested calls execute independently.
      const name=node.childForFieldName('name');for(const part of node.namedChildren)if(part.id!==name?.id){
        if(node.type==='call_expression'&&!child(node,'value_arguments')&&child(node,'annotated_lambda','lambda_literal')&&part===node.namedChildren[0]&&part.type==='call_expression')visitChildren(part,where,true);
        else visit(part,where,!['argument_list','value_arguments','annotated_lambda','lambda_literal'].includes(part.type));
      }return;
    }
    if(node.type==='method_reference'||node.type==='callable_reference'||node.type==='navigation_expression'&&node.children.some(part=>part.type==='::')){reference(node,where,'method-reference');return;}
    if(typeNodes.has(node.type)){reference(node,where,'type');return;}
    if(node.type==='field_access'||node.type==='navigation_expression'){if(!suppressed)reference(node,where);for(const part of node.namedChildren.slice(0,-1))visit(part,where,true);return;}
    if(node.type==='identifier'&&!suppressed){reference(node,where);return;}
    visitChildren(node,where,suppressed);
  };
  const visitChildren=(node:Node,where:JvmScopeFact,suppressed=false) => {for(const part of node.namedChildren)visit(part,where,suppressed);};
  visitChildren(root,fileScope);
  if(!facts.complete&&!facts.gaps.length)facts.gaps.push('JVM syntax/semantic extraction is incomplete or exceeded its budget');
  return facts;
}
