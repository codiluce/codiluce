// Generated from Codiluce’s typed source-only framework parser. Do not edit.
// Rebuild: npm run build:framework-worker

// src/analysis/embedded/framework-worker.ts
import { serialize } from "node:v8";
function reply(id, facts) {
  const payload = serialize({ facts });
  process.send?.({ id, type: "completed", completedAtNs: process.hrtime.bigint().toString(), bytes: payload.byteLength });
  process.send?.({ id, type: "result", payload });
}
async function handle(job) {
  try {
    if (job.language === "svelte") {
      const { parse } = await import("svelte/compiler");
      reply(job.id, { value: parse(job.content, { modern: true, filename: job.file }) });
    } else if (job.language === "astro") {
      const { parse } = await import("@astrojs/compiler-rs");
      reply(job.id, { value: parse(job.content) });
    } else throw Error("Unknown framework parser language");
  } catch (error) {
    const native = error;
    const failure = { display: String(error), ...typeof native?.message === "string" ? { message: native.message } : {}, ...typeof native?.name === "string" ? { name: native.name } : {}, ...native?.position ? { position: native.position } : {}, ...native?.start ? { start: native.start } : {} };
    reply(job.id, { failure });
  }
}
var pending = Promise.resolve();
process.on("message", (job) => {
  pending = pending.then(() => handle(job));
});
process.once("disconnect", () => process.exit(0));
