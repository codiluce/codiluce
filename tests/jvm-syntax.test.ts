import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StructureParser } from '../src/analysis/tree-sitter/client.js';
import { SourceText } from '../src/analysis/source-map.js';
async function parse(language:string,text:string){const parser=new StructureParser();try{const facts=await parser.parse(language,text);assert.equal(facts.issues.length,0,JSON.stringify(facts.issues));assert.ok(facts.jvm?.complete);assert.ok(facts.jvm?.semantic?.complete);return {syntax:facts.jvm!,semantic:facts.jvm!.semantic!,declarations:facts.declarations};}finally{parser.close();}}

test('Original Java annotations, signatures, inheritance and constants are scoped syntax data',async()=>{
 const text='// 😀 original\r\npackage demo;\r\n@RestController\r\n@RequestMapping(path={"/v1", Paths.ROOT}, method=RequestMethod.GET)\r\npublic final class Api extends Base implements Contract {\r\n private final Service service = new Service();\r\n @GetMapping(value="/{id}", params={"q=x", "!debug"})\r\n public String show(@PathVariable String id) { return service.find(id); }\r\n private static String helper(int n) { return "ok"; }\r\n}\r\n';
 const {semantic,declarations}=await parse('java',text),api=semantic.definitions.find(def=>def.name==='Api')!,show=semantic.definitions.find(def=>def.name==='show')!;
 assert.deepEqual(api.bases.map(base=>base.kind==='name'&&base.name),['Base','Contract']);assert.deepEqual(api.modifiers,['public','final']);assert.deepEqual(api.annotations.map(annotation=>annotation.type.kind==='name'&&annotation.type.name),['RestController','RequestMapping']);assert.equal(api.annotations[1]?.args[0]?.name,'path');assert.equal(api.annotations[1]?.args[0]?.value.kind,'array');assert.equal(show.annotations[0]?.range.startLine,7);assert.equal(show.parameters[0]?.name,'id');assert.equal(show.parameters[0]?.annotations[0]?.type.kind,'name');assert.equal(show.parameters[0]?.type?.kind,'name');
 assert.equal(semantic.definitions.find(def=>def.name==='helper')?.parameters[0]?.type?.kind,'name');assert.equal(semantic.calls.length,2);assert.equal(semantic.calls[1]?.expression.kind,'call');assert.equal(semantic.scopes.find(scope=>scope.key===semantic.calls[1]?.scope)?.owner,show.key);
 assert.ok(declarations.some(declaration=>declaration.key===show.key));assert.deepEqual(show.range,new SourceText(text).range(show.start,show.end));
});

test('Kotlin aliases, annotation arrays, constructor properties, defaults and extension receivers retain original sites',async()=>{
 const text='package demo\nimport org.springframework.web.bind.annotation.GetMapping as Get\n@RestController\n@RequestMapping(path=["/api"], method=[RequestMethod.GET])\nclass Api(private val service: Service) : Base(), Contract {\n @Get("/{id}")\n fun show(@PathVariable id: String): String {\n  val local: Service = Service()\n  return local.find(id)\n }\n private fun helper(x: String = "default"): String = x\n}\nfun String.extension(): String = this\n';
 const {syntax,semantic}=await parse('kotlin',text),api=semantic.definitions.find(def=>def.name==='Api')!,show=semantic.definitions.find(def=>def.name==='show')!;
 assert.equal(syntax.imports[0]?.alias,'Get');assert.deepEqual(api.bases.map(base=>base.kind==='name'&&base.name),['Base','Contract']);assert.equal(api.parameters[0]?.property,true);assert.equal(show.annotations[0]?.type.kind,'name');assert.equal(show.parameters[0]?.annotations[0]?.type.kind,'name');assert.ok(semantic.bindings.some(binding=>binding.name==='local'&&binding.value?.kind==='call'&&binding.immutable));assert.equal(semantic.definitions.find(def=>def.name==='helper')?.parameters[0]?.default?.kind,'literal');assert.equal(semantic.definitions.find(def=>def.name==='extension')?.receiverType?.kind,'name');assert.ok(semantic.definitions.find(def=>def.name==='extension')?.gaps.length);
});

