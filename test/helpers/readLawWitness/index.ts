import { checkedPair, equalNativeTrace } from './readPair.js';
import { projectSite } from './retained.js';
import { type JoinedRun, type ReadPair, type Relation, equal, refuse, Unproven124 } from './types.js';

/**
 * Named #124 relation for read-only retained differences, with identical commits and all other bytes exact.
 * Unsupported evidence is failure, not an opcode/index/suffix exemption. No target object is mutated.
 */
export function readRetention124(a: JoinedRun, b: JoinedRun, pairs: readonly ReadPair[]): Relation {
  try {
    if (a.program !== b.program || !pairs.length) return refuse('different program or absent bound read evidence');
    if (b.commits.some((commit) => !commit.foldsBack)) return refuse('build commit does not fold back');
    if (
      !equal(
        a.commits.map(({ bytes }) => bytes),
        b.commits.map(({ bytes }) => bytes),
      )
    )
      return refuse('changed commit needs a separate first-divergence cause witness');
    identicalNativeCommits(a, b);
    const checked = pairs.map((pair) => checkedPair(a.native, b.native, pair));
    if (!equalNativeTrace(a.native, b.native, pairs))
      return refuse('native prefix/order/write or another native result differs');
    const projected: Record<string, string> = { ...a.kept };
    const sites = new Set<string>();
    const coordinates = new Set<string>();
    let changed = false;
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const [x, y] = checked[i];
      const coordinate = JSON.stringify([pair.baseline.coordinate, pair.baseline.occurrence]);
      if (coordinates.has(coordinate)) return refuse('operation occurrence claimed twice');
      coordinates.add(coordinate);
      for (const site of pair.sites) {
        const field = site.kind === 'read-line' ? 'reads' : site.field;
        if (!Object.hasOwn(projected, field) || !Object.hasOwn(b.kept, field)) return refuse('absent retained field');
        const after = projectSite(b.kept[field], 'build', site, y);
        const before = projectSite(projected[field], 'baseline', site, x, after.value);
        if (before.key !== after.key || sites.has(before.key)) return refuse('ambiguous retained slot');
        sites.add(before.key);
        changed ||= !equal(before.value, after.value);
        projected[field] = before.text;
      }
    }
    // Exact strings: this preserves every live/checkpoint/error/commit/fold byte and unselected leaf.
    if (
      Object.keys(projected).length !== Object.keys(b.kept).length ||
      Object.keys(projected).some((field) => !Object.hasOwn(b.kept, field) || projected[field] !== b.kept[field])
    )
      return refuse('residual retained, live, checkpoint, error, commit or fold difference');
    if (!changed) return refuse('no changed retained read; remove stale named admission');
    return {
      kind: 'related',
      name: 'read-after-delete-124',
      coordinates: pairs.map((p) =>
        p.baseline.occurrence === undefined
          ? p.baseline.coordinate
          : [...p.baseline.coordinate, 'native-read', p.baseline.occurrence],
      ),
    };
  } catch (error) {
    return {
      kind: 'unproven',
      reason: error instanceof Unproven124 ? error.message : 'unreadable native/retained proof',
    };
  }
}
import { identicalNativeCommits } from './commits.js';
