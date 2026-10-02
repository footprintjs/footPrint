/**
 * commit-clones — what ONE small write costs while the state grows.
 *
 * Why it exists: an agent's state holds its growing conversation. A stage
 * that writes one small key used to pay three deep clones of the WHOLE
 * committed state (two when its transaction buffer is built, one when the
 * commit is applied), so its cost grew with the conversation even though the
 * stage changed one number. This bench is the instrument that says, by
 * OPERATION COUNT first and time second, what a small write costs at
 * N = 100 / 1k / 10k history items.
 *
 * Scenarios (each under commitValues 'full' and 'delta'):
 *   small   — seed writes `history` (N items); then S stages each write ONE
 *             small key and read nothing. Per stage: structuredClone calls,
 *             bytes cloned (v8.serialize length of every clone input), nodes
 *             visited (every value inside every clone input), and which call
 *             site paid each clone.
 *   mirror  — `small` with a redaction policy on an unrelated key, so the
 *             redacted mirror is maintained (the fourth whole-state clone).
 *   readback — `small`, but each stage READS `history` after its write
 *             (a tracked read); `readback-untracked` the same under
 *             readTracking 'off' — the shape where a private copy of a
 *             post-write read would cost.
 *   agent   — an agent-shaped turn over a history of N: `append` pushes one
 *             item through the scope proxy, `tick` writes a small key,
 *             `look` reads `history` (a tracked read). Per turn, by site — the
 *             residual that is proportional to the written / read VALUE.
 *   merge   — `small`, but each stage MERGES one field into a small key
 *             (`$update('profile', …)`) — a merge-bearing stage, the kind the
 *             admitted record (9.30.0) verifies before it commits.
 *   nested-seed — `small`, each stage followed by a subflow mount whose
 *             `inputMapper` seeds an object of 100 keys: 100 NESTED rows in
 *             the subflow's seed commit (the other kind it verifies). Per
 *             interval = the small stage plus the whole mount.
 *
 * Time is the SECONDARY signal: CPU per small-write stage (and per interval
 * for `merge` / `nested-seed`), measured in a separate pass with no clone spy
 * installed (median over stages and rounds). Run it on an idle machine before
 * quoting a time; the counts do not care.
 *
 * Run:  npx tsx bench/commit-clones.ts                    # this tree's src
 *       npx tsx bench/commit-clones.ts --src <root>       # another tree's src
 *       npx tsx bench/commit-clones.ts --sizes 100,1000   # only these N
 *       npx tsx bench/commit-clones.ts --json <file>      # also write rows
 */

export {}; // a module

// Node built-ins through `require` — the bench folder ships without @types/node (see node-shim.d.ts).
const fs = require('node:fs') as { writeFileSync(path: string, data: string): void };
const v8 = require('node:v8') as { serialize(value: unknown): { length: number } };
const cpuUsage = (process as unknown as { cpuUsage(): { user: number; system: number } }).cpuUsage;

const SIZES = [100, 1_000, 10_000];
const SMALL_STAGES = 20;
const AGENT_TURNS = 10;
const TIME_ROUNDS = 5;

