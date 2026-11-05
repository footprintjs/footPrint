/** Pure input-policy controls; no registry, child process, package or source edits. */
import semver from 'semver';
import { describe, expect, it, vi } from 'vitest';

import { developmentInstallVersions } from './version-policy.mjs';

describe('generated development-install version policy', () => {
  it.each([
    ['^1.11.0', '1.11.0', '1.11.1'], // old stable source data
    ['^1.11.0', '1.11.9', '1.11.10'],
    ['^0.2.0', '0.2.8', '0.2.9'],
    ['^1.11.1-rc.0', '1.11.1-rc.0', '1.11.1-rc.1'], // actual authorized RC input
    ['^1.11.1-rc.0', '1.11.1-rc.9', '1.11.1-rc.10'],
    ['^1.11.1-beta.1', '1.11.1-rc.2', '1.11.1-rc.3'],
    ['^1.11.1-beta', '1.11.1-beta', '1.11.1-beta.0'],
    ['^0.0.1-rc.0', '0.0.1-rc.0', '0.0.1-rc.1'],
    ['^1.11.1-rc.0', '1.11.1', '1.11.2'], // actual pin controls strategy
    ['^1.11.0+floor.build', '1.11.0+installed.build', '1.11.1'],
  ])('keeps %s at %s locked while admitting synthetic newer %s', (range, pinned, newer) => {
    expect(developmentInstallVersions(range, pinned)).toEqual({ range, pinned, newer });
    expect(semver.gt(newer, pinned)).toBe(true);
    expect(semver.satisfies(pinned, range)).toBe(true);
    expect(semver.satisfies(newer, range)).toBe(true);
  });

  it.each([
    '*',
    '1.11.0',
    '~1.11.0',
    '^1',
    '^1.11',
    '^1.11.x',
    '^v1.11.0',
    '^^1.11.0',
    '>=1.11.0',
    '^1.11.0 || ^2.0.0',
    '^1.11.0 <2.0.0',
    ' ^1.11.0',
    '^1.11.0 ',
    '^1.11.0\n',
    '^1.11.0 - 2.0.0',
  ])('refuses arbitrary or non-exact range %j', (range) => {
    expect(() => developmentInstallVersions(range, '1.11.0')).toThrow('Generated install fixture version policy:');
  });

  it.each([
    'latest',
    'v1.11.0',
    '=1.11.0',
    '1.11',
    '01.11.0',
    '1.11.0-01',
    '1.11.0+',
    '1.11.0 ',
    '9007199254740992.0.0',
    '1.11.1-rc.9007199254740992',
  ])('refuses non-finite or non-exact pin %j', (pinned) => {
    expect(() => developmentInstallVersions('^1.11.0', pinned)).toThrow('Generated install fixture version policy:');
  });

  it.each([
    ['^1.11.0', '1.11.1-rc.0'], // stable range does not admit this prerelease
    ['^1.11.1-rc.0', '1.12.0-beta.0'], // no includePrerelease bypass across cores
    ['^1.11.1-rc.2', '1.11.1-rc.1'],
    ['^1.11.0', '2.0.0'],
  ])('requires installed %s / %s to be an actually compatible pair', (range, pinned) => {
    expect(() => developmentInstallVersions(range, pinned)).toThrow('development pin is outside its contributor range');
  });

  it('refuses rather than widens a caret boundary that has no compatible patch increment', () => {
    expect(() => developmentInstallVersions('^0.0.1', '0.0.1')).toThrow(
      'generated version is outside the actual contributor range',
    );
  });

  it('validates finite generated output rather than relying blindly on increment', () => {
    const increment = vi.spyOn(semver, 'inc').mockReturnValueOnce(null);
    try {
      expect(() => developmentInstallVersions('^1.11.0', '1.11.0')).toThrow(
        'generated version must be an exact finite SemVer',
      );
    } finally {
      increment.mockRestore();
    }
  });

  it('independently refuses an increment that is not strictly newer', () => {
    const increment = vi.spyOn(semver, 'inc').mockReturnValueOnce('1.11.0');
    try {
      expect(() => developmentInstallVersions('^1.11.0', '1.11.0')).toThrow('strictly newer');
    } finally {
      increment.mockRestore();
    }
  });

  it('independently refuses a newer increment outside the actual range', () => {
    const increment = vi.spyOn(semver, 'inc').mockReturnValueOnce('2.0.0');
    try {
      expect(() => developmentInstallVersions('^1.11.0', '1.11.0')).toThrow('outside the actual contributor range');
    } finally {
      increment.mockRestore();
    }
  });
});
