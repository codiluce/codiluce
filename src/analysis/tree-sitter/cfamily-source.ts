/** Bounded original-source tokens for profiles which cannot expand SDK macros.
 * Comments, literals and physical preprocessor bodies never introduce syntax. */
export interface SourceToken {text:string;start:number;end:number;opaque?:boolean}
export interface SourceDirective {text:string;start:number;end:number;conditions:string[]}
export interface CfamilySource {tokens:SourceToken[];pairs:Map<number,number>;directives:SourceDirective[];truncated:boolean}
export function cfamilySource(content:string):CfamilySource {
 const tokens:SourceToken[]=[],directives:SourceDirective[]=[],conditions:string[]=[];
 const identifier=/[\p{ID_Start}_$][\p{ID_Continue}$]*/uy,raw=/(?:u8|u|U|L)?R"([^\s()\\]{0,16})\(/y;
 let index=0,lineHasCode=false,truncated=false,conditionalDepth=0;
 while(index<content.length){
  if(tokens.length>=200_000||directives.length>=4096){truncated=true;break;}
  const start=index,char=content[index]!;
  if(/\s/.test(char)){if(char==='\n')lineHasCode=false;index++;continue;}
  if(content.startsWith('//',index)){const end=content.indexOf('\n',index+2);index=end<0?content.length:end;continue;}
  if(content.startsWith('/*',index)){const end=content.indexOf('*/',index+2);index=end<0?content.length:end+2;if(content.slice(start,index).includes('\n'))lineHasCode=false;continue;}
  if(char==='#'&&!lineHasCode){
   let end=index;do{const next=content.indexOf('\n',end);if(next<0){end=content.length;break;}end=next+1;}while(/\\\r?\n$/.test(content.slice(index,end)));
   const original=content.slice(index,end).trim(),text=original.slice(0,8192),kind=/^#\s*(\w+)/.exec(text)?.[1];
   if(original.length>8192)truncated=true;
   if(kind==='if'||kind==='ifdef'||kind==='ifndef'){conditionalDepth++;if(conditionalDepth<=128)conditions.push(text.split('\n')[0]!);else truncated=true;}
   else if(['elif','elifdef','elifndef','else'].includes(kind??'')&&conditions.length&&conditionalDepth<=128)conditions[conditions.length-1]=`${conditions.at(-1)} | ${text.split('\n')[0]}`.slice(0,8192);
   else if(kind==='endif'){if(conditionalDepth<=128)conditions.pop();conditionalDepth=Math.max(0,conditionalDepth-1);}
   directives.push({start,end,text,conditions:[...conditions]});index=end;lineHasCode=false;continue;
  }
  lineHasCode=true;raw.lastIndex=index;const rawMatch=raw.exec(content);
  if(rawMatch){const end=content.indexOf(`)${rawMatch[1]}"`,index+rawMatch[0].length);index=end<0?content.length:end+rawMatch[1]!.length+2;tokens.push({text:'literal',start,end:index,opaque:true});continue;}
  if(char==='"'||char==="'"){const quote=char;index++;while(index<content.length){if(content[index]==='\\')index+=2;else if(content[index++]===quote)break;}index=Math.min(index,content.length);tokens.push({text:'literal',start,end:index,opaque:true});continue;}
  identifier.lastIndex=index;const match=identifier.exec(content);
  if(match){index=identifier.lastIndex;tokens.push({text:match[0],start,end:index});}
  else {index++;tokens.push({text:char,start,end:index});}
 }
 const pairs=new Map<number,number>(),stack:number[]=[];
 for(let at=0;at<tokens.length;at++){
  const text=tokens[at]!.text;if(['(','{','['].includes(text))stack.push(at);
  else if([')', '}', ']'].includes(text)){const open=stack.pop();if(open!==undefined&&({'(':')','{':'}','[':']'} as Record<string,string>)[tokens[open]!.text]===text){pairs.set(open,at);pairs.set(at,open);}else stack.length=0;}
 }
 return {tokens,pairs,directives,truncated};
}
export function sourceConditions(source:CfamilySource,start:number):string[]{
 let low=0,high=source.directives.length;while(low<high){const middle=(low+high)>>>1;if(source.directives[middle]!.end<=start)low=middle+1;else high=middle;}
 return [...source.directives[low-1]?.conditions??[]];
}
export const sourceIdentifier=(token:SourceToken|undefined):token is SourceToken=>!!token&&!token.opaque&&/^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u.test(token.text);
