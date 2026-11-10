/**
 * fault-finding — does the walk back lead to a planted fault, and how much of
 * the run does it ask a reader to look at?
 *
 * Why it exists: the walk-back property (test/lib/slice/walk-back-soundness)
 * says the walk back never omits a cause. This bench measures what that buys
 * a person hunting a bug, and what the stage size costs in precision.
 *
 * For each stage size (1, 2, 4, 8 statements per stage) and a fixed seed:
 *   1. generate a program (test/lib/slice/walk-back/programs.ts);
 *   2. change ONE statement — a different constant, or one operand swapped for
 *      another variable defined at that point — and keep the change only when
 *      some final value differs and the faulty program still respects the
 *      no-op-write guard (a known gap, pinned in the property test);
 *   3. run the FAULTY chart (test/lib/slice/walk-back/toChart.ts) and walk back
 *      from every variable whose final value differs from the original run.
 *
 * Columns:
 *   walks          — (program, differing variable) pairs walked back from
 *   fault in walk  — share of walks whose stages include the faulty stage
 *   fault in truth — the same against the independent judge's true causes
 *   walk/executed  — mean share of the run's executed stages the walk names
 *   truth/executed — the same for the judge's true cause set (the floor)
 *
 * It only prints; it writes no file.
 *
 * Run:  npx tsx bench/fault-finding.ts            (SEED=20261110, PROGRAMS=300 per size)
 *       SEED=7 PROGRAMS=100 npx tsx bench/fault-finding.ts
 */
import {
  type Block,
  type Expr,
  type Program,
  type Statement,
  type Var,
  generateProgram,
  judge,
  prng,
  respectsNoOpGuard,
} from '../test/lib/slice/walk-back/programs';
import { runAndWalk } from '../test/lib/slice/walk-back/toChart';
import { printHeader } from './util';

const SEED = Number(process.env.SEED ?? 20261110);
const PROGRAMS = Number(process.env.PROGRAMS ?? 300);
const SIZES = [1, 2, 4, 8];
const SHAPE = { vars: 6, statements: 16, maxDeciders: 2 };
const MAX_TRIES = 50;

type Rng = ReturnType<typeof prng>;

/** Where a statement sits: the stage that runs it, and how to replace it. */
interface Site {
  stageId: string;
  statement: Statement;
  /** Variables written by statements that always run before this one. */
  defined: Var[];
  replace: (program: Program, statement: Statement) => Program;
}

function sitesOf(program: Program): Site[] {
  const sites: Site[] = [];
  const defined = new Set<Var>();
  const swapBlock = (index: number, block: Block) => (p: Program) => ({
    blocks: p.blocks.map((b, i) => (i === index ? block : b)),
  });
  program.blocks.forEach((block, index) => {
    if (block.kind === 'stage') {
      block.statements.forEach((statement, k) => {
        sites.push({
          stageId: block.id,
          statement,
          defined: [...defined],
          replace: (p, next) =>
            swapBlock(index, { ...block, statements: block.statements.map((s, j) => (j === k ? next : s)) })(p),
        });
        defined.add(statement.target);
      });
      return;
    }
    const before = [...defined];
    sites.push({
      stageId: block.yes.id,
      statement: block.yes.statement,
      defined: before,
      replace: (p, next) => swapBlock(index, { ...block, yes: { ...block.yes, statement: next } })(p),
    });
    sites.push({
      stageId: block.no.id,
      statement: block.no.statement,
      defined: before,
      replace: (p, next) => swapBlock(index, { ...block, no: { ...block.no, statement: next } })(p),
    });
    defined.add(block.yes.statement.target);
  });
  return sites;
}

/** A different constant, or one operand swapped for another defined variable; undefined when none exists. */
function mutate(rng: Rng, expr: Expr, defined: readonly Var[]): Expr | undefined {
  if (expr.kind === 'const') return { kind: 'const', c: (expr.c + rng.int(1, 9)) % 10 };
  const other = (v: Var) => {
    const choices = defined.filter((d) => d !== v);
    return choices.length === 0 ? undefined : choices[rng.int(0, choices.length - 1)];
  };
  if (expr.kind === 'copy') {
    const u = other(expr.u);
    return u === undefined ? undefined : { ...expr, u };
  }
  const operand = rng.int(0, 1) === 0 ? 'u' : 'w';
  const swapped = other(expr[operand]);
  return swapped === undefined ? undefined : { ...expr, [operand]: swapped };
}

interface Row {
  programs: number;
  skipped: number;
  walks: number;
  inWalk: number;
  inTruth: number;
  walkShare: number;
  truthShare: number;
}

async function measureSize(perStage: number, rng: Rng): Promise<Row> {
  const row: Row = { programs: 0, skipped: 0, walks: 0, inWalk: 0, inTruth: 0, walkShare: 0, truthShare: 0 };
  for (let n = 0; n < PROGRAMS; n++) {
    const original = generateProgram(rng.int(0, 2 ** 31 - 1), { ...SHAPE, perStage });
    const before = judge(original).values;
    let planted: { faulty: Program; stageId: string; differing: Var[] } | undefined;
    for (let attempt = 0; attempt < MAX_TRIES && !planted; attempt++) {
      const sites = sitesOf(original);
      const site = sites[rng.int(0, sites.length - 1)];
      const expr = mutate(rng, site.statement.expr, site.defined);
      if (!expr) continue;
      const faulty = site.replace(original, { ...site.statement, expr });
      if (!respectsNoOpGuard(faulty)) continue;
      const after = judge(faulty).values;
      const differing = [...after.keys()].filter((v) => after.get(v) !== before.get(v));
      if (differing.length > 0) planted = { faulty, stageId: site.stageId, differing };
    }
    if (!planted) {
      row.skipped++;
      continue;
    }
    row.programs++;
    const truth = judge(planted.faulty);
    const run = await runAndWalk(planted.faulty, planted.differing);
    const executed = new Set(run.executed).size;
    for (const v of planted.differing) {
      const walk = run.walks.get(v);
      if (!walk) throw new Error(`no walk back from ${v}`);
      const causes = truth.causes.get(v) ?? new Set<string>();
      row.walks++;
      if (walk.stages.includes(planted.stageId)) row.inWalk++;
      if (causes.has(planted.stageId)) row.inTruth++;
      row.walkShare += new Set(walk.stages).size / executed;
      row.truthShare += causes.size / executed;
    }
  }
  return row;
}

const pct = (part: number, whole: number) => `${((100 * part) / Math.max(whole, 1)).toFixed(1)}%`;

async function main() {
  printHeader('fault-finding: does the walk back reach a planted fault?');
  console.log(
    `seed ${SEED} · ${PROGRAMS} programs per size · ${SHAPE.statements} statements, ${SHAPE.vars} variables, up to ${SHAPE.maxDeciders} deciders\n`,
  );
  const rng = prng(SEED);
  const header = [
    'stmts/stage',
    'programs',
    'walks',
    'fault in walk',
    'fault in truth',
    'walk/executed',
    'truth/executed',
  ];
  const lines: string[][] = [];
  for (const size of SIZES) {
    const r = await measureSize(size, rng);
    lines.push([
      `${size}`,
      `${r.programs}${r.skipped ? ` (+${r.skipped} skipped)` : ''}`,
      `${r.walks}`,
      pct(r.inWalk, r.walks),
      pct(r.inTruth, r.walks),
      pct(r.walkShare, r.walks),
      pct(r.truthShare, r.walks),
    ]);
  }
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
  const print = (cells: string[]) => console.log(`| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`);
  print(header);
  console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
  lines.forEach(print);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
