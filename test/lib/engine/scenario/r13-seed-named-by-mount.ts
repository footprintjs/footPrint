/**
 * R13 — the one named change a pre-R13 byte reference shows: a subflow's seed bundle
 * (`treeContext.history[0]`, committed before any of the subflow's stages ran) is the MOUNT's
 * commit, so it carries the mount's `stage`, `stageId` and `runtimeStageId`. Through 9.33.0 it
 * carried the subflow's first stage's names and runtimeStageId `''`.
 *
 * The frozen references stay the bytes the OLD tree produced; a test applies this edit to them,
 * naming each seed it moves, and compares the run against the result byte for byte. Each named
 * seed must still be in the old shape (`runtimeStageId: ''`), so the edit can only ever be R13's.
 */

export interface SeedNamedByMount {
  /** Keys from the reference's root to one seed bundle (e.g. `['subflowResults', 'sf#2', 'treeContext', 'history', 0]`). */
  readonly at: readonly (string | number)[];
  readonly stage: string;
  readonly stageId: string;
  readonly runtimeStageId: string;
}

/** Apply the R13 edit to a parsed reference, in place. Refuses a seed not in the pre-R13 shape. */
export function nameSeedsByMount(parsed: unknown, seeds: readonly SeedNamedByMount[]): void {
  for (const seed of seeds) {
    const bundle = seed.at.reduce((node: any, key) => node?.[key], parsed);
    if (!bundle || bundle.runtimeStageId !== '') {
      throw new Error(`nameSeedsByMount: no pre-R13 seed at ${seed.at.join('.')}`);
    }
    bundle.stage = seed.stage;
    bundle.stageId = seed.stageId;
    bundle.runtimeStageId = seed.runtimeStageId;
  }
}

/** The same edit on a reference FILE's text, re-serialised the way the fixture writes it. */
export function withSeedsNamedByMount(reference: string, seeds: readonly SeedNamedByMount[], space = 2): string {
  const parsed = JSON.parse(reference);
  // Without an edit the re-serialised text IS the reference — so the only bytes this can move are
  // the named seeds'.
  if (JSON.stringify(parsed, null, space) !== reference) {
    throw new Error('withSeedsNamedByMount: the reference does not round-trip');
  }
  nameSeedsByMount(parsed, seeds);
  return JSON.stringify(parsed, null, space);
}

/** One seed per key a subflow result is stored under — its path and the mount's runtimeStageId (dual keying). */
export function bothKeys(prefix: readonly string[], subflowId: string, mount: Omit<SeedNamedByMount, 'at'>) {
  const seedOf = (key: string) => [...prefix, 'subflowResults', key, 'treeContext', 'history', 0];
  return [
    { at: seedOf(subflowId), ...mount },
    { at: seedOf(mount.runtimeStageId), ...mount },
  ];
}
