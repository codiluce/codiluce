// This loader runs only in the owning process. Source workers have explicit
// execArgv, so their approved optional compiler imports remain available.
export async function resolve(specifier,context,nextResolve){
  if(specifier==='svelte/compiler'||specifier.startsWith('@astrojs/compiler-'))throw Error(`Optional framework parser loaded in main process: ${specifier}`);
  return nextResolve(specifier,context);
}
