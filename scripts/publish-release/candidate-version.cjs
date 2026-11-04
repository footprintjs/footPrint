'use strict';

// Same patch/minor/major source-bump law as foottrace's release-changes.cjs.
const BUMPS = [2, 1, 0];
const CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function parts(version) {
  if (typeof version !== 'string' || version.length > 128 || !CORE.test(version)) return undefined;
  const values = version.split('.').map(Number);
  return values.every((value) => Number.isSafeInteger(value) && value < Number.MAX_SAFE_INTEGER) ? values : undefined;
}

function candidateMatchesSource(version, sourceVersion) {
  const candidate = typeof version === 'string' && version.length <= 128 && /^(.+)-rc\.(0|[1-9]\d*)$/.exec(version);
  const source = parts(sourceVersion);
  if (!candidate || !parts(candidate[1]) || !source) return false;
  return BUMPS.some((index) => {
    const next = [...source];
    next[index] += 1;
    for (let at = index + 1; at < 3; at++) next[at] = 0;
    return next.join('.') === candidate[1];
  });
}

module.exports = { candidateMatchesSource };
