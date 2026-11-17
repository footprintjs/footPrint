'use strict';

// Fixed Storydeck51 policy from ci1ca5d7de9bde68c205b5d140c94dc475ae3b2520,
// archive/{allowed,inspector}.cjs. This is policy only; no tar/JSON parser is copied.
const ROOTS = ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/CHANGELOG.md'];
const PREFIXES = ['package/dist/', 'package/plugin/'];
const BROWSER = 'package/site/public/deck-stage.js';
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)$/i;
const foldedByAFileSystem = (part) =>
  part.endsWith('.') ||
  part.endsWith(' ') ||
  part.includes('~') ||
  part.includes(':') ||
  DEVICE.test(part.split('.')[0].trimEnd());

function storydeckMember(path) {
  const parts = path.slice('package/'.length).toLowerCase().split('/');
  const name = parts.at(-1);
  if (
    name === '.npmrc' ||
    parts.slice(0, -1).includes('node_modules') ||
    (parts.length === 1 && ['binding.gyp', 'server.js', 'npm-shrinkwrap.json'].includes(name))
  )
    return false;
  return (
    ROOTS.includes(path) ||
    path === BROWSER ||
    PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    /^package\/[^/]+\.d\.ts$/.test(path) ||
    /^package\/[^/]+\.css$/.test(path)
  );
}

/** Same native required-member and filesystem-collision law; caller already admitted regular paths. */
function storydeckComplete(files) {
  const paths = files.map((file) => file.path);
  if (
    !paths.includes(BROWSER) ||
    !paths.includes('package/CHANGELOG.md') ||
    PREFIXES.some((prefix) => !paths.some((path) => path.startsWith(prefix)))
  )
    return false;
  const folds = new Set(),
    folders = new Set();
  for (const path of paths) {
    const folded = path.toLowerCase();
    if (folds.has(folded) || folders.has(folded) || path.split('/').some(foldedByAFileSystem)) return false;
    const parents = folded
      .split('/')
      .slice(1, -1)
      .map((_, i, all) => `package/${all.slice(0, i + 1).join('/')}`);
    if (parents.some((parent) => folds.has(parent))) return false;
    for (const parent of parents) folders.add(parent);
    if (folded === 'package/package.json' && path !== 'package/package.json') return false;
    folds.add(folded);
  }
  return true;
}
module.exports = { storydeckMember, storydeckComplete };
