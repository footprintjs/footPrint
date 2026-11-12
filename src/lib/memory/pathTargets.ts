/**
 * pathTargets.ts — the field paths still to reach below a node of a served record, and what they say
 * about each key of that node.
 *
 * WHY THIS FILE EXISTS. The walk that serves a record under a redaction rule (`redaction.ts`, "the
 * path walk") carries, for each node, the fields still to reach below it: its TARGETS. For each key
 * of the node it asks which targets start at that key: is the value masked here, and which targets
 * go on below it. That was a scan of every target for every key, so a record with N keys and N
 * targets cost N × N.
 *
 * A policy seldom declares many fields for one key. But a key takes one field for each hidden object
 * a stage puts below it (`redaction.ts · inheritByIdentity`), so the number of targets comes from
 * data. Measured with `bench/hidden-object-scaling.ts` (the `declared` shape, 12 Nov 2026): a record
 * with 8,000 hidden fields took 348 ms to copy under its policy, and four times the fields took
 * fourteen times as long. Here a long list of targets is grouped by its first key ONCE for the node,
 * and each key is one lookup: keys + targets. The same record takes 50 ms.
 *
 * WHY A SHORT LIST IS STILL SCANNED. Almost every node of every served record has no target, or a
 * few. Grouping builds a map for each node; a scan of three targets is cheaper than that.
 *
 * No outside source. A leaf: it imports nothing.
 */

/** A field still to reach below a node: the path segments left to walk. */
export type Target = readonly string[];

/** What the targets of a node say about one of its keys. */
export interface Step {
  /** A target ends at this key: the value under it is masked here. */
  readonly masked: boolean;
  /** The targets that go on below this key, each without the key. */
  readonly below: readonly Target[];
}

/** From this many targets on, a node groups them by first key before its keys are asked. */
export const MANY_TARGETS = 16;

const NO_TARGETS: readonly Target[] = Object.freeze([]);
/** The step of a key no target starts at. Shared and frozen: nobody may add to it. */
const NO_STEP: Step = Object.freeze({ masked: false, below: NO_TARGETS });
const noSteps = (): Step => NO_STEP;

/** Each field path as one literal key and, when dotted, as its segments. */
export function targetsOf(paths: readonly string[] | undefined): Target[] {
  const out: Target[] = [];
  for (const path of paths ?? []) {
    out.push([path]);
    if (path.includes('.')) out.push(path.split('.'));
  }
  return out;
}

/** The memo key of a target state — order-free. */
export function signatureOf(targets: readonly Target[]): string {
  return targets.length === 0
    ? ''
    : targets
        .map((t) => t.join('\u001f'))
        .sort()
        .join('\u001e');
}

/**
 * The targets of ONE node, ready to be asked key by key. Ask it once for each key of the node.
 *
 * ```ts
 * const steps = stepsOf([['card', 'number'], ['pin']]);
 * steps('card'); // { masked: false, below: [['number']] }
 * steps('pin');  // { masked: true, below: [] }
 * steps('name'); // { masked: false, below: [] }
 * ```
 */
export function stepsOf(targets: readonly Target[]): (key: string) => Step {
  if (targets.length === 0) return noSteps;
  if (targets.length < MANY_TARGETS) return (key) => scan(targets, key);
  const byKey = new Map<string, { masked: boolean; below: Target[] }>();
  for (const target of targets) {
    let step = byKey.get(target[0]);
    if (step === undefined) byKey.set(target[0], (step = { masked: false, below: [] }));
    if (target.length === 1) step.masked = true;
    else step.below.push(target.slice(1));
  }
  return (key) => byKey.get(key) ?? NO_STEP;
}

/** The step of `key` by reading every target: for a short list. */
function scan(targets: readonly Target[], key: string): Step {
  const below: Target[] = [];
  let masked = false;
  for (const target of targets) {
    if (target[0] !== key) continue;
    if (target.length === 1) masked = true;
    else below.push(target.slice(1));
  }
  return { masked, below };
}
