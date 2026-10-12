// Codiluce's authored IPC fixture. It never imports or executes target input.
process.on('message', job => {
  const options = JSON.parse(job.content);
  process.send?.({id: -1, kind: 'started', job: job.language, pid: process.pid});
  if (options.exit) process.exit(7);
  if (options.delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, options.delay);
  if (options.error) process.send?.({id: job.id, error: 'Owned source error'});
  else process.send?.({id: job.id, facts: {declarations: [], issues: [], truncated: false,
    original: job.content, language: job.language, pid: process.pid}});
});
