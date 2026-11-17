const entries = Object.fromEntries(
  ['root', 'providers', 'observe'].map((key) => [
    key,
    import.meta.resolve('agentfootprint' + (key === 'root' ? '' : '/' + key)),
  ]),
);
process.stdout.write(JSON.stringify({ format: 'esm', entries }) + '\n');
