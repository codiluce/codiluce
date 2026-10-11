// Pure JS keeps source-checkout parsing independent of a TypeScript loader.
// Only Codiluce's parse-only provider executes; no target PHP/autoloader does.
import { Engine } from 'php-parser';

process.on('message',job=>{
  try {
    const engine=new Engine({parser:{version:'8.4',suppressErrors:false,extractTokens:true},ast:{withPositions:true}});
    const root=engine.parseCode(job.content,'original.php');
    if(!Array.isArray(root.tokens)||root.tokens.length>200_000)throw Error('PHP native source-unit token budget exceeded');
    const stack=[{value:root,depth:0}];let visited=0;
    while(stack.length) {
      const {value,depth}=stack.pop();
      if(++visited>400_000||depth>512)throw Error('PHP native source-unit node/depth budget exceeded');
      for(const [key,child] of Object.entries(value)) {
        if(['comments','leadingComments','trailingComments'].includes(key)){delete value[key];continue;}
        if(key==='tokens'||key==='loc')continue;
        if(Array.isArray(child)) {
          for(const item of child)if(item&&typeof item==='object')stack.push({value:item,depth:depth+1});
        }else if(child&&typeof child==='object')stack.push({value:child,depth:depth+1});
      }
    }
    const phpAstBytes=Buffer.byteLength(JSON.stringify(root));
    if(phpAstBytes>16*1024*1024)throw Error('PHP native source-unit payload exceeds 16 MiB');
    process.send?.({id:job.id,facts:{declarations:[],issues:[],truncated:false,phpAst:root,phpAstBytes}});
  }catch(error){process.send?.({id:job.id,error:error instanceof Error?error.message:String(error)});}
});
