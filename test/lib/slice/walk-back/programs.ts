/**
 * A tiny program model and an INDEPENDENT judge for the walk-back property.
 *
 * This file must never import footprintjs or foottrace: the judge is the
 * oracle the library's record is checked against, so it shares no code with it.
 *
 * Model
 *   - Variables are scope keys `v0..vN` holding numbers.
 *   - A statement writes one variable from one expression:
 *       const  `v = c`
 *       copy   `v = u`
 *       sum    `v = u + w`
 *       cond   `if (g > t) v = u; else v = w`   (an in-stage conditional)
 *     It reads only variables an earlier statement has written.
 *   - A program is a list of blocks run in order:
 *       stage    — consecutive statements, run as ONE chart stage;
 *       decider  — a `decide()` on one variable (`g > t`) choosing between two
 *                  branch stages that each run one statement. Both branches
 *                  write the same variable, so it is defined after the diamond
 *                  whichever branch ran.
 *
 * Judge
 *   `judge(program)` interprets the program and returns, for every written
 *   variable, the TRUE CAUSE set: every stage holding a statement on a dynamic
 *   dependence path to the variable's final value — data dependence, control
 *   dependence on an in-stage conditional's tested variable, and control
 *   dependence on a decider (the decider stage itself plus what its tested
 *   variable depends on) for the statement of the branch it chose.
 *
 * Generator
 *   `generateProgram(seed, shape)` draws a program from a seeded PRNG while
 *   interpreting it, and REDRAWS any statement whose value equals what its
 *   variable already holds, or what it held when its stage began. A stage that
 *   writes the value a key already holds leaves no commit row — a KNOWN GAP of
 *   the record, pinned separately; the generator excludes it by construction
 *   (guard: `NO_OP_WRITE_GUARD`).
 */

export type Var = string;

export type Expr =
  | { kind: 'const'; c: number }
  | { kind: 'copy'; u: Var }
  | { kind: 'sum'; u: Var; w: Var }
  | { kind: 'cond'; g: Var; t: number; u: Var; w: Var };

export interface Statement {
  target: Var;
  expr: Expr;
}

export interface StageBlock {
  kind: 'stage';
  id: string;
  statements: Statement[];
}

export interface DeciderBlock {
  kind: 'decider';
  id: string;
  /** The decider tests `g > t`: true chooses `yes`, otherwise `no` (the default). */
  g: Var;
  t: number;
  yes: { id: string; statement: Statement };
  no: { id: string; statement: Statement };
}

export type Block = StageBlock | DeciderBlock;

export interface Program {
  blocks: Block[];
}

/** Shape of a generated program. */
export interface ProgramShape {
  /** Number of variables `v0..v{vars-1}`. */
  vars: number;
  /** Statements outside decider branches. */
  statements: number;
  /** Statements per plain stage: a fixed size, or `'random'` for random cut points. */
  perStage: number | 'random';
  /** Maximum decider diamonds (0–2); each is placed at a random cut point. */
  maxDeciders: number;
}

// ─── Evaluation (shared by the judge and the generator; pure, no library) ───

export type Values = ReadonlyMap<Var, number>;

/** The variables an expression reads when evaluated against `values` (cond reads `g` and the chosen operand only). */
export function readsOf(expr: Expr, values: Values): Var[] {
  switch (expr.kind) {
    case 'const':
      return [];
    case 'copy':
      return [expr.u];
    case 'sum':
      return [expr.u, expr.w];
    case 'cond':
      return [expr.g, valueOf(values, expr.g) > expr.t ? expr.u : expr.w];
  }
}

export function evaluate(expr: Expr, values: Values): number {
  switch (expr.kind) {
    case 'const':
      return expr.c;
    case 'copy':
      return valueOf(values, expr.u);
    case 'sum':
      return valueOf(values, expr.u) + valueOf(values, expr.w);
    case 'cond':
      return valueOf(values, expr.g) > expr.t ? valueOf(values, expr.u) : valueOf(values, expr.w);
  }
}