type Lib = {
  flowChart: (name: string, fn: (scope: any) => unknown, id: string) => any;
  FlowChartExecutor: new (chart: any, options?: any) => {
    run(): Promise<unknown>;
    setRedactionPolicy(policy: unknown): void;
    getSnapshot(): { commitLog: unknown[]; sharedState: unknown };
  };
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function loadLib(): Promise<{ lib: Lib; label: string }> {
  const root = (arg('--src') ?? `${__dirname}/..`).replace(/\/$/, '');
  const lib = (await import(`${root}/src/index.ts`)) as unknown as Lib;
  return { lib, label: root };
}

// ─── The clone spy ────────────────────────────────────────────────────────

type SiteTally = { calls: number; bytes: number; nodes: number };
type Tally = SiteTally & { sites: Map<string, SiteTally> };

const realClone = globalThis.structuredClone;
let tally: Tally | undefined;

/** Every value inside `v` (containers and leaves), cycle-safe. */
function countNodes(v: unknown, seen = new WeakSet<object>()): number {
  if (v === null || typeof v !== 'object') return 1;
  if (seen.has(v)) return 1;
  seen.add(v);
  let n = 1;
  if (v instanceof Map) for (const [k, x] of v) n += countNodes(k, seen) + countNodes(x, seen);
  else if (v instanceof Set) for (const x of v) n += countNodes(x, seen);
  else for (const k of Object.keys(v)) n += countNodes((v as Record<string, unknown>)[k], seen);
  return n;
}

/** The library function that called structuredClone — the first frame under src/lib. */
function siteOf(stack: string): string {
  for (const line of stack.split('\n').slice(2)) {
    const m = /at (?:new )?([\w.$<>]+) \(.*\/src\/lib\/([\w/.-]+\.ts):\d+/.exec(line);
    if (m) return `${m[1]} · ${m[2].replace(/^.*\//, '')}`;
  }
  return '(outside src/lib)';
}

function installSpy(): void {
  globalThis.structuredClone = ((value: unknown, options?: StructuredSerializeOptions) => {
    if (tally) {
      let bytes = 0;
      try {
        bytes = v8.serialize(value).length;
      } catch {
        bytes = 0;
      }
      const nodes = countNodes(value);
      const site = siteOf(new Error().stack ?? '');
      tally.calls += 1;
      tally.bytes += bytes;
      tally.nodes += nodes;
      const s = tally.sites.get(site) ?? { calls: 0, bytes: 0, nodes: 0 };
      s.calls += 1;
      s.bytes += bytes;
      s.nodes += nodes;
      tally.sites.set(site, s);
    }
    return realClone(value, options);
  }) as typeof structuredClone;
}

function newTally(): Tally {
  return { calls: 0, bytes: 0, nodes: 0, sites: new Map() };
}

// ─── Charts ───────────────────────────────────────────────────────────────

function item(i: number) {
  return { role: i % 2 ? 'assistant' : 'user', content: `message ${i} ${'x'.repeat(40)}`, meta: { i, t: i * 7 } };
}

type Mark = { at: number; tally?: Tally; cpu: number };

/** How a small stage writes: one key (`set`), or one field merged into a small key (`merge`). */
type SmallWrite = 'set' | 'merge';

/** The 100-key object a `nested-seed` mount seeds — built fresh per mount. */
function seed100(i: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (let k = 0; k < 100; k++) out[`k${k}`] = i * 100 + k;
  return out;
}

/**
 * seed (history of n) → S small-write stages. `marks[i]` is taken at the top
 * of small stage i. `write` picks the stage's write; `mount` follows every
 * small stage with a subflow whose seed is a 100-key object (nested rows).
 */
function smallChart(
  lib: Lib,
  n: number,
  marks: Mark[],
  spy: boolean,
  readBack = false,
  write: SmallWrite = 'set',
  mount = false,
) {
  const mark = () => {
    const snap = tally ? { ...tally, sites: new Map([...tally.sites].map(([k, v]) => [k, { ...v }])) } : undefined;
    const u = cpuUsage();
    marks.push({ at: marks.length, tally: spy ? snap : undefined, cpu: (u.user + u.system) / 1000 });
  };
  const inner = mount
    ? lib
        .flowChart(
          'Inner',
          (scope: any) => {
            scope.seen = scope.cfg.k0;
          },
          'inner',
        )
        .build()
    : undefined;
  let b = lib.flowChart(
    'Seed',
    (scope: any) => {
      scope.history = Array.from({ length: n }, (_, i) => item(i));
      scope.profile = { name: 'n', tier: 'gold' };
      scope.counter = 0;
    },
    'seed',
  );
  for (let i = 0; i < SMALL_STAGES; i++) {
    b = b.addFunction(
      `Small${i}`,
      (scope: any) => {
        mark();
        if (write === 'merge') scope.$update('profile', { [`k${i}`]: i });
        else scope[`k${i}`] = i;
        if (readBack) void scope.history.length; // a read AFTER the stage's first write
      },
      `small-${i}`,
    );
    if (inner) b = b.addSubFlowChart(`sub-${i}`, inner, `Sub${i}`, { inputMapper: () => ({ cfg: seed100(i) }) });
  }
  b = b.addFunction('End', () => mark(), 'end');
  return b.build();
}

type Scenario = 'small' | 'mirror' | 'agent' | 'readback' | 'readback-untracked' | 'merge' | 'nested-seed';

/** The small-chart shape of a scenario: its write, whether it reads back, whether it mounts. */
function smallShape(scenario: Scenario): { readBack: boolean; write: SmallWrite; mount: boolean } {
  return {
    readBack: scenario.startsWith('readback'),
    write: scenario === 'merge' ? 'merge' : 'set',
    mount: scenario === 'nested-seed',
  };
}

/** Scenarios whose CPU per interval is measured too (the time pass). */
const TIMED: ReadonlySet<Scenario> = new Set<Scenario>(['small', 'merge', 'nested-seed']);

/** seed (history of n) → T turns of [append, tick, look]. Marks at the top of each `append`. */
function agentChart(lib: Lib, n: number, marks: Mark[]) {
  const mark = () => {
    const snap = tally ? { ...tally, sites: new Map([...tally.sites].map(([k, v]) => [k, { ...v }])) } : undefined;
    marks.push({ at: marks.length, tally: snap, cpu: 0 });
  };
  let b = lib.flowChart(
    'Seed',
    (scope: any) => {
      scope.history = Array.from({ length: n }, (_, i) => item(i));
      scope.turn = 0;
    },
    'seed',
  );
  for (let t = 0; t < AGENT_TURNS; t++) {
    b = b
      .addFunction(
        `Append${t}`,
        (scope: any) => {
          mark();
          scope.history.push(item(n + t));
        },
        `append-${t}`,
      )
      .addFunction(
        `Tick${t}`,
        (scope: any) => {
          scope.turn = t + 1;
        },
        `tick-${t}`,
      )
      .addFunction(
        `Look${t}`,
        (scope: any) => {
          void scope.history.length;
        },
        `look-${t}`,
      );
  }
  b = b.addFunction('End', () => mark(), 'end');
  return b.build();
}

// ─── Measurement ──────────────────────────────────────────────────────────

type Row = {
  scenario: string;
  encoding: string;
  n: number;
  perStage: { calls: number; bytes: number; nodes: number };
  sites: Record<string, SiteTally>;
  cpuMsPerStage?: number;
};

function diff(a: Mark, b: Mark): Tally {
  const t = newTally();
  const ta = a.tally!;
  const tb = b.tally!;
  t.calls = tb.calls - ta.calls;
  t.bytes = tb.bytes - ta.bytes;
  t.nodes = tb.nodes - ta.nodes;
  for (const [k, v] of tb.sites) {
    const p = ta.sites.get(k) ?? { calls: 0, bytes: 0, nodes: 0 };
    if (v.calls - p.calls > 0)
      t.sites.set(k, { calls: v.calls - p.calls, bytes: v.bytes - p.bytes, nodes: v.nodes - p.nodes });
  }
  return t;
}

/** Mean per interval over the marks (stage i = marks[i] → marks[i+1]). */
function perInterval(marks: Mark[]): { perStage: Row['perStage']; sites: Record<string, SiteTally> } {
  const k = marks.length - 1;
  const total = diff(marks[0], marks[k]);
  const sites: Record<string, SiteTally> = {};
  for (const [name, s] of total.sites)
    sites[name] = { calls: s.calls / k, bytes: Math.round(s.bytes / k), nodes: Math.round(s.nodes / k) };
  return {
    perStage: { calls: total.calls / k, bytes: Math.round(total.bytes / k), nodes: Math.round(total.nodes / k) },
    sites,
  };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function countRun(lib: Lib, scenario: Scenario, encoding: string, n: number): Promise<Row> {
  const marks: Mark[] = [];
  const shape = smallShape(scenario);
  const chart =
    scenario === 'agent'
      ? agentChart(lib, n, marks)
      : smallChart(lib, n, marks, true, shape.readBack, shape.write, shape.mount);
  const ex = new lib.FlowChartExecutor(chart, {
    commitValues: encoding,
    ...(scenario === 'readback-untracked' ? { readTracking: 'off' } : {}),
  });
  if (scenario === 'mirror') ex.setRedactionPolicy({ keys: ['unrelatedSecret'] });
  tally = newTally();
  await ex.run();
  tally = undefined;
  const { perStage, sites } = perInterval(marks);
  return { scenario, encoding, n, perStage, sites };
}

async function timeRun(lib: Lib, scenario: Scenario, encoding: string, n: number): Promise<number> {
  const perStage: number[] = [];
  const shape = smallShape(scenario);
  for (let r = 0; r < TIME_ROUNDS; r++) {
    const marks: Mark[] = [];
    const chart = smallChart(lib, n, marks, false, shape.readBack, shape.write, shape.mount);
    await new lib.FlowChartExecutor(chart, { commitValues: encoding }).run();
    for (let i = 1; i < marks.length; i++) perStage.push(marks[i].cpu - marks[i - 1].cpu);
  }
  return median(perStage);
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

async function main(): Promise<void> {
  const { lib, label } = await loadLib();
  const sizes = arg('--sizes') ? arg('--sizes')!.split(',').map(Number) : SIZES;
  installSpy();
  const rows: Row[] = [];
  console.log(`commit-clones — ${label}`);
  const only = arg('--scenarios')?.split(',');
  const scenarios: readonly Scenario[] = [
    'small',
    'mirror',
    'agent',
    'readback',
    'readback-untracked',
    'merge',
    'nested-seed',
  ];
  for (const scenario of scenarios) {
    if (only && !only.includes(scenario)) continue;
    for (const encoding of ['full', 'delta']) {
      for (const n of sizes) {
        const row = await countRun(lib, scenario, encoding, n);
        if (TIMED.has(scenario)) row.cpuMsPerStage = await timeRun(lib, scenario, encoding, n);
        rows.push(row);
        const p = row.perStage;
        console.log(
          `${scenario.padEnd(6)} ${encoding.padEnd(5)} N=${String(n).padStart(6)}  ` +
            `clones/stage ${p.calls.toFixed(1).padStart(5)}  bytes/stage ${fmtBytes(p.bytes).padStart(10)}  ` +
            `nodes/stage ${String(p.nodes).padStart(7)}` +
            (row.cpuMsPerStage !== undefined ? `  cpu/stage ${row.cpuMsPerStage.toFixed(3)} ms` : ''),
        );
        for (const [site, s] of Object.entries(row.sites).sort((a, b) => b[1].bytes - a[1].bytes)) {
          console.log(
            `        ${site.padEnd(52)} ${s.calls.toFixed(2).padStart(6)} calls  ${fmtBytes(s.bytes).padStart(
              10,
            )}  ${String(s.nodes).padStart(7)} nodes`,
          );
        }
      }
    }
  }
  const out = arg('--json');
  if (out) fs.writeFileSync(out, JSON.stringify({ label, rows }, null, 2) + '\n');
}

void main();
