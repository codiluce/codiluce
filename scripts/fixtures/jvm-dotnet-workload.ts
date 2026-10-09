import type { ApplicationInput, RawConfig } from '../../src/core/config.js';

// Generated source-contract inputs. The harness runs only Codiluce's indexer.
export const jvmProfiles = ['mvc', 'webflux'].flatMap(stack => ['java', 'kotlin'].flatMap(language => [
  { name: `${stack}-${language}-62`, stack, language, version: '6.2.0', bootVersion: '3.5.0' },
  { name: `${stack}-${language}-70`, stack, language, version: '7.0.0', bootVersion: '4.0.0' },
])) as { name: string; stack: 'mvc' | 'webflux'; language: 'java' | 'kotlin'; version: string; bootVersion: string }[];
export const aspnetProfiles = [8, 9, 10].map(major => ({ name: `aspnet${major}`, major }));
export const frontendNames = ['ts', 'vue', 'svelte', 'astro'];
export const origin = (name: string) => `https://${name}.test`;

export function jvmDotnetWorkload(count = 1): { files: Record<string, string>; config: RawConfig; expectedEndpoints: number; expectedRequests: number } {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) throw new Error('resource count must be 1–100');
  const files: Record<string, string> = {}, applications: ApplicationInput[] = frontendNames.map(name => ({ name, path: name, ...(name === 'ts' ? { ecosystems: ['node'] } : { frameworks: [name] }) }));
  files['vue/package.json'] = '{"dependencies":{"vue":"3.5.0"}}';
  files['svelte/package.json'] = '{"dependencies":{"svelte":"5.57.2"}}';
  files['astro/package.json'] = '{"dependencies":{"astro":"7.3.8"}}';
  files['astro/astro.config.mjs'] = 'export default {output:"server"};';
  const calls: string[][] = Array.from({ length: count }, () => []);
  for (const profile of jvmProfiles) {
    const { name, language, stack } = profile;
    applications.push({ name, path: name, ecosystems: ['jvm'], apiOrigins: [origin(name)], sourceRoots: { [language]: [`src/main/${language}`] }, jvm: { dependencies: [], spring: { stack, version: profile.version, bootVersion: profile.bootVersion, componentScan: ['demo'], ...(stack === 'mvc' ? { contextPath: '/ctx' } : { basePath: '/ctx' }) } } });
    for (let i = 0; i < count; i++) {
      const prefix = `${name}/src/main/${language}/demo`, route = `/items${i}/{id}`;
      if (language === 'java') {
        const body = stack === 'mvc'
          ? `import org.springframework.web.bind.annotation.RestController;\r\nimport org.springframework.web.bind.annotation.GetMapping;\r\n@RestController\r\npublic class Items${i} {\r\n @GetMapping("${route}")\r\n public String show(){return leaf();}\r\n private String leaf(){return "ok";}\r\n}`
          : `import org.springframework.context.annotation.Configuration;\r\nimport org.springframework.context.annotation.Bean;\r\nimport org.springframework.core.annotation.Order;\r\nimport org.springframework.web.reactive.function.server.RouterFunctions;\r\nimport org.springframework.web.reactive.function.server.RouterFunction;\r\nimport org.springframework.web.reactive.function.server.ServerRequest;\r\nimport org.springframework.web.reactive.function.server.ServerResponse;\r\nimport reactor.core.publisher.Mono;\r\n@Configuration(proxyBeanMethods=false)\r\npublic class Items${i} {\r\n @Bean @Order(${i}) public RouterFunction<ServerResponse> routes${i}(){return RouterFunctions.route().GET("${route}",this::show).build();}\r\n private Mono<ServerResponse> show(ServerRequest request){return leaf();}\r\n private Mono<ServerResponse> leaf(){return null;}\r\n}`;
        files[`${prefix}/Items${i}.java`] = `// 😀 original handler\r\npackage demo;\r\n${body}`;
      } else {
        const body = stack === 'mvc'
          ? `import org.springframework.web.bind.annotation.RestController as Rest\r\nimport org.springframework.web.bind.annotation.GetMapping as Get\r\n@Rest\r\nclass Items${i} {\r\n @Get("${route}")\r\n fun show(): String = leaf()\r\n private fun leaf(): String = "ok"\r\n}`
          : `import org.springframework.context.annotation.Configuration\r\nimport org.springframework.context.annotation.Bean\r\nimport org.springframework.core.annotation.Order\r\nimport org.springframework.web.reactive.function.server.router as routesDsl\r\nimport org.springframework.web.reactive.function.server.ServerRequest\r\nimport org.springframework.web.reactive.function.server.ServerResponse\r\nimport reactor.core.publisher.Mono\r\n@Configuration(proxyBeanMethods=false)\r\nclass Items${i} {\r\n @Bean @Order(${i}) fun routes${i}() = routesDsl { GET("${route}", ::show) }\r\n private fun show(request: ServerRequest): Mono<ServerResponse> = leaf()\r\n private fun leaf(): Mono<ServerResponse> = null\r\n}`;
        files[`${prefix}/Items${i}.kt`] = `// 😀 original handler\r\npackage demo\r\n${body}`;
      }
      calls[i]!.push(`fetch('${origin(name)}/ctx/items${i}/12')`);
    }
  }
  for (const { name, major } of aspnetProfiles) {
    applications.push({ name, path: name, ecosystems: ['dotnet'], apiOrigins: [origin(name)], dotnet: { aspnet: { pathBase: '/ctx' } } });
    files[`${name}/App.csproj`] = `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net${major}.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings></PropertyGroup><ItemGroup><Compile Remove="lib/**/*.cs"/><ProjectReference Include="lib\\Library.csproj"/></ItemGroup></Project>`;
    files[`${name}/lib/Library.csproj`] = `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net${major}.0</TargetFramework></PropertyGroup></Project>`;
    files[`${name}/lib/Leaf.cs`] = '// 😀 original source dependency\r\nnamespace Original;\r\npublic static class Leaf {\r\n public static string Read()=>"ok";\r\n}';
    files[`${name}/Program.cs`] = '// 😀 original startup\r\nvar builder=WebApplication.CreateBuilder(args);\r\nbuilder.Services.AddControllers();\r\nvar app=builder.Build();\r\n' + Array.from({ length: count }, (_, i) => `app.MapGet("/minimal${i}/{id:int}",Handlers.Show${i});\r\n`).join('') + 'app.MapControllers();\r\napp.Run();';
    files[`${name}/Handlers.cs`] = 'using Original;\r\npublic static class Handlers {\r\n' + Array.from({ length: count }, (_, i) => ` public static string Show${i}(int id)=>Leaf.Read();\r\n`).join('') + '}';
    for (let i = 0; i < count; i++) {
      files[`${name}/Items${i}Controller.cs`] = `// 😀 original MVC action\r\nusing Microsoft.AspNetCore.Mvc;\r\nusing Original;\r\n[Route("mvc${i}")]\r\npublic class Items${i}Controller {\r\n [HttpGet("{id:int}")]\r\n public string Show(int id)=>Leaf.Read();\r\n}`;
      calls[i]!.push(`fetch('${origin(name)}/ctx/minimal${i}/12')`, `fetch('${origin(name)}/ctx/mvc${i}/12')`);
    }
  }
  for (let i = 0; i < count; i++) {
    files[`ts/client${i}.ts`] = calls[i]!.map((call, n) => `export function request${n}(){return ${call};}`).join('\n');
    files[`vue/Component${i}.vue`] = '<script setup>const native=fetch;</script><template>' + calls[i]!.map(call => `<button @click="${call.replace('fetch(', 'native(')}"/>`).join('') + '</template>';
    files[`svelte/Component${i}.svelte`] = '<script>const native=fetch;</script>' + calls[i]!.map(call => `<button onclick={()=>${call.replace('fetch(', 'native(')}}>Load</button>`).join('');
    files[`astro/src/pages/page${i}.astro`] = calls[i]!.map(call => `{${call}}`).join('\n');
  }
  const expectedEndpoints = (jvmProfiles.length + aspnetProfiles.length * 2) * count;
  return { files, config: { repository: { name: 'jvm-dotnet-qualification' }, applications, maxFileBytes: 1 << 20 }, expectedEndpoints, expectedRequests: expectedEndpoints * frontendNames.length };
}