function valueOf(values: Values, v: Var): number {
  const value = values.get(v);
  if (value === undefined) throw new Error(`program reads ${v} before any statement wrote it`);
  return value;
}

// ─── The judge ───

export interface Verdict {
  /** Final value of every written variable. */
  values: Map<Var, number>;
  /** For every written variable: the stage ids on a dynamic dependence path to its final value. */
  causes: Map<Var, Set<string>>;
  /** Stage ids that ran, in order (a decider's id, then its chosen branch's id). */
  executed: string[];
}

/** Interprets `program` and returns the true cause set of every written variable. */
export function judge(program: Program): Verdict {
  const values = new Map<Var, number>();
  const causes = new Map<Var, Set<string>>();
  const executed: string[] = [];

  const run = (stageId: string, statement: Statement, control: ReadonlySet<string>) => {
    const deps = new Set<string>([stageId, ...control]);
    for (const read of readsOf(statement.expr, values)) for (const s of causes.get(read)!) deps.add(s);
    values.set(statement.target, evaluate(statement.expr, values));
    causes.set(statement.target, deps);
  };

  for (const block of program.blocks) {
    if (block.kind === 'stage') {
      executed.push(block.id);
      for (const statement of block.statements) run(block.id, statement, new Set());
      continue;
    }
    executed.push(block.id);
    const chosen = valueOf(values, block.g) > block.t ? block.yes : block.no;
    executed.push(chosen.id);
    run(chosen.id, chosen.statement, new Set([block.id, ...causes.get(block.g)!]));
  }
  return { values, causes, executed };
}

// ─── Seeded generator ───

/** mulberry32 — a small deterministic PRNG; `next()` is uniform in [0, 1). */
export function prng(seed: number): { next: () => number; int: (lo: number, hi: number) => number } {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)) };
}

type Rng = ReturnType<typeof prng>;

/**
 * NO_OP_WRITE_GUARD — the generator's one named exclusion: a statement is
 * redrawn when its value equals what its variable holds now, or held when its
 * stage began (a later statement in the same stage could otherwise restore the
 * start value, and the commit — a net change — would record no row).
 */
export function isNoOpWrite(target: Var, value: number, current: Values, stageStart: Values): boolean {
  return current.get(target) === value || stageStart.get(target) === value;
}

const MAX_REDRAWS = 200;

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[rng.int(0, items.length - 1)];
}

function drawExpr(rng: Rng, defined: readonly Var[], values: Values): Expr {
  if (defined.length === 0) return { kind: 'const', c: rng.int(0, 9) };
  const roll = rng.next();
  if (roll < 0.25) return { kind: 'const', c: rng.int(0, 9) };
  if (roll < 0.5) return { kind: 'copy', u: pick(rng, defined) };
  if (roll < 0.75) return { kind: 'sum', u: pick(rng, defined), w: pick(rng, defined) };
  const g = pick(rng, defined);
  return { kind: 'cond', g, t: valueOf(values, g) + rng.int(-2, 1), u: pick(rng, defined), w: pick(rng, defined) };
}

/** Draws one statement that is not a no-op write (see `NO_OP_WRITE_GUARD`). */
function drawStatement(
  rng: Rng,
  vars: readonly Var[],
  defined: readonly Var[],
  values: Values,
  stageStart: Values,
): Statement {
  for (let i = 0; i < MAX_REDRAWS; i++) {
    const statement = { target: pick(rng, vars), expr: drawExpr(rng, defined, values) };
    if (!isNoOpWrite(statement.target, evaluate(statement.expr, values), values, stageStart)) return statement;
  }
  throw new Error('generator: no non-no-op statement found');
}