test('Java blocks, captured writes, loop bindings, lambda ownership and method references stay separate',async()=>{
 const text='package demo; public final class Api { public void run(){ final Service local=new Service(); Runnable f=()->local.work(); if(enabled){ String local="shadow"; use(local); } else { local.work(); } for(String item:items){use(item);} value++; } public Runnable ref(){return this::run;} }';
 const {semantic}=await parse('java',text),lambda=semantic.definitions.find(def=>def.kind==='lambda')!;
 assert.ok(lambda.bodyScope);assert.equal(semantic.calls.filter(call=>call.expression.kind==='call'&&call.expression.callee.kind==='member'&&call.expression.callee.name==='work').length,2);assert.ok(semantic.calls.some(call=>call.scope===lambda.bodyScope));assert.ok(semantic.bindings.some(binding=>binding.kind==='loop'&&binding.name==='item'));assert.equal(semantic.bindings.filter(binding=>binding.name==='local').length,2);assert.ok(semantic.scopes.some(scope=>scope.conditional));assert.ok(semantic.writes.some(write=>write.target.kind==='name'&&write.target.name==='value'));assert.ok(semantic.references.some(reference=>reference.kind==='method-reference'));
});

test('Kotlin nested functions, immutable locals, lambdas and conditional writes retain lexical scopes',async()=>{
 const text='package demo\nfun run(){\n val local = Service()\n var changed = Service()\n val f = { x: String -> local.work(x) }\n if(enabled){changed = Other()}\n fun nested(){local.work()}\n nested()\n}\n';
 const {semantic}=await parse('kotlin',text);assert.ok(semantic.definitions.some(def=>def.kind==='lambda'&&def.parameters[0]?.name==='x'));assert.ok(semantic.definitions.some(def=>def.name==='nested'&&def.parent));assert.ok(semantic.bindings.some(binding=>binding.name==='local'&&binding.immutable));assert.ok(semantic.bindings.some(binding=>binding.name==='changed'&&!binding.immutable));assert.ok(semantic.writes.some(write=>write.target.kind==='name'&&write.target.name==='changed'));assert.ok(semantic.scopes.some(scope=>scope.kind==='lambda'&&scope.deferred));
});

test('Generic type arguments remain syntax data; nullable, anonymous and labeled receivers stay opaque',async()=>{
 const text='package demo\nclass Api {\n fun run(value: Service?, generic: List<String>){\n  value?.work()\n  val anon = object {\n   fun work() {}\n  }\n  anon.work()\n }\n}\n';
 const {semantic}=await parse('kotlin',text),run=semantic.definitions.find(def=>def.name==='run')!;assert.equal(run.parameters[0]?.type?.kind,'unknown');assert.equal(run.parameters[1]?.type?.kind,'generic-type');assert.ok(semantic.scopes.some(scope=>scope.kind==='opaque'&&scope.gaps.length));assert.ok(semantic.calls.some(call=>call.expression.kind==='call'&&call.expression.callee.kind==='member'&&call.expression.callee.safe));
});

test('Java functional expected-type syntax keeps generic results, single lambda parameters and bare Kotlin callable references original',async()=>{
 const java=await parse('java','class Api { Mono<ServerResponse> show(ServerRequest request){return null;} Object router(){return route().GET("/x",request -> response());} }'),show=java.semantic.definitions.find(def=>def.name==='show')!,lambda=java.semantic.definitions.find(def=>def.kind==='lambda')!;
 assert.equal(show.returnType?.kind,'generic-type');assert.equal(lambda.parameters[0]?.name,'request');
 const kotlin=await parse('kotlin','@Configuration(proxyBeanMethods=false)\nclass Api {\n fun routes() = router {\n  POST("/x") { request -> response() }\n  GET("/y", ::show)\n  (GET("/a") or GET("/b")) { response() }\n }\n}');
 assert.equal(kotlin.semantic.definitions[0]?.annotations[0]?.args[0]?.value.kind,'literal');assert.ok(kotlin.semantic.returns.some(item=>item.value.kind==='call'));assert.ok(kotlin.semantic.references.some(item=>item.expression.kind==='method-reference'&&!item.expression.object&&item.expression.name==='show'));
 const post=kotlin.semantic.calls.filter(item=>item.expression.kind==='call'&&item.expression.callee.kind==='name'&&item.expression.callee.name==='POST');assert.equal(post.length,1);assert.equal(post[0]?.expression.kind==='call'&&post[0].expression.args.length,2);
});
