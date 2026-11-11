/**
 * The mapper-reads law — the named record change the older byte references predate: a subflow's
 * `inputMapper` and `outputMapper` read the parent's state, and those reads are now recorded as
 * reads of the MOUNT stage (`engine/handlers/mapperScope.ts`, `StageContext · readForMapper`).
 * Before, a mapper was handed the state object itself and its reads left no trace.
 *
 * It moves exactly two things in what a run records:
 *
 *   1. the mount's execution-tree node gains, in `stageReads`, each root key its mappers read, in
 *      the order they were first read, AHEAD of any read the merge-back makes. Each entry is a read
 *      summary marker (`{ __readSummary: true, type, size?, preview? }`), the scope placeholder
 *      `'[REDACTED]'` for a key the redaction rule selects, or `undefined` for a key holding
 *      `undefined`. Never a copy of the value. Under `readTracking: 'off'` nothing is added;
 *   2. under `writeProvenance: 'reads-prefix'`, every row of the mount's bundles starts its
 *      `readKeys` with those keys, in the order they were read.
 *
 * A reference written by an older engine has neither, and it is never regenerated (it exists to be
 * old). So a byte pin takes the law's facts out of the build's bytes and compares every remaining
 * byte. Each fact is ASSERTED before it is taken out: the mount, each key, the exact marker, the
 * exact `readKeys` prefix. Anything else in the node stays and is compared, including reads the
 * merge-back made before this law (`appendToArray` / `mergeObject` read `key.field` paths).
 * The markers are written out by hand (`summary`) or computed by `readSummary`, an oracle
 * independent of the engine's own summarizer.
 */

type Json = Record<string, any>;

/** The scope-tier placeholder a selected read is retained as. */
export const SCOPE_REDACTED = '[REDACTED]';

/** What one mapper read leaves in `stageReads`. */
export type MapperReadMarker = Json | typeof SCOPE_REDACTED | undefined;

export interface MapperRead {
  readonly key: string;
  readonly marker: MapperReadMarker;
}

/** A read summary marker, keys in the order the engine writes them. */
export function summary(type: string, size?: number, preview?: string): Json {
  return {
    __readSummary: true,
    type,
    ...(size === undefined ? {} : { size }),
    ...(preview === undefined ? {} : { preview }),
  };
}

/** The marker a read of `value` leaves: an oracle for the value kinds the generated programs hold. */
export function readSummary(value: unknown): Json {
  if (value === null) return summary('null');
  if (typeof value === 'string') return summary('string', value.length, value.slice(0, 80));
  if (Array.isArray(value)) return summary('array', value.length);
  if (typeof value === 'object') return summary('object', Object.keys(value).length);
  if (typeof value === 'number' || typeof value === 'boolean') return summary(typeof value, undefined, String(value));
  throw new Error(`mapper-reads law: no oracle for a ${typeof value} value`);
}

/** Exact text of a marker; `undefined` (an own key holding nothing) spelled out. */
const markerText = (marker: unknown) => (marker === undefined ? '«undefined»' : JSON.stringify(marker));

/**
 * Take one mount execution's mapper reads out of its tree node, in place. Asserts the node is the
 * mount, its first `reads.length` `stageReads` keys are exactly the mapper's keys in read order, and
 * each holds exactly its marker. A `stageReads` left empty is removed: the engine writes none then.
 */
export function takeMapperReads(node: Json, runtimeStageId: string, reads: readonly MapperRead[]): void {
  const where = `mapper-reads law at ${runtimeStageId}`;
  if (node?.runtimeStageId !== runtimeStageId) throw new Error(`${where}: the node is ${node?.runtimeStageId}`);
  if (reads.length === 0) return;
  const stageReads = node.stageReads as Json | undefined;
  if (stageReads === undefined) throw new Error(`${where}: the node has no stageReads`);
  const leading = Object.keys(stageReads).slice(0, reads.length);
  const expected = reads.map((read) => read.key);
  if (leading.join('\u0000') !== expected.join('\u0000')) {
    throw new Error(`${where}: stageReads starts [${leading}], the mappers read [${expected}]`);
  }
  for (const { key, marker } of reads) {
    if (markerText(stageReads[key]) !== markerText(marker)) {
      throw new Error(`${where}: ${key} is ${markerText(stageReads[key])}, expected ${markerText(marker)}`);
    }
    delete stageReads[key];
  }
  if (Object.keys(stageReads).length === 0) delete node.stageReads;
}

