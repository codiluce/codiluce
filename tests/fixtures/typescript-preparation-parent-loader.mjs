// Only the owning process uses this loader; owned workers have explicit execArgv.
export async function resolve(specifier,context,nextResolve){
  if(specifier==='svelte/compiler'||specifier.startsWith('@astrojs/compiler-'))throw Error(`Optional parser used in parent: ${specifier}`);
  if(specifier==='typescript'){
    const real=await nextResolve(specifier,context);
    const code=`import ts from ${JSON.stringify(real.url)};const forbidden=new Set(['createSourceFile','createProgram','createCompilerHost','readConfigFile','parseJsonConfigFileContent','parseJsonSourceFileConfigFileContent','parseJsonText','preProcessFile','resolveModuleName']);export default new Proxy(ts,{get(target,key){if(forbidden.has(key))return()=>{throw Error('Compiler construction used in parent: '+key)};return Reflect.get(target,key)}});`;
    return {url:'data:text/javascript,'+encodeURIComponent(code),shortCircuit:true};
  }
  return nextResolve(specifier,context);
}
