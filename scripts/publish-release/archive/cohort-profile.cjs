'use strict';
const { storydeckMember, storydeckComplete } = require('./storydeck-profile.cjs');

// AF's existing native policy, not a caller/plan override:
// footprintjs/agentfootprint@9288d55ae50bcbe65c365064e3166e4d600e79f1
// scripts/publish-archive/{archive,verify}.cjs. No parser is imported/copied.
const normal = Object.freeze({
  maxArchiveBytes: 16 * 1024 * 1024,
  maxExpandedBytes: 64 * 1024 * 1024,
  maxFiles: 10000,
});
const agent = Object.freeze({
  maxArchiveBytes: 32 * 1024 * 1024,
  maxExpandedBytes: 128 * 1024 * 1024,
  maxFiles: 20000,
});

function cohortLimits(packageName) {
  return { ...(packageName === 'agentfootprint' ? agent : normal) };
}

function cohortMember(packageName, path) {
  if (packageName === 'footprint-storydeck') return storydeckMember(path);
  const roots = ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/AGENTS.md'];
  const prefixes = ['package/dist/'];
  if (packageName === 'agentfootprint') {
    roots.push('package/CAPABILITIES.md', 'package/canonical-notes.json');
    prefixes.push('package/ai-instructions/', 'package/bin/');
  }
  return roots.includes(path) || prefixes.some((prefix) => path.startsWith(prefix));
}

/** Files and implied directories are different budgets; metadata cannot supply either limit. */
function cohortEntryLimit(packageName, files) {
  if (packageName !== 'agentfootprint') return 20000;
  const directories = new Set();
  for (const { path } of files) {
    const parts = path.slice('package/'.length).split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  // The installed package may have one dependency directory, inspected separately by npm's graph.
  return files.length + directories.size + 1;
}

const cohortComplete = (packageName, files) => packageName !== 'footprint-storydeck' || storydeckComplete(files);
const cohortVersion = (name, source, version) => name !== 'footprint-storydeck' || source?.version === version;
module.exports = { cohortLimits, cohortMember, cohortEntryLimit, cohortComplete, cohortVersion };