/**
 * Take the mapper's keys out of the `readKeys` of every row of the mount's bundles in `log`, in place.
 * Asserts each such row starts with exactly `keys`, and that the mount has at least one row.
 */
export function takeMapperReadKeys(log: Json[], runtimeStageId: string, keys: readonly string[]): void {
  const where = `mapper-reads law at ${runtimeStageId}`;
  let rows = 0;
  for (const bundle of log) {
    if (bundle.runtimeStageId !== runtimeStageId) continue;
    for (const row of bundle.trace ?? []) {
      rows += 1;
      const readKeys = row.readKeys as unknown;
      if (!Array.isArray(readKeys)) throw new Error(`${where}: row ${row.path} has no readKeys`);
      const leading = readKeys.slice(0, keys.length);
      if (leading.join('\u0000') !== keys.join('\u0000')) {
        throw new Error(`${where}: row ${row.path} readKeys start [${leading}], expected [${keys}]`);
      }
      readKeys.splice(0, keys.length);
    }
  }
  if (rows === 0) throw new Error(`${where}: the log has no row of the mount`);
}

/** One mount execution in a fixture: where its node (and, under reads-prefix, its log) sits, and what it read. */
export interface MountReads {
  /** Keys from the record's root to the mount's tree node. */
  readonly node: readonly (string | number)[];
  readonly runtimeStageId: string;
  readonly reads: readonly MapperRead[];
  /** Keys from the record's root to the commit log holding the mount's rows — only under reads-prefix. */
  readonly log?: readonly (string | number)[];
}

const at = (parsed: unknown, path: readonly (string | number)[]): any =>
  path.reduce((node: any, key) => node?.[key], parsed);

/** Take every named mount's mapper reads out of a parsed record, in place. */
export function withoutMapperReads(parsed: unknown, mounts: readonly MountReads[]): void {
  for (const mount of mounts) {
    takeMapperReads(at(parsed, mount.node), mount.runtimeStageId, mount.reads);
    if (mount.log !== undefined) {
      takeMapperReadKeys(
        at(parsed, mount.log),
        mount.runtimeStageId,
        mount.reads.map((read) => read.key),
      );
    }
  }
}

/** The same on a record's JSON text, re-serialised in the same layout. */
export function withoutMapperReadsText(json: string, mounts: readonly MountReads[]): string {
  const space = json.includes('\n') ? 2 : undefined;
  const parsed = JSON.parse(json);
  // Without an edit the re-serialised text IS the input — so the only bytes this can move are the law's.
  if (JSON.stringify(parsed, null, space) !== json) {
    throw new Error('withoutMapperReadsText: the text does not round-trip');
  }
  withoutMapperReads(parsed, mounts);
  return JSON.stringify(parsed, null, space);
}

/** The nodes of `tree` whose id is `mountId`, in execution order (the index after `#`). */
export function mountNodes(tree: unknown, mountId: string): Json[] {
  const found: Json[] = [];
  const stack: unknown[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop() as Json | undefined;
    if (node === null || typeof node !== 'object') continue;
    if (node.id === mountId) found.push(node);
    stack.push(node.next, ...((node.children as unknown[]) ?? []));
  }
  const index = (node: Json) => Number(String(node.runtimeStageId).slice(String(node.runtimeStageId).indexOf('#') + 1));
  return found.sort((x, y) => index(x) - index(y));
}

/**
 * A tree without its mount executions' mapper reads: `executions[i]` is what the i-th execution of
 * `mountId` read (execution order). Asserts the tree has exactly that many executions. Returns a copy.
 */
export function treeWithoutMapperReads(tree: unknown, mountId: string, executions: readonly MapperRead[][]): unknown {
  const out = structuredClone(tree);
  const nodes = mountNodes(out, mountId);
  if (nodes.length !== executions.length) {
    throw new Error(`mapper-reads law: the tree has ${nodes.length} ${mountId} node(s), ${executions.length} ran`);
  }
  nodes.forEach((node, i) => takeMapperReads(node, node.runtimeStageId, executions[i] ?? []));
  return out;
}
