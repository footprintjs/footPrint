import type { RetainedReadWindow } from '../nativeTraceFacts.js';
import { nativeCommits } from './commits.js';
import { checkedPair } from './readPair.js';
import { projectSite, retainedStage } from './retained.js';
import { ownsFinalSlot } from './retentionOwner.js';
import { type JoinedRun, type ReadPair, equal, refuse } from './types.js';

/** Shape1 before FIRST, proved separately; never a propagation hop or a later-commit cause. */
export function priorRetainedWindows(
  a: JoinedRun,
  b: JoinedRun,
  pairs: readonly ReadPair[],
  first: number,
): {
  readonly facts: readonly RetainedReadWindow[];
  readonly pairs: readonly ReadPair[];
} {
  if (!pairs.length) return { facts: [], pairs };
  if (a.program !== b.program || a.native.leg !== b.native.leg || b.commits.some((row) => !row.foldsBack))
    return refuse('earlier window has another program/leg or a nonfolding BUILD');
  const commits = [nativeCommits(a), nativeCommits(b)] as const;
  const projected: Record<string, string> = { ...a.kept };
  const selected = new Set<string>();
  const sites = new Map<string, ReadPair['sites'][number]>();
  const facts: RetainedReadWindow[] = [];
  for (const pair of pairs) {
    const checked = checkedPair(a.native, b.native, pair);
    if (!ownsFinalSlot(a.native, checked[0].read) || !ownsFinalSlot(b.native, checked[1].read))
      return refuse('earlier selected read does not own its actual final retained slot');
    const ordinal = JSON.stringify([pair.baseline.coordinate, pair.baseline.occurrence]);
    if (selected.has(ordinal) || !pair.sites.length)
      return refuse('earlier window is duplicate or has no retained slot');
    selected.add(ordinal);
    const indices = checked.map(({ read, get }, side) => {
      const run = side === 0 ? a : b;
      const span = pair.operationSpans?.[side === 0 ? 'baseline' : 'build'];
      if (
        !span ||
        run.operations?.filter((row) => row === span).length !== 1 ||
        !equal(span.coordinate, pair[side === 0 ? 'baseline' : 'build'].coordinate) ||
        span.start !== pair[side === 0 ? 'baseline' : 'build'].start ||
        span.end !== pair[side === 0 ? 'baseline' : 'build'].end ||
        span.outcome !== 'returned' ||
        span.edits.length
      )
        return refuse('earlier window has no unchanged original operation member');
      if (run.native.events.some((row) => span.start < row.start && row.end < span.end && row.phase === 'write'))
        return refuse('earlier retained window contains a write, not shape1');
      const own = commits[side].flatMap((commit, i) =>
        commit.frame === read.frame &&
        commit.buffer === get.buffer &&
        commit.epoch === get.epoch &&
        equal(commit.header, read.header) &&
        commit.start > span.end &&
        i < first
          ? [i]
          : [],
      );
      if (own.length !== 1) return refuse('earlier read has no unique pre-FIRST stage commit');
      return own[0];
    });
    const commit = indices[0];
    if (
      commit !== indices[1] ||
      !a.commits[commit].foldsBack ||
      a.commits[commit].bytes !== b.commits[commit].bytes ||
      commits[0][commit].encoder!.bytes !== commits[1][commit].encoder!.bytes
    )
      return refuse('earlier window stage commit differs');
    let changed = false;
    for (const site of pair.sites) {
      const field = site.kind === 'read-line' ? 'reads' : site.field;
      if (!Object.hasOwn(projected, field) || !Object.hasOwn(b.kept, field))
        return refuse('missing earlier retained field');
      const now = projectSite(b.kept[field], 'build', site, checked[1]);
      const old = projectSite(projected[field], 'baseline', site, checked[0], now.value);
      if (old.key !== now.key || sites.has(old.key)) return refuse('earlier retained slot claimed twice');
      sites.set(old.key, site);
      projected[field] = old.text;
      changed ||= !equal(old.value, now.value);
    }
    if (!changed || typeof checked[0].read.header?.stageId !== 'string')
      return refuse('earlier retained window has no actual change/stage');
    facts.push({
      stage: {
        stageId: checked[0].read.header.stageId,
        ...(checked[0].read.header.runtimeStageId ? { runtimeStageId: checked[0].read.header.runtimeStageId } : {}),
        commit,
      },
      address: checked[0].get.address!,
      operation: pair.baseline.coordinate,
      baselineReturn: checked[0].read.result!,
      buildReturn: { kind: 'undefined' },
    });
  }
  // Compare every own field of each retained stage after projecting ONLY the proved read slots.
  for (const site of sites.values()) {
    if (site.kind === 'read-line') continue; // projectSite already required this exact one native delivery line.
    if (!equal(retainedStage(projected[site.field], site), retainedStage(b.kept[site.field], site)))
      return refuse('another retained slot or stage field differs beside the earlier read');
  }
  return { facts, pairs };
}
