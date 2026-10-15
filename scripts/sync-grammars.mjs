// Restore pinned npm artifacts and verify committed release/source-built assets.
// --download-releases explicitly restores upstream assets by URL/checksum.
// Normal CLI builds use the committed assets without network or compilation.
import { createHash } from 'node:crypto';
import { readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
// manifest.json: the structural catalog; metrics.json: grammars only code health metrics use.
const grammars = ['manifest.json', 'metrics.json'].flatMap(name => JSON.parse(readFileSync(path.join(root, 'grammars', name), 'utf8')).grammars);
for (const grammar of grammars) {
  if(grammar.artifactBuild){
    const target=path.join(root,'grammars',grammar.file);
    let bytes;try{bytes=readFileSync(target);}catch{throw Error(`Pinned ${grammar.language} built asset missing; restore from version control or run node ${grammar.artifactBuild.script}`);}
    if(createHash('sha256').update(bytes).digest('hex')!==grammar.sha256)throw Error(`Built grammar checksum mismatch: ${grammar.language}`);
    continue;
  }
  if(grammar.artifactUrl){
    const target=path.join(root,'grammars',grammar.file);
    if(process.argv.includes('--download-releases')){
      const response=await fetch(grammar.artifactUrl,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error(`Grammar release download failed: ${grammar.language} (${response.status})`);
      const bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==grammar.sha256)throw Error(`Grammar release checksum mismatch: ${grammar.language}`);writeFileSync(target,bytes);
    }
    let bytes;try{bytes=readFileSync(target);}catch{throw Error(`Pinned ${grammar.language} release asset missing; restore with npm run grammars:sync -- --download-releases`);}
    if(createHash('sha256').update(bytes).digest('hex')!==grammar.sha256)throw Error(`Grammar release checksum mismatch: ${grammar.language}`);
    continue;
  }
  const directory = path.dirname(require.resolve(`${grammar.artifactPackage}/package.json`));
  const pkg = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (pkg.version !== grammar.artifactVersion) throw new Error(`Unexpected grammar artifact version: ${grammar.artifactPackage}`);
  const source = path.join(directory, grammar.artifactPath);
  const hash = createHash('sha256').update(readFileSync(source)).digest('hex');
  if (hash !== grammar.sha256) throw new Error(`Grammar checksum mismatch: ${grammar.language}`);
  copyFileSync(source, path.join(root, 'grammars', grammar.file));
}
console.log(`Verified/restored ${grammars.length} pinned grammar assets.`);
