/**
 * hidden-object-scaling — does any shape of "a stage passes hidden objects on" cost the SQUARE of the
 * number of hidden places?
 *
 * Why it exists: an object a stage read under a hidden name keeps its rule wherever the stage puts it
 * (`memory/selectedObjects.ts`), and a key takes one hidden field for each such object put below it.
 * So the number of hidden places under a key comes from data, and every step that handles them must
 * cost their number, not its square. Three steps did cost the square, each found by measuring, none by
 * reading: a rule's paths were scanned for every member of a value (`selectedObjects.ts · read`), a
 * key was handed its new fields one object at a time (`redaction.ts · inheritByIdentity`), and the
 * walk that serves a record scanned every target for every key (`memory/pathTargets.ts`). A fourth
 * was found by the second reader with a shape this file did not have yet: a key read again at every
 * member looked up through it, its list of fields compared each time (the `lookup` shapes). This is
 * the checked-in instrument that shows none is left: each shape is run at `rows` and at four times
 * `rows`, and the two times are divided. A new step that handles hidden places gets a shape here.
 *
 * How to read it: a ratio near 4 is a cost that grows with the size. A ratio near 16 is the square;
 * the line is marked `SQUARE?` from 7 on. Small times are noisy: run it twice before believing a mark.
 *
 * Two shapes are not about the number of places and are capped, with the reason at each: a chain
 * 2,000 records deep (a path is text, and a text as long as the chain is handled at each level), and
 * 200 writes below one key (each write of a record costs its size, with or without a policy).
 *
 * Run:  node --import tsx bench/hidden-object-scaling.ts                        # current src
 *       node --import tsx bench/hidden-object-scaling.ts --root /abs/path/to/it  # another checkout's src
 *       node --import tsx bench/hidden-object-scaling.ts --rows 4000             # 4,000 and 16,000
 *       node --import tsx bench/hidden-object-scaling.ts --only index            # shapes whose name starts so
 * Prints, per shape, the median of 3 runs after one warm-up run at each size, and their ratio.
 */

// A module, so its names stay its own (the other bench files are scripts and share one scope).
export {};

const ROUNDS = 3;

interface Shape {
  readonly name: string;
  policy(rows: number): object;
  /** The first stage: it writes what the policy hides. */
  seed(scope: any, rows: number): void;
  /** The stage under test: a hidden read, then the writes. */
  write(scope: any, rows: number): void;
  /** A third stage, for the shapes that write a key again after it took its hidden fields. */
  after?(scope: any, rows: number): void;
  input?(rows: number): object;
}

const users = (rows: number) => Array.from({ length: rows }, (_, id) => ({ id, name: `n${id}` }));
const hiddenUsers = () => ({ keys: ['users', 'secret'] });
const seedUsers = (scope: any, rows: number) => {
  scope.users = users(rows);
};
const readUsers = (scope: any) => scope.$getValue('users') as { id: number }[];
const byId = (list: { id: number }[], wrap: (user: object) => unknown = (user) => user) =>
  Object.fromEntries(list.map((user) => [`u${user.id}`, wrap(user)]));
const fieldNames = (rows: number) => Array.from({ length: rows }, (_, i) => `f${i}`);
const recordsWithSecret = (rows: number) => ({
  rows: Array.from({ length: rows }, (_, i) => ({ i, secret: { token: `t${i}` } })),
});

