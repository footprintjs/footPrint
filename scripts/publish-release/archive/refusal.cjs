'use strict';
const { createHash } = require('node:crypto');
const refusals = new WeakMap();
const fieldNames = new Set([
  'name',
  'version',
  'type',
  'description',
  'license',
  'author',
  'repository',
  'bugs',
  'homepage',
  'engines',
  'sideEffects',
  'main',
  'module',
  'types',
  'files',
  'exports',
  'scripts',
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'bin',
  'dist',
  'tag',
  'publishConfig',
  'keywords',
  'packageManager',
  'workspaces',
  'root',
]);
const fail = (code = 'invalid-archive', key) => {
  const e = new Error(code);
  e.code = code;
  const field =
    key === undefined
      ? ''
      : ':' + (fieldNames.has(key) ? key : 'key-' + createHash('sha256').update(key).digest('hex').slice(0, 12));
  refusals.set(e, code + field);
  throw e;
};
const archiveRefusalCode = (error) => refusals.get(error);
module.exports = { fail, archiveRefusalCode };
