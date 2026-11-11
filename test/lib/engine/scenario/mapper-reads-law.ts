/**
 * The mount-reads law — the named record change the older byte references predate: what a subflow
 * MOUNT reads of its parent's state is recorded as reads of the mount stage. Two acts read:
 *
 *   - its `inputMapper` and `outputMapper` (`engine/handlers/mapperScope.ts`): each root key a mapper
 *     reads, in the order first read;
 *   - its merge-back (`engine/handlers/SubflowInputMapper.ts · applyOutputMapping`): for each key of
 *     the outputMapper's result, in order, the ROOT key it adds to — a plain object with at least one
 *     field (read before its fields are merged), or an array unless `arrayMerge: 'replace'` (read
 *     before the appended array is set). An empty object, a scalar or a replaced array reads nothing.
 *
 * Both go through `StageContext · readLiveRoot`, which records nothing for a key the parent's state
 * does not hold at that moment. Before, a mapper was handed the state object itself and the merge-back
 * read with `getGlobal`: neither left a trace. What the law moves in a run's record:
 *
 *   1. the mount's execution-tree node gains, in `stageReads`, each such root key at the place of its
 *      FIRST read. The mapper reads come first; each merge-back root read sits right before that
 *      key's own nested reads (`appendToArray` / `mergeObject` read `key.field` paths, as before the
 *      law), so law entries and older entries interleave. A key read twice keeps its first place and
 *      holds what its LAST read kept. Each entry is what the run's `readTracking` keeps of any read:
 *      a copy of the value under `'full'` (the default), a read summary marker under `'summary'`
 *      (`{ __readSummary: true, type, size?, preview? }`), the scope placeholder `'[REDACTED]'` for a
 *      key the redaction rule selects at that moment (a selected FIELD is the placeholder inside the
 *      copy), or `undefined` for a key holding `undefined`. Under `readTracking: 'off'` nothing is added;
 *   2. under `writeProvenance: 'reads-prefix'`, every row the mount writes lists in `readKeys` the
 *      law's keys read BEFORE that row was written, at their place in the read order (once each).
 *
 * A reference written by an older engine has neither, and it is never regenerated (it exists to be
 * old). So a byte pin takes the law's facts out of the build's bytes and compares every remaining
 * byte. Each fact is ASSERTED before it is taken out: the mount, each key, its exact place among the
 * node's reads, exactly what was kept, and (when the rows are named) every row's exact `readKeys`.
 * Anything else stays and is compared, including the older nested reads. What a read kept is written
 * out by hand from the scenario, or taken from the value the mount was seen to read: never from the
 * engine's own retention code.
 */

type Json = Record<string, any>;

/** The scope-tier placeholder a selected read is retained as. */
export const SCOPE_REDACTED = '[REDACTED]';

/** A read of the law: taken out once asserted. */
export interface MapperRead {
  readonly key: string;
  /** What the read leaves in `stageReads` (see the header, fact 1). Compared as JSON text. */
  readonly retained: unknown;
}

/** A read an older engine made too (a merge-back's `key.field`): its place is asserted, it stays and is compared. */
export interface KeptRead {
  readonly kept: string;
}

/** One entry of a mount node's `stageReads`, in the engine's order. */
export type MountRead = MapperRead | KeptRead;

const isKept = (read: MountRead): read is KeptRead => Object.hasOwn(read, 'kept');
const keyOf = (read: MountRead) => (isKept(read) ? read.kept : read.key);

/** What the run's redaction rule says of one key at the moment it is read. */
export interface KeyRule {
  /** The key is selected whole: the read keeps the placeholder. */
  readonly whole: boolean;
  /** Paths inside the key's value that are selected (`'y'`, `'inner.ssn'`): each keeps the placeholder. */
  readonly fields?: readonly string[];
}

/**
 * What a read of `value` keeps under `readTracking: 'full'` and `rule`: the placeholder for a selected
 * key, a copy with the placeholder at each selected field that is there, else the value. An oracle for
 * the shapes the generated programs hold (plain records, paths of own keys), written apart from the
 * engine's own scrub.
 */
export function retainedInFull(value: unknown, rule: KeyRule): unknown {
  if (value === undefined) return undefined;
  if (rule.whole) return SCOPE_REDACTED;
  if (!rule.fields?.length || value === null || typeof value !== 'object') return value;
  const copy = structuredClone(value) as Json;
  for (const path of rule.fields) {
    const names = path.split('.');
    const leaf = names.pop() as string;
    let holder: unknown = copy;
    for (const name of names)
      holder = holder !== null && typeof holder === 'object' ? (holder as Json)[name] : undefined;
    if (holder !== null && typeof holder === 'object' && Object.hasOwn(holder, leaf))
      (holder as Json)[leaf] = SCOPE_REDACTED;
  }
  return copy;
}

/** Exact text of what a read kept; `undefined` (an own key holding nothing) spelled out. */
const retainedText = (retained: unknown) => (retained === undefined ? '«undefined»' : JSON.stringify(retained));

/**
 * Take one mount execution's law reads out of its tree node, in place. `reads` are the node's LEADING
 * `stageReads` entries in the engine's order, through the last law read (older entries after it are
 * the byte comparison's): asserts the node is the mount, those keys are exactly the first keys of
 * `stageReads` in that order, and each law entry holds exactly what it kept. Law entries are removed,
 * kept ones stay. A `stageReads` left empty is removed: the engine writes none then.
 */