const SHAPES: Shape[] = [
  {
    name: 'index: one record of N hidden objects, in one write',
    policy: hiddenUsers,
    seed: seedUsers,
    write: (scope) => {
      scope.byId = byId(readUsers(scope));
    },
  },
  {
    name: 'nested: one record of N records, each holding a hidden object',
    policy: hiddenUsers,
    seed: seedUsers,
    write: (scope) => {
      scope.byId = byId(readUsers(scope), (user) => ({ owner: user }));
    },
  },
  {
    name: 'late: N hidden objects put into a written record AFTER the write',
    policy: hiddenUsers,
    seed: seedUsers,
    write: (scope) => {
      const box: Record<string, unknown> = {};
      scope.$setValue('box', box);
      for (const user of readUsers(scope)) box[`u${user.id}`] = user;
    },
  },
  {
    name: 'keys: N top keys, a hidden object in each',
    policy: hiddenUsers,
    seed: seedUsers,
    write: (scope) => {
      for (const user of readUsers(scope)) scope.$setValue(`k${user.id}`, user);
    },
  },
  {
    name: 'list: a new list of the N hidden objects',
    policy: hiddenUsers,
    seed: seedUsers,
    write: (scope) => {
      scope.copy = readUsers(scope).map((user) => user);
    },
  },
  {
    name: 'map: a Map keyed by the N hidden objects',
    policy: hiddenUsers,
    seed: seedUsers,
    write: (scope) => {
      scope.$setValue('map', new Map(readUsers(scope).map((user) => [user, 1])));
    },
  },
  {
    name: 'read: the hidden list read N times',
    policy: hiddenUsers,
    seed: seedUsers,
    write: (scope, rows) => {
      let total = 0;
      for (let i = 0; i < rows; i++) total += readUsers(scope).length;
      scope.total = total;
    },
  },
  {
    name: 'read after a write: the hidden list read N times, as a private copy',
    policy: hiddenUsers,
    seed: seedUsers,
    write: (scope, rows) => {
      scope.started = true;
      let total = 0;
      for (let i = 0; i < rows; i++) total += readUsers(scope).length;
      scope.total = total;
    },
  },
  {
    // Small times, and on main too this one grows a little faster than its size (about 6 times for 4
    // times the items), so it can touch the mark without a square behind it.
    name: 'items: users[i] through the scope, N times',
    policy: hiddenUsers,
    seed: seedUsers,
    write: (scope, rows) => {
      let total = 0;
      const list = scope.users;
      for (let i = 0; i < rows; i++) total += list[i].id;
      scope.total = total;
    },
  },
  {
    name: 'declared: a record with N declared hidden fields, copied to another key',
    policy: (rows) => ({ fields: { profile: fieldNames(rows) } }),
    seed: (scope, rows) => {
      scope.profile = Object.fromEntries(fieldNames(rows).map((name, i) => [name, { v: i }]));
    },
    write: (scope) => {
      scope.copy = scope.$getValue('profile');
    },
  },
  {
    name: 'declared members: the N hidden members of a record, each put into a new record',
    policy: (rows) => ({ fields: { profile: fieldNames(rows) } }),
    seed: (scope, rows) => {
      scope.profile = Object.fromEntries(fieldNames(rows).map((name, i) => [name, { v: i }]));
    },
    write: (scope) => {
      const profile = scope.$getValue('profile') as Record<string, object>;
      scope.copy = Object.fromEntries(Object.entries(profile).map(([name, value]) => [`c${name}`, value]));
    },
  },
  {
    name: 'input: N records with a hidden field each, the input copied whole',
    policy: () => ({ keys: ['secret'] }),
    input: recordsWithSecret,
    seed: () => undefined,
    write: (scope) => {
      scope.copy = scope.$getArgs();
    },
  },
  {
    name: 'input index: the N hidden records of an input, indexed by id',
    policy: () => ({ keys: ['secret'] }),
    input: recordsWithSecret,
    seed: () => undefined,
    write: (scope) => {
      const rows = (scope.$getArgs() as { rows: { i: number; secret: object }[] }).rows;
      scope.byId = Object.fromEntries(rows.map((row) => [`u${row.i}`, row.secret]));
    },
  },
  {
    name: 'again: a key with N hidden fields written whole 50 times in the next stage',
    policy: hiddenUsers,
    seed: seedUsers,
    write: (scope) => {
      scope.byId = byId(readUsers(scope));
    },
    after: (scope) => {
      scope.seen = readUsers(scope).length;
      for (let i = 0; i < 50; i++) scope.byId = { ...(scope.$getValue('byId') as object), round: i };
    },
  },
  {
    // An ordinary lookup table, read member by member through one handle. Each member read goes
    // through the key's read door again, with a new rule object over the key's one list of fields.
    name: 'lookup: a key with N hidden fields, each member read through one handle in the next stage',
    policy: hiddenUsers,
    seed: seedUsers,
    write: (scope) => {
      scope.byId = byId(readUsers(scope));
    },
    after: (scope, rows) => {
      const table = scope.byId;
      let total = 0;
      for (let i = 0; i < rows; i++) total += table[`u${i}`].id;
      scope.total = total;
    },
  },
  {
    name: 'lookup again: the same, with the key asked for at every member (scope.byId[id])',
    policy: hiddenUsers,
    seed: seedUsers,
    write: (scope) => {
      scope.byId = byId(readUsers(scope));
    },
    after: (scope, rows) => {
      let total = 0;
      for (let i = 0; i < rows; i++) total += scope.byId[`u${i}`].id;
      scope.total = total;
    },
  },
  {
    // The key has a field the policy declares as well, so its list of fields is the two lists joined.
    name: 'lookup declared: the same lookup, through a key the policy declares a field for as well',
    policy: () => ({ keys: ['users', 'secret'], fields: { byId: ['note'] } }),
    seed: seedUsers,
    write: (scope) => {
      scope.byId = { ...byId(readUsers(scope)), note: 'n' };
    },
    after: (scope, rows) => {
      const table = scope.byId;
      let total = 0;
      for (let i = 0; i < rows; i++) total += table[`u${i}`].id;
      scope.total = total;
    },
  },
  {
    // Capped at 200 writes: a write below a record costs the record's size with or without a policy
    // (the record merges a patch by walking the whole of it), so N writes would measure that square.
    name: 'below: a key with N hidden fields, 200 writes below it in the next stage',
    policy: hiddenUsers,
    seed: seedUsers,
    write: (scope) => {
      scope.byId = byId(readUsers(scope));
    },
    after: (scope) => {
      scope.seen = readUsers(scope).length;
      for (let i = 0; i < 200; i++) scope.$update('byId', { [`extra${i}`]: { n: i } });
    },
  },
  {
    name: 'wide: a record of N public records and one hidden object',
    policy: hiddenUsers,
    seed: (scope) => {
      scope.secret = { token: 't' };
    },
    write: (scope, rows) => {
      const box: Record<string, unknown> = Object.fromEntries(Array.from({ length: rows }, (_, i) => [`p${i}`, { i }]));
      box.hidden = scope.$getValue('secret');
      scope.box = box;
    },
  },
  {
    // Capped at 2,000 levels, so both sizes run the same chain and the ratio is 1. A path is text: the
    // field path of the bottom is as long as the chain, and it is handled once at each level, which is
    // the square of the DEPTH (about 65 ms at 2,000 levels, 6 ms at 500). Depth is not a number of
    // hidden places, and state that deep is rare; the number is here so that a change shows.
    name: 'deep: a chain of 2,000 records, the hidden object at the bottom',
    policy: hiddenUsers,
    seed: (scope) => {
      scope.secret = { token: 't' };
    },
    write: (scope) => {
      let node: Record<string, unknown> = { leaf: scope.$getValue('secret') };
      for (let i = 0; i < 2_000; i++) node = { next: node };
      scope.chain = node;
    },
  },
];

