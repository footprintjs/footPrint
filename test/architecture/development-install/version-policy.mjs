// Generated install-fixture versions only; never changes a source dependency policy.
import semver from 'semver';

const fail = (reason) => {
  throw new Error(`Generated install fixture version policy: ${reason}.`);
};

/** @param {unknown} value @param {string} label */
function exactVersion(value, label) {
  if (typeof value !== 'string' || !value || value.length > 256 || !/^[0-9]/u.test(value) || /\s/u.test(value))
    fail(`${label} must be an exact finite SemVer`);
  const parsed = semver.parse(value, { loose: false });
  if (!parsed || ![parsed.major, parsed.minor, parsed.patch].every(Number.isSafeInteger))
    fail(`${label} must be an exact finite SemVer`);
  // Numeric prerelease identifiers participate in increment/comparison too.
  if (parsed.prerelease.some((part) => /^\d+$/u.test(String(part)) && !Number.isSafeInteger(Number(part))))
    fail(`${label} has a non-finite numeric prerelease identifier`);
  return parsed;
}

/**
 * Accept ONE caret of a complete exact stable/prerelease floor. The installed
 * pin must really satisfy it under normal SemVer prerelease admission. Create
 * one strictly newer compatible synthetic registry version or refuse loudly.
 * @param {unknown} range
 * @param {unknown} pinned
 */
export function developmentInstallVersions(range, pinned) {
  if (typeof range !== 'string' || !range.startsWith('^')) fail('a single full-version caret range is required');
  exactVersion(range.slice(1), 'caret floor');
  const installed = exactVersion(pinned, 'development pin');
  if (!semver.satisfies(pinned, range)) fail('development pin is outside its contributor range');
  const newer = semver.inc(pinned, installed.prerelease.length ? 'prerelease' : 'patch');
  exactVersion(newer, 'generated version');
  if (!semver.gt(newer, pinned)) fail('generated version must be strictly newer than the pin');
  if (!semver.satisfies(newer, range)) fail('generated version is outside the actual contributor range');
  return Object.freeze({ range, pinned, newer });
}