export function takeMapperReads(node: Json, runtimeStageId: string, reads: readonly MountRead[]): void {
  const where = `mapper-reads law at ${runtimeStageId}`;
  if (node?.runtimeStageId !== runtimeStageId) throw new Error(`${where}: the node is ${node?.runtimeStageId}`);
  if (!reads.some((read) => !isKept(read))) return;
  const stageReads = node.stageReads as Json | undefined;
  if (stageReads === undefined) throw new Error(`${where}: the node has no stageReads`);
  const leading = Object.keys(stageReads).slice(0, reads.length);
  const expected = reads.map(keyOf);
  if (leading.join('\u0000') !== expected.join('\u0000')) {
    throw new Error(`${where}: stageReads starts [${leading}], the law reads [${expected}]`);
  }
  for (const read of reads) {
    if (isKept(read)) continue;
    const { key, retained } = read;
    if (retainedText(stageReads[key]) !== retainedText(retained)) {
      throw new Error(`${where}: ${key} is ${retainedText(stageReads[key])}, expected ${retainedText(retained)}`);
    }
    delete stageReads[key];
  }
  if (Object.keys(stageReads).length === 0) delete node.stageReads;
}

/**
 * Take the law's keys out of the `readKeys` of every row of the mount's bundles in `log`, in place.
 *
 * With `rows` (the exact `readKeys` of each of the mount's rows, in log order): asserts the mount has
 * exactly that many rows and each row's `readKeys` is exactly its entry, then removes `keys` from it.
 * Needed whenever a merge-back read is in `keys`, because a row then holds only the law keys read
 * before it was written. Without `rows` (mapper reads only, all made before the mount writes anything):
 * asserts each row STARTS with exactly `keys` and removes that prefix.
 */
export function takeMapperReadKeys(
  log: Json[],
  runtimeStageId: string,
  keys: readonly string[],
  rows?: readonly (readonly string[])[],
): void {
  const where = `mapper-reads law at ${runtimeStageId}`;
  const law = new Set(keys);
  let count = 0;
  for (const bundle of log) {
    if (bundle.runtimeStageId !== runtimeStageId) continue;
    for (const row of bundle.trace ?? []) {
      const readKeys = row.readKeys as unknown;
      if (!Array.isArray(readKeys)) throw new Error(`${where}: row ${row.path} has no readKeys`);
      if (rows === undefined) {
        const leading = readKeys.slice(0, keys.length);
        if (leading.join('\u0000') !== keys.join('\u0000')) {
          throw new Error(`${where}: row ${row.path} readKeys start [${leading}], expected [${keys}]`);
        }
        readKeys.splice(0, keys.length);
      } else {
        const expected = rows[count];
        if (expected === undefined || readKeys.join('\u0000') !== expected.join('\u0000')) {
          throw new Error(`${where}: row ${count} (${row.path}) readKeys are [${readKeys}], expected [${expected}]`);
        }
        row.readKeys = readKeys.filter((key: string) => !law.has(key));
      }
      count += 1;
    }
  }
  if (count === 0) throw new Error(`${where}: the log has no row of the mount`);
  if (rows !== undefined && count !== rows.length) {
    throw new Error(`${where}: the mount has ${count} row(s), ${rows.length} named`);
  }
}

/** One mount execution in a fixture: where its node (and, under reads-prefix, its log) sits, and what it read. */
export interface MountReads {
  /** Keys from the record's root to the mount's tree node. */
  readonly node: readonly (string | number)[];
  readonly runtimeStageId: string;
  /** The node's leading `stageReads` entries, in order, through its last law read (see `takeMapperReads`). */
  readonly reads: readonly MountRead[];
  /** Keys from the record's root to the commit log holding the mount's rows — only under reads-prefix. */
  readonly log?: readonly (string | number)[];
  /** Each mount row's exact `readKeys`, in log order — required under reads-prefix when the merge-back reads. */
  readonly rows?: readonly (readonly string[])[];
}

const at = (parsed: unknown, path: readonly (string | number)[]): any =>
  path.reduce((node: any, key) => node?.[key], parsed);

/** The law's keys of a mount: its reads that are not kept ones. */
const lawKeys = (reads: readonly MountRead[]) => reads.filter((read) => !isKept(read)).map(keyOf);

/** Take every named mount's law reads out of a parsed record, in place. */
export function withoutMapperReads(parsed: unknown, mounts: readonly MountReads[]): void {
  for (const mount of mounts) {
    takeMapperReads(at(parsed, mount.node), mount.runtimeStageId, mount.reads);
    if (mount.log !== undefined) {
      takeMapperReadKeys(at(parsed, mount.log), mount.runtimeStageId, lawKeys(mount.reads), mount.rows);
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
 * A tree without its mount executions' law reads: `executions[i]` is the i-th execution of `mountId`'s
 * reads (execution order), as `takeMapperReads` takes them. Asserts the tree has exactly that many
 * executions. Returns a copy.
 */
export function treeWithoutMapperReads(tree: unknown, mountId: string, executions: readonly MountRead[][]): unknown {
  const out = structuredClone(tree);
  const nodes = mountNodes(out, mountId);
  if (nodes.length !== executions.length) {
    throw new Error(`mapper-reads law: the tree has ${nodes.length} ${mountId} node(s), ${executions.length} ran`);
  }
  nodes.forEach((node, i) => takeMapperReads(node, node.runtimeStageId, executions[i] ?? []));
  return out;
}
