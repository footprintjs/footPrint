import { isDeniedSegment, pathSegments } from 'foottrace/paths';

import type { StageNode } from './StageNode.js';

type Role = 'stage' | 'mount' | 'loop-reference' | 'join';
type ControlKind = 'decider' | 'selector';
type ProjectionGap = 'graph-ambiguous' | 'truncated';

interface Choice {
  readonly entry: string;
  readonly name: string;
  readonly fallback?: true;
  readonly loopBack?: { readonly body: string; readonly exit: string; readonly owner: string };
}

/** The version-1 Foottrace chart description. No stage function is carried. */
export interface SkippedChartProjection {
  readonly stages: readonly {
    readonly id: string;
    readonly stageId: string;
    readonly role: Role;
    readonly edges: readonly string[];
    readonly writes?: readonly string[];
  }[];
  readonly controls: readonly {
    readonly placementId: string;
    readonly kind: ControlKind;
    readonly choices: readonly Choice[];
    readonly continuation: string | null;
  }[];
}

export interface SkippedProjectionOptions {
  /** Exhaustive paths for this exact placement, with undefined indicating no declaration. */
  readonly writesOf?: (placement: StageNode) => readonly string[] | undefined;
  /** Resolve a stage's function from the same stage map as the traverser, without invoking it. */
  readonly hasStageFunction?: (placement: StageNode) => boolean;
  readonly work?: number;
}

interface Placement {
  readonly id: string;
  readonly stageId: string;
  readonly name: string;
  readonly dispatchId: string;
  readonly role: Role;
  readonly control?: ControlKind;
  readonly outputSelector: boolean;
  readonly hasFunction: boolean;
  readonly children: readonly StageNode[];
  readonly next?: StageNode;
  readonly writes?: readonly string[];
}

const DEFAULT_WORK = 100_000;
const ID_LENGTH = 1024;

class ProjectionRefusal extends Error {
  constructor(readonly reason: ProjectionGap = 'graph-ambiguous') {
    super(reason);
  }
}

function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor ? !Object.hasOwn(descriptor, 'value') : Reflect.has(value, key)) throw new ProjectionRefusal();
  return descriptor?.value;
}

function plainNode(value: unknown): StageNode {
  if (value === null || typeof value !== 'object') throw new ProjectionRefusal();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ProjectionRefusal();
  return value as StageNode;
}

function identifier(value: unknown, path = false): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > ID_LENGTH) throw new ProjectionRefusal();
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= (path ? 30 : 31) || (code >= 127 && code <= 159)) throw new ProjectionRefusal();
  }
  return value;
}

function enabled(node: StageNode, name: string): boolean {
  const value = own(node, name);
  if (value === undefined || value === false) return false;
  if (value !== true) throw new ProjectionRefusal();
  return true;
}

type Spend = (units?: number) => void;

