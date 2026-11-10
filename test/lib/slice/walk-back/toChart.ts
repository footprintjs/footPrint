/**
 * Builds the REAL footprint chart for a program from `programs.ts`, runs it,
 * and walks back from a variable with foottrace's `causalChain`.
 *
 * Each block becomes stages with stable ids (`s0, s1, …`, the program's own):
 *   - a stage block → one `addFunction` stage running its statements in order;
 *   - a decider block → `addDeciderFunction` whose `decide()` carries ONE
 *     declared rule (`{ [g]: { gt: t } }` → the yes branch), default the no
 *     branch, each branch an `addFunctionBranch` running one statement.
 *
 * The walk back: start at `findLastWriter(commitLog, key)`, expand through each
 * stage's read keys (`keysReadFromExecutionTree`), plus control edges from a
 * `controlDepRecorder()` attached as a combined recorder.
 */
import { type CausalNode, causalChain, findLastWriter, flattenCausalDAG, keysReadFromExecutionTree } from 'foottrace';

import { decide, flowChart, FlowChartExecutor } from '../../../../src/index.js';
import { controlDepRecorder } from '../../../../src/trace.js';
import type { Program, Statement } from './programs.js';

type State = Record<string, number>;

/** Generous limits: the walk must never be cut short by a budget in these small programs (asserted below). */
const WALK_LIMITS = { maxDepth: 1_000, maxNodes: 10_000 };

function runStatement(s: State, statement: Statement): void {
  const e = statement.expr;
  switch (e.kind) {
    case 'const':
      s[statement.target] = e.c;
      return;
    case 'copy':
      s[statement.target] = s[e.u];
      return;
    case 'sum':
      s[statement.target] = s[e.u] + s[e.w];
      return;
    case 'cond':
      // An in-stage conditional: only the tested variable and the CHOSEN operand are read.
      if (s[e.g] > e.t) s[statement.target] = s[e.u];
      else s[statement.target] = s[e.w];
  }
}

/** The real chart for `program`. */
export function toChart(program: Program) {
  const [first, ...rest] = program.blocks;
  if (first?.kind !== 'stage') throw new Error('a program starts with a plain stage');
  const body = (statements: readonly Statement[]) => (s: State) => {
    for (const statement of statements) runStatement(s, statement);
  };
  // The builder's cursor type changes with every call; the loop only needs its fluent methods.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let builder: any = flowChart<State>(first.id, body(first.statements), first.id);
  for (const block of rest) {
    if (block.kind === 'stage') {
      builder = builder.addFunction(block.id, body(block.statements), block.id);
      continue;
    }
    builder = builder
      .addDeciderFunction(
        block.id,
        (s: State) =>
          decide(
            s,
            [{ when: { [block.g]: { gt: block.t } }, then: block.yes.id, label: `${block.g} > ${block.t}` }],
            block.no.id,
          ),
        block.id,
      )
      .addFunctionBranch(block.yes.id, block.yes.id, body([block.yes.statement]))
      .addFunctionBranch(block.no.id, block.no.id, body([block.no.statement]))
      .setDefault(block.no.id)
      .end();
  }
  return builder.build();
}

/** One edge of a walk back, by runtime stage id (run ids never appear in these). */
export interface WalkEdge {
  child: string;
  parent: string;
  kind: 'data' | 'control';
  key?: string;
}

export interface Walk {
  /** Stage ids in the walk back (BFS order, each once). */
  stages: string[];
  /** Every typed edge, in BFS order. */
  edges: WalkEdge[];
  /** True when a limit cut the walk (never expected here). */
  truncated: boolean;
}

export interface RunResult {
  /** Final state of the run. */
  state: State;
  /** The walk back from each key that has a writer in the commit log. */
  walks: Map<string, Walk>;
  /** Stage ids that ran, in execution order. */
  executed: string[];
}

function toWalk(root: CausalNode): Walk {
  const nodes = flattenCausalDAG(root);
  return {
    stages: nodes.map((n) => n.stageId),
    edges: nodes.flatMap((n) =>
      n.parentEdges.map((e) => ({
        child: n.runtimeStageId,
        parent: e.parent.runtimeStageId,
        kind: e.kind,
        ...(e.key !== undefined ? { key: e.key } : {}),
      })),
    ),
    truncated: root.truncated !== undefined,
  };
}

/** Runs the chart and walks back from every key in `keys`. */
export async function runAndWalk(program: Program, keys: Iterable<string>): Promise<RunResult> {
  const executor = new FlowChartExecutor(toChart(program));
  const control = controlDepRecorder();
  executor.attachCombinedRecorder(control);
  await executor.run();
  const snapshot = executor.getSnapshot();
  const reads = keysReadFromExecutionTree(snapshot.executionTree);
  const walks = new Map<string, Walk>();
  for (const key of keys) {
    const writer = findLastWriter(snapshot.commitLog, key);
    if (!writer) continue;
    const chain = causalChain(snapshot.commitLog, writer.runtimeStageId, reads.lookup, {
      controlDeps: control.asLookup(),
      ...WALK_LIMITS,
    });
    if (chain) walks.set(key, toWalk(chain));
  }
  return {
    state: { ...(snapshot.sharedState as State) },
    walks,
    executed: snapshot.commitLog.map((bundle) => bundle.stageId),
  };
}