/** Generates a program from `seed`. Stage ids are `s0, s1, …` in declaration order. */
export function generateProgram(seed: number, shape: ProgramShape): Program {
  const rng = prng(seed);
  const vars = Array.from({ length: shape.vars }, (_, i) => `v${i}`);
  const values = new Map<Var, number>();
  const blocks: Block[] = [];
  let nextId = 0;
  const newId = () => `s${nextId++}`;

  // Cut the statement list into stage sizes.
  const sizes: number[] = [];
  for (let left = shape.statements; left > 0; ) {
    const size = Math.min(left, shape.perStage === 'random' ? rng.int(1, 4) : shape.perStage);
    sizes.push(size);
    left -= size;
  }
  // Decider diamonds go AFTER stage `k` (never before the first stage: something must be defined to test).
  const deciderSlots = new Set<number>();
  const diamonds = rng.int(0, shape.maxDeciders);
  for (let i = 0; i < diamonds; i++) deciderSlots.add(rng.int(0, sizes.length - 1));

  const defined = () => vars.filter((v) => values.has(v));

  sizes.forEach((size, index) => {
    const stage: StageBlock = { kind: 'stage', id: newId(), statements: [] };
    const stageStart = new Map(values);
    for (let i = 0; i < size; i++) {
      const statement = drawStatement(rng, vars, defined(), values, stageStart);
      values.set(statement.target, evaluate(statement.expr, values));
      stage.statements.push(statement);
    }
    blocks.push(stage);

    if (!deciderSlots.has(index)) return;
    const g = pick(rng, defined());
    const t = valueOf(values, g) + rng.int(-1, 0);
    const id = newId();
    const yes = { id: newId(), statement: drawStatement(rng, vars, defined(), values, values) };
    // The no-branch writes the SAME variable, so it is defined after the diamond whichever branch ran.
    const no = { id: newId(), statement: drawBranchTwin(rng, yes.statement.target, defined(), values) };
    blocks.push({ kind: 'decider', id, g, t, yes, no });
    const chosen = valueOf(values, g) > t ? yes : no;
    values.set(chosen.statement.target, evaluate(chosen.statement.expr, values));
  });

  return { blocks };
}

function drawBranchTwin(rng: Rng, target: Var, defined: readonly Var[], values: Values): Statement {
  for (let i = 0; i < MAX_REDRAWS; i++) {
    const expr = drawExpr(rng, defined, values);
    if (!isNoOpWrite(target, evaluate(expr, values), values, values)) return { target, expr };
  }
  throw new Error('generator: no non-no-op branch statement found');
}

/** True when no statement that runs writes the value its variable held before it, or at its stage's start. */
export function respectsNoOpGuard(program: Program): boolean {
  const values = new Map<Var, number>();
  const runOne = (statement: Statement, stageStart: Values) => {
    const value = evaluate(statement.expr, values);
    if (isNoOpWrite(statement.target, value, values, stageStart)) return false;
    values.set(statement.target, value);
    return true;
  };
  for (const block of program.blocks) {
    if (block.kind === 'stage') {
      const stageStart = new Map(values);
      for (const statement of block.statements) if (!runOne(statement, stageStart)) return false;
      continue;
    }
    const chosen = valueOf(values, block.g) > block.t ? block.yes : block.no;
    if (!runOne(chosen.statement, new Map(values))) return false;
  }
  return true;
}

/** Renders a program as readable pseudo-code (for failure messages and the README). */
export function describeProgram(program: Program): string {
  const expr = (e: Expr): string => {
    switch (e.kind) {
      case 'const':
        return `${e.c}`;
      case 'copy':
        return e.u;
      case 'sum':
        return `${e.u} + ${e.w}`;
      case 'cond':
        return `${e.g} > ${e.t} ? ${e.u} : ${e.w}`;
    }
  };
  const line = (s: Statement) => `${s.target} = ${expr(s.expr)}`;
  return program.blocks
    .map((b) =>
      b.kind === 'stage'
        ? `${b.id}: ${b.statements.map(line).join('; ')}`
        : `${b.id}: decide ${b.g} > ${b.t} ? ${b.yes.id} { ${line(b.yes.statement)} } : ${b.no.id} { ${line(
            b.no.statement,
          )} }`,
    )
    .join('\n');
}