function list<T>(value: unknown, spend: Spend, read: (item: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new ProjectionRefusal();
  const length = own(value, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) throw new ProjectionRefusal();
  spend(length);
  const items: T[] = [];
  for (let index = 0; index < length; index++) items.push(read(own(value, String(index))));
  return items;
}

/** Capture each graph slot once. Only the enclosing scope's next pointer is relevant on a mount. */
function placement(value: StageNode, order: number, spend: Spend, options: SkippedProjectionOptions): Placement {
  spend();
  const stageId = identifier(own(value, 'id'));
  const dispatchId = identifier(own(value, 'branchId') ?? stageId);
  const id = identifier(`${order}:${dispatchId}`);
  const name = own(value, 'name');
  if (typeof name !== 'string' || name.length > 4096) throw new ProjectionRefusal();
  const ref = enabled(value, 'isLoopRef');
  const mount = enabled(value, 'isSubflowRoot');
  const decider = enabled(value, 'deciderFn');
  const selector = enabled(value, 'selectorFn');
  const outputSelector = own(value, 'nextNodeSelector');
  if (
    enabled(value, 'isDynamicParallel') ||
    own(value, 'parallelForEach') !== undefined ||
    (outputSelector !== undefined && typeof outputSelector !== 'function') ||
    Number(decider) + Number(selector) + Number(outputSelector !== undefined) > 1 ||
    ((mount || ref) && (decider || selector || outputSelector !== undefined)) ||
    (mount && ref)
  ) {
    throw new ProjectionRefusal();
  }
  const fn = own(value, 'fn');
  if (fn !== undefined && typeof fn !== 'function') throw new ProjectionRefusal();
  const control = decider ? 'decider' : selector || outputSelector !== undefined ? 'selector' : undefined;
  const rawChildren = mount ? undefined : own(value, 'children');
  const children = rawChildren === undefined ? [] : list(rawChildren, spend, plainNode);
  const rawNext = own(value, 'next');
  if (rawNext !== undefined) spend();
  const next = rawNext === undefined ? undefined : plainNode(rawNext);
  const rawWrites = mount || ref ? undefined : options.writesOf?.(value);
  if ((ref && (children.length || next || fn)) || (control && !children.length)) throw new ProjectionRefusal();
  const writes =
    rawWrites === undefined
      ? undefined
      : list(rawWrites, spend, (raw) => {
          const path = identifier(raw, true);
          if (pathSegments(path).some(isDeniedSegment)) throw new ProjectionRefusal();
          return path;
        });
  return {
    id,
    stageId,
    name,
    dispatchId,
    role: ref ? 'loop-reference' : mount ? 'mount' : 'stage',
    control,
    outputSelector: outputSelector !== undefined,
    hasFunction: fn !== undefined || options.hasStageFunction?.(value) === true,
    children,
    next,
    writes,
  };
}

function capture(root: StageNode, spend: Spend, options: SkippedProjectionOptions): Map<StageNode, Placement> {
  const seen = new Map<StageNode, Placement>();
  const active = new Set<StageNode>();
  const pending: { readonly node: StageNode; readonly leave?: true }[] = [{ node: plainNode(root) }];
  for (let frame = pending.pop(); frame; frame = pending.pop()) {
    const { node, leave } = frame;
    if (leave) {
      active.delete(node);
      continue;
    }
    if (active.has(node)) throw new ProjectionRefusal();
    if (seen.has(node)) continue;
    const row = placement(node, seen.size, spend, options);
    seen.set(node, row);
    active.add(node);
    pending.push({ node, leave: true });
    if (row.next) pending.push({ node: row.next });
    for (let index = row.children.length - 1; index >= 0; index--) pending.push({ node: row.children[index] });
  }
  return seen;
}

function resolveLoops(rows: Iterable<Placement>, spend: Spend): Map<Placement, Placement> {
  const concrete = new Map<string, Placement | undefined>();
  const references: Placement[] = [];
  for (const row of rows) {
    spend();
    if (row.role === 'loop-reference') references.push(row);
    else concrete.set(row.stageId, concrete.has(row.stageId) ? undefined : row);
  }
  const targets = new Map<Placement, Placement>();
  for (const ref of references) {
    spend();
    const target = concrete.get(ref.stageId);
    if (!target) throw new ProjectionRefusal();
    targets.set(ref, target);
  }
  return targets;
}

/** Restrict loop ownership to a single linear path to a terminal back-edge. */
function branchEnd(
  entry: Placement,
  continuation: Placement | undefined,
  rows: ReadonlyMap<StageNode, Placement>,
  spend: Spend,
): Placement | 'exit' | 'ambiguous' {
  let row: Placement | undefined = entry;
  let crossedMount = false;
  while (row) {
    spend();
    if (row === continuation) return 'exit';
    if (row.role === 'loop-reference') return crossedMount ? 'ambiguous' : row;
    if (row.control || row.children.length) return 'ambiguous';
    crossedMount ||= row.role === 'mount';
    if (!row.next) return 'exit';
    spend();
    row = rows.get(row.next);
  }
  return 'ambiguous';
}

function returnsToOwner(
  body: Placement,
  owner: Placement,
  continuation: Placement | undefined,
  rows: ReadonlyMap<StageNode, Placement>,
  spend: Spend,
): boolean {
  let row: Placement | undefined = body;
  while (row) {
    spend();
    if (row === owner) return true;
    if (row === continuation || row.role !== 'stage' || row.control || row.children.length || !row.next) return false;
    spend();
    row = rows.get(row.next);
  }
  return false;
}

type ProjectedControl = SkippedChartProjection['controls'][number];

function placed(rows: ReadonlyMap<StageNode, Placement>, node: StageNode): Placement {
  const row = rows.get(node);
  if (!row) throw new ProjectionRefusal();
  return row;
}

/** A branch cannot exclusively govern a placement that is also reached by another branch. */
function refuseImplicitJoin(
  entries: readonly Placement[],
  continuation: Placement | undefined,
  rows: ReadonlyMap<StageNode, Placement>,
  spend: Spend,
): void {
  const held = new Map<Placement, Placement>();
  for (const entry of entries) {
    const pending = [entry];
    for (let row = pending.pop(); row; row = pending.pop()) {
      spend();
      if (row === continuation || row.role === 'loop-reference') continue;
      const prior = held.get(row);
      if (prior === entry) continue;
      if (prior) throw new ProjectionRefusal();
      held.set(row, entry);
      for (const child of row.children) {
        spend();
        pending.push(placed(rows, child));
      }
      if (row.next) {
        spend();
        pending.push(placed(rows, row.next));
      }
    }
  }
}

function projectControl(
  row: Placement,
  kind: ControlKind,
  rows: ReadonlyMap<StageNode, Placement>,
  targets: ReadonlyMap<Placement, Placement>,
  claimed: Set<Placement>,
  spend: Spend,
): ProjectedControl {
  const continuation = row.next && rows.get(row.next);
  if (continuation?.role === 'loop-reference') throw new ProjectionRefusal();
  // A decider also treats an unbacked, functionless next as a runtime lookup. The graph alone cannot prove it.
  if (
    kind === 'decider' &&
    continuation?.role === 'stage' &&
    !continuation.hasFunction &&
    !continuation.children.length &&
    !continuation.control
  )
    throw new ProjectionRefusal();
  const dispatchIds = new Set<string>();
  const children = row.children.map((child) => {
    spend();
    const target = placed(rows, child);
    const key = row.outputSelector ? target.stageId : target.dispatchId;
    if (target.role === 'loop-reference' || dispatchIds.has(key)) throw new ProjectionRefusal();
    dispatchIds.add(key);
    return target;
  });
  refuseImplicitJoin(children, continuation, rows, spend);
  const ends = targets.size ? children.map((child) => branchEnd(child, continuation, rows, spend)) : [];
  spend(ends.length);
  const hasLoop = ends.some((end) => typeof end === 'object');
  let exit: Placement | undefined;
  if (hasLoop) {
    if (kind !== 'decider') throw new ProjectionRefusal();
    for (let index = 0; index < ends.length; index++) {
      spend();
      if (ends[index] === 'ambiguous') throw new ProjectionRefusal();
      if (ends[index] === 'exit') {
        if (exit) throw new ProjectionRefusal();
        exit = children[index];
      }
    }
    if (!exit) throw new ProjectionRefusal();
  }
  return Object.freeze({
    placementId: row.id,
    kind,
    continuation: continuation?.id ?? null,
    choices: Object.freeze(
      children.map((child, index) => {
        spend();
        const end = ends[index];
        let loopBack: Choice['loopBack'];
        if (typeof end === 'object') {
          const body = targets.get(end);
          if (!body || !exit || claimed.has(end) || !returnsToOwner(body, row, continuation, rows, spend))
            throw new ProjectionRefusal();
          claimed.add(end);
          loopBack = Object.freeze({ body: body.id, exit: exit.id, owner: row.id });
        }
        return Object.freeze({
          entry: child.id,
          name: child.name,
          ...(kind === 'decider' && child.dispatchId === 'default' && { fallback: true as const }),
          ...(loopBack && { loopBack }),
        });
      }),
    ),
  });
}

/** Project only the static scope. A producer must separately verify it against the traversed run. */
export function projectSkippedChart(
  root: StageNode,
  options: SkippedProjectionOptions = {},
):
  | { readonly status: 'ready'; readonly graph: SkippedChartProjection }
  | { readonly status: 'unknown'; readonly reason: ProjectionGap } {
  let work = options.work ?? DEFAULT_WORK;
  if (!Number.isSafeInteger(work) || work < 0 || work > DEFAULT_WORK)
    return { status: 'unknown', reason: 'graph-ambiguous' };
  const spend: Spend = (units = 1) => {
    work -= units;
    if (work < 0) throw new ProjectionRefusal('truncated');
  };
  try {
    const rows = capture(root, spend, options);
    const targets = resolveLoops(rows.values(), spend);
    const claimed = new Set<Placement>();
    const stages: SkippedChartProjection['stages'][number][] = [];
    const controls: ProjectedControl[] = [];
    for (const row of rows.values()) {
      spend();
      const edges = row.children.map((child) => {
        spend();
        return placed(rows, child).id;
      });
      const target = row.next ? placed(rows, row.next) : targets.get(row);
      if (target) {
        spend();
        edges.push(target.id);
      }
      stages.push(
        Object.freeze({
          id: row.id,
          stageId: row.stageId,
          role: row.role,
          edges: Object.freeze(edges),
          ...(row.writes !== undefined && { writes: Object.freeze(row.writes) }),
        }),
      );
      if (row.control) controls.push(projectControl(row, row.control, rows, targets, claimed, spend));
    }
    if (claimed.size !== targets.size) throw new ProjectionRefusal();
    return {
      status: 'ready',
      graph: Object.freeze({ stages: Object.freeze(stages), controls: Object.freeze(controls) }),
    };
  } catch (error) {
    return { status: 'unknown', reason: error instanceof ProjectionRefusal ? error.reason : 'graph-ambiguous' };
  }
}
