'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { inspectArchive, archiveRefusalCode, parseManifest } = require('./archive/inspector.cjs');
const { candidateMatchesSource } = require('./candidate-version.cjs');

function refuse(code) {
  const error = new Error(code);
  error.releaseCode = code;
  throw error;
}

function regularBytes(file, maximum) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum) refuse('ERR_RELEASE_FILE');
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function sourceManifest(file) {
  const source = parseManifest(regularBytes(file, 1024 * 1024));
  if (source.name !== 'footprintjs' || typeof source.version !== 'string') refuse('ERR_RELEASE_SOURCE_MANIFEST');
  return source;
}

function checkArchive(intake, sourceFile, version) {
  if (!path.isAbsolute(intake)) refuse('ERR_RELEASE_INTAKE');
  const stat = fs.lstatSync(intake);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse('ERR_RELEASE_INTAKE');
  const entries = fs.readdirSync(intake);
  if (entries.length !== 1 || entries[0] !== 'package.tgz') refuse('ERR_RELEASE_INTAKE');
  const file = path.join(intake, 'package.tgz');
  inspectArchive(regularBytes(file, 16 * 1024 * 1024), {
    package: 'footprintjs',
    version,
    sourceManifest: sourceManifest(sourceFile),
  });
  return file;
}

function preparePublishDirectory(directory, intake, source) {
  if (!path.isAbsolute(directory) || !path.isAbsolute(intake) || !path.isAbsolute(source))
    refuse('ERR_RELEASE_PUBLISH_DIRECTORY');
  const resolved = [
    path.join(fs.realpathSync(path.dirname(directory)), path.basename(directory)),
    fs.realpathSync(intake),
    fs.realpathSync(source),
  ];
  const within = (a, b) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
  if (within(resolved[0], resolved[1]) || within(resolved[0], resolved[2])) refuse('ERR_RELEASE_PUBLISH_DIRECTORY');
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(directory).length !== 0)
    refuse('ERR_RELEASE_PUBLISH_DIRECTORY');
}

if (require.main === module) {
  try {
    const [operation, first, second, third] = process.argv.slice(2);
    if (operation === 'source') process.stdout.write(sourceManifest(first).version + '\n');
    else if (operation === 'candidate') {
      if (!candidateMatchesSource(first, second)) refuse('ERR_RELEASE_RC_SOURCE_VERSION');
    } else if (operation === 'inspect') checkArchive(first, second, third);
    else if (operation === 'directory') preparePublishDirectory(first, second, third);
    else refuse('ERR_RELEASE_OPERATION');
  } catch (error) {
    const code = error.releaseCode || archiveRefusalCode(error) || 'ERR_RELEASE_ARCHIVE';
    process.stderr.write('::error::' + code + '\n');
    process.exitCode = 1;
  }
}

module.exports = { sourceManifest, checkArchive, preparePublishDirectory };
