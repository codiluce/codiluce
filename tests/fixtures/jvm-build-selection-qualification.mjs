// Portable ordinary compiled qualification of tests/jvm-build-selection.test.ts.
// Target Maven/Gradle/JVM applications, dependencies and configs never execute.
import assert from "node:assert/strict";
import { after, test as registerTest } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";




const sourceRoot=new URL(process.argv[2]);
assert.equal(sourceRoot.protocol,'file:');assert.ok(sourceRoot.pathname.endsWith('/'));
const completedCases=[];
function test(name,execute){return registerTest(name,async()=>{await execute();completedCases.push(name);});}
const { indexRepository } = await import(new URL("pipeline/index.js",sourceRoot));
const { resolveConfig } = await import(new URL("core/config.js",sourceRoot));
const { AnalysisCache } = await import(new URL("pipeline/cache.js",sourceRoot));
const { canonicalJson } = await import(new URL("history/fingerprint.js",sourceRoot));
const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function put(root, file, text) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}
async function repository(files) {
  const root = await mkdtemp(path.join(tmpdir(), "codiluce-jvm-selection-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) await put(root, file, text);
  return root;
}
const application = (buildSystem) => ({ name: "server", path: ".", jvm: { buildSystem } });
async function index(root, applications = [application()], cache, revision, ignore) {
  return indexRepository(root, { config: await resolveConfig(root, { repository: { name: "jvm-selection" }, applications, ignore }), cache, revision });
}
const projects = (graph) => graph.entities.find((entity) => entity.type === "repository").metadata.jvmProjects;
const outcomes = (graph, file) => graph.entities.find((entity) => entity.type === "file" && entity.path === file).metadata.importOutcomes;
const statuses = (graph, file) => outcomes(graph, file).map((item) => item.outcome.status);
const whole = (graph) => {
  const copy = structuredClone(graph);
  copy.run.id = "";
  copy.run.analyzedAt = "";
  return canonicalJson(copy);
};
const pom = (name = "app", extra = "") => `<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>${name}</artifactId><version>1</version>${extra}</project>`;
const java = {
  "src/main/java/client/Use.java": "// \u{1F600} original\r\npackage client;\r\nimport demo.Widget;\r\npublic class Use {}",
  "src/main/java/demo/Widget.java": "package demo; public class Widget {}"
};
const dual = { "pom.xml": pom(), "build.gradle.kts": "plugins { java }", ...java };
test("JVM build selection validates only recorded Maven/Gradle choices", async () => {
  const root = await repository({});
  for (const buildSystem of [null, "", false, 0, [], {}, "Maven", "auto", "../pom.xml", "maven,gradle"])
    await assert.rejects(resolveConfig(root, { applications: [{ ...application(), jvm: { buildSystem } }] }), /Invalid JVM compilation configuration/);
  for (const buildSystem of ["maven", "gradle"])
    assert.equal((await resolveConfig(root, { applications: [application(buildSystem)] })).applications[0]?.jvm?.buildSystem, buildSystem);
});
test("Recorded build family resolves dual-manifest imports with original identities and assumption evidence", async () => {
  const root = await repository(dual), unknown = await index(root);
  assert.deepEqual(statuses(unknown, "src/main/java/client/Use.java"), ["unsupported"]);
  for (const kind of ["maven", "gradle"]) {
    const graph = await index(root, [application(kind)]), model = projects(graph);
    assert.deepEqual(statuses(graph, "src/main/java/client/Use.java"), ["resolved"]);
    assert.equal(model.length, 1);
    assert.equal(model[0]?.kind, kind);
    assert.deepEqual(model[0]?.gaps, []);
    assert.ok(model[0]?.proof.some((fact) => fact.source === "framework" && fact.explanation?.includes(`Recorded jvm.buildSystem=${kind}`)));
    const edge = graph.relations.find((edge2) => edge2.type === "imports");
    assert.equal(graph.entities.find((entity) => entity.id === edge.to)?.path, "src/main/java/demo/Widget.java");
    assert.ok(edge.evidence.some((fact) => fact.file === "src/main/java/client/Use.java" && fact.line === 3));
    for (const entity of unknown.entities.filter((entity2) => entity2.language === "java")) {
      const selected = graph.entities.find((candidate) => candidate.id === entity.id);
      assert.equal(selected.path, entity.path);
      assert.deepEqual(selected.sourceRange, entity.sourceRange);
    }
  }
});
test("Selecting Maven or Gradle selects that original source-root contract", async () => {
  const root = await repository({
    ...dual,
    "pom.xml": pom("app", "<build><sourceDirectory>maven-src</sourceDirectory></build>"),
    "maven-src/client/Use.java": java["src/main/java/client/Use.java"],
    "maven-src/demo/Widget.java": java["src/main/java/demo/Widget.java"]
  });
  for (const [kind, selected, other] of [["maven", "maven-src/client/Use.java", "src/main/java/client/Use.java"], ["gradle", "src/main/java/client/Use.java", "maven-src/client/Use.java"]]) {
    const graph = await index(root, [application(kind)]);
    assert.deepEqual(statuses(graph, selected), ["resolved"]);
    assert.deepEqual(statuses(graph, other), ["unsupported"]);
    assert.ok(outcomes(graph, other)[0]?.outcome.reason?.includes("outside selected source roots"));
  }
});
test("Selected Gradle settings bind project dependencies without competing Maven sibling exports", async () => {
  const root = await repository({
    "pom.xml": pom(),
    "settings.gradle.kts": 'include(":app", ":lib")',
    "build.gradle.kts": "plugins { java }",
    "app/pom.xml": pom(),
    "app/build.gradle.kts": 'plugins { java }\ndependencies { implementation(project(":lib")) }',
    "lib/pom.xml": pom("lib"),
    "lib/build.gradle.kts": 'plugins { id("java-library") }',
    "app/src/main/java/client/Use.java": java["src/main/java/client/Use.java"],
    "lib/src/main/java/demo/Widget.java": java["src/main/java/demo/Widget.java"]
  });
  const graph = await index(root, [application("gradle")]);
  assert.deepEqual(statuses(graph, "app/src/main/java/client/Use.java"), ["resolved"]);
  assert.ok(projects(graph).every((project) => project.kind === "gradle" && project.reactor === "." && !project.gaps.length));
  assert.equal(graph.entities.find((entity) => entity.id === outcomes(graph, "app/src/main/java/client/Use.java")[0]?.outcome.targets?.[0])?.path, "lib/src/main/java/demo/Widget.java");
});
test("Recorded build ownership respects nested application boundaries and constrains conflicting Gradle members", async () => {
  const root = await repository({
    ...dual,
    "settings.gradle.kts": 'include(":nested")',
    "nested/pom.xml": pom(),
    "nested/build.gradle.kts": "plugins { java }",
    ...Object.fromEntries(Object.entries(java).map(([file, text]) => [`nested/${file}`, text]))
  });
  const graph = await index(root, [application("gradle"), { name: "nested", path: "nested", jvm: { buildSystem: "maven" } }]);
  assert.equal(projects(graph).find((project) => project.root === "nested")?.kind, "maven");
  assert.deepEqual(statuses(graph, "nested/src/main/java/client/Use.java"), ["resolved"]);
  assert.deepEqual(statuses(graph, "src/main/java/client/Use.java"), ["unsupported"]);
  assert.ok(projects(graph).find((project) => project.root === ".")?.gaps.some((gap) => gap.includes("conflicts with recorded Maven")));
  const unselected = await index(root, [application("maven"), { name: "nested", path: "nested" }]);
  assert.deepEqual(statuses(unselected, "src/main/java/client/Use.java"), ["resolved"]);
  assert.deepEqual(statuses(unselected, "nested/src/main/java/client/Use.java"), ["unsupported"]);
});
test("A missing or excluded selected build never falls back to the competing family or configured roots", async () => {
  for (const [kind, files, ignore] of [
    ["maven", { "build.gradle.kts": "plugins { java }", ...java }, void 0],
    ["gradle", { "pom.xml": pom(), ...java }, void 0],
    ["maven", dual, ["pom.xml"]],
    ["gradle", dual, ["build.gradle.kts"]]
  ]) {
    const root = await repository(files), app = { ...application(kind), sourceRoots: { java: ["src/main/java"] }, jvm: { buildSystem: kind, dependencies: [] } };
    const graph = await index(root, [app], void 0, void 0, ignore && [...ignore]);
    assert.deepEqual(statuses(graph, "src/main/java/client/Use.java"), ["unsupported"]);
    assert.equal(projects(graph)[0]?.kind, kind);
    assert.ok(projects(graph)[0]?.gaps.length);
  }
});
test("Build selection retains opaque model and within-Gradle ambiguity gaps", async () => {
  const cases = [
    ["maven", { ...dual, "pom.xml": pom("app", "<parent><groupId>external</groupId><artifactId>parent</artifactId><version>1</version><relativePath/></parent>") }, /unavailable Maven parent/],
    ["gradle", { ...dual, "build.gradle.kts": "plugins { java }\nmutateClasspath()" }, /Custom Gradle roots\/classpath\/flow/],
    ["gradle", { ...dual, "build.gradle": 'plugins { id "java" }' }, /Competing Gradle build scripts/],
    ["gradle", { ...dual, "settings.gradle": 'rootProject.name = "a"', "settings.gradle.kts": 'rootProject.name = "b"' }, /Competing Gradle settings/]
  ];
  for (const [kind, files, reason] of cases) {
    const graph = await index(await repository(files), [application(kind)]);
    assert.deepEqual(statuses(graph, "src/main/java/client/Use.java"), ["unsupported"]);
    assert.match(projects(graph).flatMap((project) => project.gaps).join("; "), reason);
  }
});
test("Maven reactors do not relabel a module explicitly owned by Gradle", async () => {
  const root = await repository({
    "pom.xml": pom("root", "<modules><module>nested</module></modules>"),
    ...java,
    "nested/pom.xml": pom(),
    "nested/build.gradle.kts": "plugins { java }",
    ...Object.fromEntries(Object.entries(java).map(([file, text]) => [`nested/${file}`, text]))
  });
  const graph = await index(root, [application("maven"), { name: "nested", path: "nested", jvm: { buildSystem: "gradle" } }]);
  assert.deepEqual(statuses(graph, "src/main/java/client/Use.java"), ["unsupported"]);
  assert.deepEqual(statuses(graph, "nested/src/main/java/client/Use.java"), ["resolved"]);
  assert.equal(projects(graph).find((project) => project.root === "nested")?.reactor, "nested");
  assert.ok(projects(graph).find((project) => project.root === ".")?.gaps.some((gap) => gap.includes("Maven module conflicts")));
});
test("A Maven parent crossing a Gradle ownership boundary cannot initialize a competing project", async () => {
  const root = await repository({
    ...dual,
    "nested/pom.xml": "<project><modelVersion>4.0.0</modelVersion><parent><groupId>demo</groupId><artifactId>app</artifactId><version>1</version></parent><artifactId>nested</artifactId></project>",
    ...Object.fromEntries(Object.entries(java).map(([file, text]) => [`nested/${file}`, text]))
  });
  const graph = await index(root, [application("gradle"), { name: "nested", path: "nested", jvm: { buildSystem: "maven" } }]);
  assert.equal(projects(graph).find((project) => project.root === ".")?.kind, "gradle");
  assert.deepEqual(statuses(graph, "src/main/java/client/Use.java"), ["resolved"]);
  assert.deepEqual(statuses(graph, "nested/src/main/java/client/Use.java"), ["unsupported"]);
  assert.ok(projects(graph).find((project) => project.root === "nested")?.gaps.some((gap) => gap.includes("unavailable Maven parent")));
});
test("Spring MVC and WebFlux consumers use the recorded build choice without bypassing compilation gaps", async () => {
  const source = {
    mvc: 'package demo; import org.springframework.web.bind.annotation.RestController; import org.springframework.web.bind.annotation.GetMapping; @RestController public class Api { @GetMapping("/selected") public void show(){} }',
    webflux: 'package demo; import org.springframework.context.annotation.Configuration; import org.springframework.context.annotation.Bean; import org.springframework.web.reactive.function.server.RouterFunctions; import org.springframework.web.reactive.function.server.RouterFunction; import org.springframework.web.reactive.function.server.ServerRequest; import org.springframework.web.reactive.function.server.ServerResponse; import reactor.core.publisher.Mono; @Configuration(proxyBeanMethods=false) public final class Api { @Bean public RouterFunction<ServerResponse> routes(){return RouterFunctions.route().GET("/selected",this::show).build();} private Mono<ServerResponse> show(ServerRequest request){return null;} }'
  };
  for (const stack of ["mvc", "webflux"]) {
    const root = await repository({ ...dual, "src/main/java/demo/Api.java": source[stack] });
    const spring = { version: "7.0.9", stack, componentScan: ["demo"] };
    const unknown = await index(root, [{ ...application(), jvm: { spring } }]);
    assert.equal(unknown.entities.filter((entity) => entity.type === "api_endpoint").length, 0);
    for (const buildSystem of ["maven", "gradle"]) {
      const graph = await index(root, [{ ...application(buildSystem), jvm: { buildSystem, spring } }]);
      const endpoints = graph.entities.filter((entity) => entity.type === "api_endpoint");
      assert.equal(endpoints.length, 1);
      assert.equal(endpoints[0]?.metadata.framework, stack === "mvc" ? "spring-mvc" : "spring-webflux");
      assert.equal(endpoints[0]?.metadata.constraintsUnresolved, false);
      assert.ok(graph.relations.some((edge) => edge.type === "handles" && edge.from === endpoints[0]?.id && graph.entities.find((entity) => entity.id === edge.to)?.path === "src/main/java/demo/Api.java"));
    }
    await put(root, "build.gradle.kts", "plugins { java }\nmutateClasspath()");
    const opaque = await index(root, [{ ...application("gradle"), jvm: { buildSystem: "gradle", spring } }]);
    assert.equal(opaque.entities.filter((entity) => entity.type === "api_endpoint").length, 0);
  }
});
test("Changing the recorded build family invalidates warm bindings and preserves complete graph replay", async () => {
  const root = await repository(dual), state = await repository({});
  for (const kind of [void 0, "maven", "gradle", void 0]) {
    const selected = [application(kind)], coldCache = new AnalysisCache(state), cold = await index(root, selected, coldCache), warmCache = new AnalysisCache(state);
    const warm = await index(root, selected, warmCache), fresh = await index(root, selected);
    assert.equal(whole(cold), whole(warm));
    assert.equal(whole(cold), whole(fresh));
    assert.ok(warmCache.events.some((event) => event.analyzer === "jvm-imports" && event.hit));
    if (kind) assert.ok(coldCache.events.some((event) => event.analyzer === "jvm-imports" && !event.hit));
    assert.deepEqual(statuses(warm, "src/main/java/client/Use.java"), [kind ? "resolved" : "unsupported"]);
    const revision = await index(root, selected, new AnalysisCache(state), "a".repeat(40));
    assert.equal(whole(revision), whole(await index(root, selected, void 0, "a".repeat(40))));
  }
});

after(async()=>{
 assert.equal(completedCases.length,11,'All original JVM build-selection cases must pass');
 const record={schema:1,passed:true,sourceRoot:sourceRoot.href,caseCount:completedCases.length,completedCases,targetExecution:false,typescriptSourceLoader:false,normalization:['run.id','run.analyzedAt'],scope:'Recorded Maven/Gradle ownership, original roots/identities/proof, project dependencies, nested ownership, missing/denied builds, opaque model gaps, reactor/parent boundaries, MVC/WebFlux handlers and complete selection/cache/revision graph equality.'};
 if(process.argv[3])await writeFile(process.argv[3],JSON.stringify(record,null,2)+'\n');
 console.log(JSON.stringify(record));
});
