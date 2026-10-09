import type { ApplicationInput, RawConfig } from '../../src/core/config.js';

// Original source-contract fixtures: only Codiluce's indexer executes them.
export const rustProfiles = [
  { name: 'axum7', framework: 'axum', version: '0.7.9', dialect: 'axum-0.7' },
  { name: 'axum8', framework: 'axum', version: '0.8.9', dialect: 'axum-0.8' },
  { name: 'actix4', framework: 'actix-web', version: '4.15.0', dialect: 'actix-web-4' },
  { name: 'rocket5', framework: 'rocket', version: '0.5.1', dialect: 'rocket-0.5' },
  { name: 'warp3', framework: 'warp', version: '0.3.7', dialect: 'warp-0.3' },
  { name: 'warp4', framework: 'warp', version: '0.4.3', dialect: 'warp-0.4' },
] as const;
export const rustFrontendNames = ['ts', 'vue', 'svelte', 'astro'];
export const rustOrigin = (name: string) => `https://${name}.test`;

export function rustWorkload(count = 1, includeRust = true): { files: Record<string, string>; config: RawConfig; expectedEndpoints: number; expectedRequests: number } {
  if (!Number.isSafeInteger(count) || count < 1 || count > 32) throw new Error('resource count must be 1–32 (bounded native filter trees)');
  const files: Record<string, string> = {}, applications: ApplicationInput[] = rustFrontendNames.map(name => ({ name, path: name, ...(name === 'ts' ? { ecosystems: ['node'] } : { frameworks: [name] }) }));
  files['vue/package.json'] = '{"dependencies":{"vue":"3.5.0"}}';
  files['svelte/package.json'] = '{"dependencies":{"svelte":"5.57.2"}}';
  files['astro/package.json'] = '{"dependencies":{"astro":"7.3.8"}}';
  files['astro/astro.config.mjs'] = 'export default {output:"server"};';
  if (includeRust) {
    files['Cargo.toml'] = '[workspace]\nresolver="2"\nmembers=[' + [...rustProfiles.map(profile => profile.name), 'common'].map(name => `"${name}"`).join(',') + ']';
    files['common/Cargo.toml'] = '[package]\nname="common"\nversion="1.0.0"\nedition="2021"';
    files['common/src/lib.rs'] = '// 😀 original shared dependency\r\n#[cfg(unix)]\r\npub fn leaf()->&\'static str {"unix"}\r\n#[cfg(windows)]\r\npub fn leaf()->&\'static str {"windows"}';
  }
  const calls: string[][] = Array.from({ length: count }, () => []);
  for (const profile of rustProfiles) {
    const { name, framework, version } = profile;
    for (let i = 0; i < count; i++) calls[i]!.push(`fetch('${rustOrigin(name)}/api/items${i}/12')`);
    if (!includeRust) continue;
    applications.push({ name, path: name, ecosystems: ['rust'], apiOrigins: [rustOrigin(name)], rust: { package: 'Cargo.toml', target: { kind: 'bin', name }, features: ['api'], defaultFeatures: false, targetTriple: 'x86_64-unknown-linux-gnu', cfg: { flags: ['unix'], values: { target_os: ['linux'], target_arch: ['x86_64'], target_pointer_width: ['64'] } } } });
    files[`${name}/Cargo.toml`] = `[package]\nname="${name}"\nversion="1.0.0"\nedition="2021"\n[dependencies]\ncommon={path="../common"}\nweb={package="${framework}",version="${version}"${name === 'warp4' ? ',features=["server"]' : ''}}\n${framework !== 'rocket' && framework !== 'actix-web' ? 'tokio={version="1.53.2",features=["full"]}\n' : ''}[features]\napi=[]`;
    let startup: string, routes: string;
    const handlers = Array.from({ length: count }, (_, i) => framework === 'rocket'
      ? `#[web::get("/items${i}/<id>")]\r\npub fn show${i}(id:u8)->&'static str {common::leaf()}\r\n`
      : `pub async fn show${i}(${framework === 'warp' ? 'id:u8' : ''})->&'static str {common::leaf()}\r\n`).join('');
    if (framework === 'axum') {
      routes = 'use web::{Router,routing::get};\r\npub fn routes()->Router {let app=Router::new();' + Array.from({ length: count }, (_, i) => `let app=app.route("/items${i}/${name === 'axum7' ? ':id' : '{id}'}",get(show${i}));`).join('') + 'app}';
      startup = '#[tokio::main]\r\nasync fn main(){let router=web::Router::new().nest("/api",routes::routes());let listener=tokio::net::TcpListener::bind("127.0.0.1:3000").await.unwrap();web::serve(listener,router).await.unwrap();}';
    } else if (framework === 'actix-web') {
      routes = 'use web::web as routes_web;\r\npub fn configure(cfg:&mut routes_web::ServiceConfig){let scope=routes_web::scope("/api");' + Array.from({ length: count }, (_, i) => `let scope=scope.route("/items${i}/{id}",routes_web::get().to(show${i}));`).join('') + 'cfg.service(scope);}';
      startup = '#[web::main]\r\nasync fn main(){web::HttpServer::new(||web::App::new().configure(routes::configure)).bind("127.0.0.1:3000").unwrap().run().await.unwrap();}';
    } else if (framework === 'rocket') {
      routes = '';
      startup = '#[web::launch]\r\nfn application()->_ {web::build().mount("/api",web::routes![' + Array.from({ length: count }, (_, i) => `routes::show${i}`).join(',') + '])}';
    } else {
      routes = 'use web::Filter;\r\npub fn routes()->impl web::Filter<Extract=(impl web::Reply,),Error=web::Rejection>+Clone {web::path("api").and(' + Array.from({ length: count }, (_, i) => `web::path!("items${i}"/u8).and(web::get()).then(show${i})`).join('.or(') + ')'.repeat(count - 1) + ')}';
      startup = 'use web::Filter;\r\n#[tokio::main]\r\nasync fn main(){let routes=routes::routes();web::serve(routes).' + (name === 'warp3' ? 'run(([127,0,0,1],3000)).await;' : 'bind(([127,0,0,1],3000)).await.run().await;') + '}';
    }
    files[`${name}/src/main.rs`] = '// 😀 original startup\r\n#[cfg(feature="api")]\r\nmod routes;\r\n' + startup;
    files[`${name}/src/routes.rs`] = '// 😀 original handlers\r\n' + handlers + routes;
  }
  for (let i = 0; i < count; i++) {
    files[`ts/client${i}.ts`] = calls[i]!.map((call, n) => `export function request${n}(){return ${call};}`).join('\n');
    files[`vue/Component${i}.vue`] = '<script setup>const native=fetch;</script><template>' + calls[i]!.map(call => `<button @click="${call.replace('fetch(', 'native(')}"/>`).join('') + '</template>';
    files[`svelte/Component${i}.svelte`] = '<script>const native=fetch;</script>' + calls[i]!.map(call => `<button onclick={()=>${call.replace('fetch(', 'native(')}}>Load</button>`).join('');
    files[`astro/src/pages/page${i}.astro`] = calls[i]!.map(call => `{${call}}`).join('\n');
  }
  // Native Axum/Actix 404/405 responses are counted separately from source handlers.
  const expectedEndpoints = includeRust ? rustProfiles.length * count : 0;
  return { files, config: { repository: { name: 'rust-qualification' }, applications, maxFileBytes: 1 << 20 }, expectedEndpoints, expectedRequests: expectedEndpoints * rustFrontendNames.length };
}
