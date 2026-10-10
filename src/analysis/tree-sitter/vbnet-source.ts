/** Bounded original VB header tokens only, anchored to a native declaration.
 * This never searches for declarations or runs target programs. */
export interface VbToken {text:string;start:number;end:number;kind:'word'|'identifier'|'literal'|'punctuation'}
export const vbFold=(text:string)=>text.replace(/[A-Z]/g,c=>c.toLowerCase());
export const vbName=(text:string)=>vbFold(text.startsWith('[')&&text.endsWith(']')?text.slice(1,-1):text);
export function vbHeader(content:string,start:number,end:number):{end:number;tokens:VbToken[];complete:boolean} {
 const tokens:VbToken[]=[],limit=Math.min(end,content.length,start+8192);let at=start,depth=0;
 while(at<limit){
  const begin=at,c=content[at]!;
  if(c==='\r'||c==='\n'){
   const continuation=tokens.at(-1)?.text==='_';if(continuation)tokens.pop();
   if(!depth&&!continuation)return {end:begin,tokens,complete:true};
   at+=c==='\r'&&content[at+1]==='\n'?2:1;continue;
  }
  if(/[ \t\f\u00a0]/.test(c)){at++;continue;}
  if(c==='\''||vbFold(content.slice(at,at+3))==='rem'&&(at===start||/\s/.test(content[at-1]!))&&/\s/.test(content[at+3]??'')){
   while(at<limit&&!/[\r\n]/.test(content[at]!))at++;
   if(!depth)return {end:begin,tokens,complete:true};continue;
  }
  if(c===':'&&!depth)return {end:begin,tokens,complete:true};
  let kind:VbToken['kind']='punctuation';
  if(c==='"'){
   kind='literal';at++;let closed=false;while(at<limit){if(content[at]==='"'){if(content[at+1]==='"'){at+=2;continue;}at++;closed=true;break;}at++;}if(!closed)return {end:at,tokens,complete:false};if(/[cC]/.test(content[at]??''))at++;
  }else if(c==='['){kind='identifier';at++;while(at<limit&&content[at]!==']'&&!/[\r\n]/.test(content[at]!))at++;if(content[at]!==']')return {end:at,tokens,complete:false};at++;}
  else if(c==='#'&&content.indexOf('#',at+1)>at){const close=content.indexOf('#',at+1);if(close>=limit||/[\r\n]/.test(content.slice(at,close)))return {end:at,tokens,complete:false};kind='literal';at=close+1;}
  else if(/[A-Za-z_]/.test(c)){kind='word';at++;while(at<limit&&/[A-Za-z_0-9]/.test(content[at]!))at++;if(/[$%&@#!]/.test(content[at]??''))at++;}
  else {if(c==='(')depth++;if(c===')')depth--;at++;}
  tokens.push({text:content.slice(begin,at),start:begin,end:at,kind});
 }
 return {end:at,tokens,complete:at===Math.min(end,content.length)&&depth===0&&tokens.at(-1)?.text!=='_'};
}
export function vbHeaderIdentity(tokens:VbToken[]):string {
 return tokens.map(t=>t.kind==='literal'?t.text:t.kind==='identifier'?vbName(t.text):vbFold(t.text)).join(' ');
}