type Lib = {
  flowChart: (name: string, fn: (scope: any) => void, id: string) => any;
  FlowChartExecutor: new (chart: any, options?: object) => {
    run(options?: object): Promise<unknown>;
    getSnapshot(): any;
    setRedactionPolicy(policy: object): void;
  };
};

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at !== -1 ? process.argv[at + 1] : undefined;
}

async function loadLib(): Promise<{ lib: Lib; label: string }> {
  const root = flag('--root')?.replace(/\/$/, '');
  if (root) return { lib: (await import(`${root}/src/index.ts`)) as Lib, label: root };
  return { lib: (await import('../src/index')) as unknown as Lib, label: 'src' };
}

/** The median time of one shape at one size. */
async function timeOf(lib: Lib, shape: Shape, rows: number): Promise<number> {
  let builder = lib
    .flowChart('Seed', (scope: any) => shape.seed(scope, rows), 'seed')
    .addFunction(
      'Write',
      (scope: any) => {
        shape.write(scope, rows);
        scope.done = true;
      },
      'write',
    );
  const after = shape.after;
  if (after !== undefined) builder = builder.addFunction('After', (scope: any) => after(scope, rows), 'after');
  const chart = builder.build();
  const times: number[] = [];
  for (let round = 0; round <= ROUNDS; round++) {
    const executor = new lib.FlowChartExecutor(chart, { readTracking: 'off' });
    executor.setRedactionPolicy(shape.policy(rows));
    const input = shape.input?.(rows);
    const start = performance.now();
    await executor.run(input === undefined ? undefined : { input });
    const ms = performance.now() - start;
    if (executor.getSnapshot().sharedState.done !== true) throw new Error(`${shape.name}: the stage did not finish`);
    if (round > 0) times.push(ms); // the first run warms up
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

async function main() {
  const { lib, label } = await loadLib();
  const rows = Number(flag('--rows') ?? 2_000);
  const only = flag('--only');
  console.log(`engine: ${label}, rows: ${rows} and ${4 * rows}`);
  for (const shape of SHAPES) {
    if (only !== undefined && !shape.name.startsWith(only)) continue;
    const small = await timeOf(lib, shape, rows);
    const large = await timeOf(lib, shape, 4 * rows);
    // Below half a millisecond a ratio says nothing.
    const ratio = large / Math.max(small, 0.5);
    const mark = ratio >= 7 ? 'SQUARE?' : 'ok     ';
    const times = `${small.toFixed(1).padStart(8)} ms -> ${large.toFixed(1).padStart(8)} ms`;
    console.log(`${mark} x${ratio.toFixed(1).padStart(5)}  ${times}  ${shape.name}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
