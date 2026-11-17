'use strict';
const entries = Object.fromEntries(
  ['root', 'providers', 'observe'].map((key) => [
    key,
    require.resolve('agentfootprint' + (key === 'root' ? '' : '/' + key)),
  ]),
);
process.stdout.write(JSON.stringify({ format: 'cjs', entries }) + '\n');
