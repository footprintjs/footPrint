'use strict';

// Private store contract tests: all checkpoint bytes here are synthetic. Native
// pause/resume integration belongs to the adjacent worker/host example.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

const SOURCE = path.join(__dirname, 'store.cjs');
const KEY = 'tenant/workflow/operation/1';
const PRIVATE = 'PRIVATE-CHECKPOINT-AND-RECEIPT-SENTINEL';
const IDENTITY = Object.freeze({ programDigest: '1'.repeat(64), sdkDigest: '2'.repeat(64), sdkVersion: '12.3.0', mode: 'source' });
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

function prepared(extra = {}) {
  const checkpointWire = JSON.stringify({ checkpointVersion: 2, sharedState: { privateValue: PRIVATE } });
  return { checkpointWire, checkpointDigest: sha256(checkpointWire), pausedRunId: 'paused-native-run',
    pausedStageId: 'wait', dueAt: 30, businessExpiry: 100, ...extra };
}

function fixture(run, source = SOURCE) {
  const { Store } = require(source);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-store-contract-'));
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, 'host.sqlite');
  const stores = [];
  let store;
  const open = (identity = IDENTITY, initialize = false) => {
    const instance = new Store(filename, identity, { initialize });
    stores.push(instance);
    return instance;
  };
  try {
    store = open(IDENTITY, true);
    return run({ store, directory, filename, open, Store,
      call: (op, args = {}, principal = 'host') => store.execute(op, { key: KEY, ...args }, principal),
      raw: (callback) => {
        const database = new DatabaseSync(filename);
        try { return callback(database); } finally { database.close(); }
      } });
  } finally {
    for (const instance of stores) {
      try { instance.close(); } catch { /* A test may have already closed its own handle. */ }
    }
    fs.rmSync(directory, { recursive: true });
    assert.equal(fs.existsSync(directory), false, 'owned fixture scratch was retained');
  }
}

function decide(f, options = {}) {
  assert.deepEqual(f.call('publish', prepared(options)), { published: true });
  assert.deepEqual(f.call('tick', { to: 30 }), { clock: 30 });
  assert.deepEqual(f.call('due'), { checked: true });
}

function epochFence(source) {
  fixture((f) => {
    decide(f);
    const first = f.call('claim', {}, 'worker1');
    f.call('tick', { to: 35 });
    const second = f.call('claim', {}, 'worker1');
    assert.equal(second.epoch, first.epoch + 1);
    const admitted = f.call('admit', { epoch: first.epoch }, 'worker1');
    const completed = f.call('complete', { epoch: first.epoch, outcome: 'completed', resumedRunId: 'stale-native-run' }, 'worker1');
    assert.ok(admitted.refused === 'stale-or-expired' && completed.refused === 'stale-or-expired', 'epoch-fence');
    assert.equal(f.call('summary').status, 'claimed');
  }, source);
}

function strictDeadline(source) {
  fixture((f) => {
    f.call('publish', prepared());
    f.call('tick', { to: 30 });
    f.call('reply', { deliveryId: 'reply-at-deadline', body: PRIVATE }, 'receiver');
    assert.ok(f.call('summary').winner.kind === 'timer', 'strict-before-deadline');
  }, source);
}

function conflictingReceipt(source) {
  fixture((f) => {
    f.call('reply', { deliveryId: 'reply-1', body: PRIVATE }, 'receiver');
    const conflict = f.call('reply', { deliveryId: 'reply-1', body: 'different-private-content' }, 'receiver');
    assert.ok(conflict.refused === 'conflicting-receipt', 'conflicting-receipt-refused');
    assert.equal(f.call('summary').inboxCount, 1);
  }, source);
}

function atomicDecision(source) {
  fixture((f) => {
    f.call('publish', prepared());
    f.call('tick', { to: 30 });
    f.raw((db) => db.exec(`CREATE TRIGGER interrupt_task BEFORE INSERT ON tasks BEGIN
      SELECT RAISE(ABORT, 'owned task insertion fault'); END;`));
    assert.deepEqual(f.call('due'), { refused: 'storage-unavailable' });
    const summary = f.call('summary');
    assert.ok(summary.status === 'waiting' && summary.winner === null && summary.taskCount === 0, 'atomic-winner-task');
    f.raw((db) => db.exec('DROP TRIGGER interrupt_task'));
    assert.deepEqual(f.call('due'), { checked: true });
    assert.equal(f.call('summary').taskCount, 1);
  }, source);
}

const MUTATIONS = Object.freeze({
  epoch: {
    replacements: [['wait.epoch !== args.epoch', 'false'], ['task.epoch !== args.epoch', 'false']],
    run: epochFence, failure: 'epoch-fence',
  },
  deadline: {
    replacements: [['admitted<? ORDER BY seq LIMIT 1', 'admitted<=? ORDER BY seq LIMIT 1']],
    run: strictDeadline, failure: 'strict-before-deadline',
  },
  conflict: {
    replacements: [['old.body === args.body', 'true']],
    run: conflictingReceipt, failure: 'conflicting-receipt-refused',
  },
  atomicity: {
    replacements: [[`    this.#db.prepare("INSERT INTO tasks(key,task_id,status) VALUES(?,?,'queued')").run(KEY, TASK);`,
      `    this.#db.exec('COMMIT');\n    this.#db.prepare("INSERT INTO tasks(key,task_id,status) VALUES(?,?,'queued')").run(KEY, TASK);`]],
    run: atomicDecision, failure: 'atomic-winner-task',
  },
});

if (process.argv[2] === '--mutation-case') {
  const mutation = MUTATIONS[process.argv[3]];
  try {
    assert.ok(mutation && process.argv[4], 'invalid-owned-mutation');
    mutation.run(process.argv[4]);
    console.log(JSON.stringify({ caught: false }));
    process.exitCode = 0;
  } catch (error) {
    const expected = error?.name === 'AssertionError' && error.message === mutation?.failure;
    console.log(JSON.stringify({ caught: expected, failure: expected ? mutation.failure : 'unexpected-fixture-failure' }));
    process.exitCode = expected ? 1 : 2;
  }
} else {
  // Mutants run first. Each child must reach the exact behavioral assertion;
  // an import/setup failure is not counted as catching a broken policy.
  for (const [name, mutation] of Object.entries(MUTATIONS)) {
    test(`actual mutant caught before green: ${name}`, () => {
      const original = fs.readFileSync(SOURCE, 'utf8');
      const before = sha256(original);
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-store-mutant-'));
      fs.chmodSync(directory, 0o700);
      try {
        let changed = original;
        for (const [needle, replacement] of mutation.replacements) {
          assert.equal(changed.split(needle).length - 1, 1, 'mutation target drift');
          changed = changed.replace(needle, replacement);
        }
        const filename = path.join(directory, 'store.cjs');
        fs.writeFileSync(filename, changed, { mode: 0o600 });
        const child = spawnSync(process.execPath, [__filename, '--mutation-case', name, filename], {
          encoding: 'utf8', timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
          env: { PATH: process.env.PATH ?? '' },
        });
        assert.equal(child.error, undefined, 'owned mutation child failed to finish');
        assert.equal(child.status, 1, 'mutant did not fail at its behavioral assertion');
        assert.equal(child.signal, null, 'mutant was terminated instead of caught');
        assert.deepEqual(JSON.parse(child.stdout), { caught: true, failure: mutation.failure });
      } finally {
        fs.rmSync(directory, { recursive: true });
        assert.equal(fs.existsSync(directory), false);
      }
      assert.equal(sha256(fs.readFileSync(SOURCE, 'utf8')), before, 'original source changed during mutation');
    });
  }

  test('publication stores exact private bytes atomically, with one immutable dispatch', () => fixture((f) => {
    const publication = prepared();
    assert.deepEqual(f.call('publish', publication), { published: true });
    assert.deepEqual(f.call('publish', publication), { duplicate: true });
    assert.deepEqual(f.call('publish', { ...publication, businessExpiry: 99 }), { refused: 'conflicting-publication' });
    const stored = f.raw((db) => db.prepare('SELECT checkpoint_wire,checkpoint_digest FROM waits WHERE key=?').get(KEY));
    assert.ok(stored.checkpoint_wire === publication.checkpointWire, 'exact private checkpoint bytes changed');
    assert.equal(stored.checkpoint_digest, publication.checkpointDigest);
    const summary = f.call('summary');
    assert.deepEqual([summary.status, summary.taskCount, summary.outboxCount], ['waiting', 0, 1]);
    assert.equal(JSON.stringify(summary).includes(PRIVATE), false);
  }));

  test('prepublication replies survive and lowest admission sequence wins delayed selection', () => fixture((f) => {
    f.call('tick', { to: 12 });
    f.call('reply', { deliveryId: 'first', body: PRIVATE }, 'receiver');
    f.call('reply', { deliveryId: 'second', body: 'another reply' }, 'receiver');
    f.call('tick', { to: 40 });
    f.call('publish', prepared());
    const winner = f.call('summary').winner;
    assert.deepEqual(winner, { kind: 'reply', receiptRef: 'first' });
    f.call('reply', { deliveryId: 'late', body: 'late reply' }, 'receiver');
    f.call('due');
    assert.deepEqual(f.call('summary').winner, winner);
    assert.equal(f.call('summary').taskCount, 1);
  }));

  test('deadline tie is timer, and a delayed scheduler cannot promote a new late reply', () => {
    strictDeadline(SOURCE);
    fixture((f) => {
      f.call('publish', prepared()); f.call('tick', { to: 40 });
      f.call('reply', { deliveryId: 'late', body: PRIVATE }, 'receiver');
      assert.deepEqual(f.call('summary').winner, { kind: 'timer', dueAt: 30 });
    });
  });

  test('failed task insertion rolls back its winner and is recoverable without an orphan', () => atomicDecision(SOURCE));
  test('old epoch cannot retrieve private checkpoint or publish a result after recovery', () => epochFence(SOURCE));

  test('strict ordinals are rejected before database access, including duplicate paths', () => fixture((f) => {
    decide(f); const claim = f.call('claim', {}, 'worker1');
    for (const epoch of [true, false, 0, -1, 1.5, NaN, Infinity, '1', null, undefined, 1n, Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(f.call('admit', { epoch }, 'worker1'), { refused: 'invalid-epoch' });
      assert.deepEqual(f.call('complete', { epoch, outcome: 'completed', resumedRunId: 'resumed-run' }, 'worker1'), { refused: 'invalid-epoch' });
    }
    assert.equal(f.call('summary').status, 'claimed');
    assert.equal(f.call('complete', { epoch: claim.epoch, outcome: 'completed', resumedRunId: 'resumed-run' }, 'worker1').completed, true);
    assert.deepEqual(f.call('complete', { epoch: true, outcome: 'completed', resumedRunId: 'resumed-run' }, 'worker1'), { refused: 'invalid-epoch' });
    f.store.close();
    assert.deepEqual(f.call('admit', { epoch: false }, 'worker1'), { refused: 'invalid-epoch' });
    assert.deepEqual(f.call('admit', { epoch: 1 }, 'worker1'), { refused: 'storage-unavailable' });
  }));

  test('authorization precedes lookups, duplicate returns and private checkpoint reads', () => fixture((f) => {
    decide(f); const claim = f.call('claim', {}, 'worker1');
    assert.equal(f.call('claim', {}, 'worker2').refused, 'active-lease');
    assert.equal(f.call('admit', { epoch: claim.epoch }, 'worker2').refused, 'worker-binding');
    for (const actor of ['intruder', 'constructor', '__proto__', 'receiver'])
      assert.deepEqual(f.call('admit', { epoch: claim.epoch }, actor), { refused: 'unauthorized' });
    assert.deepEqual(f.call('summary', { key: 'foreign/workflow/operation/1' }), { refused: 'unauthorized' });
    let getterCalls = 0;
    const input = Object.defineProperty({}, 'key', { get() { getterCalls++; return KEY; } });
    assert.deepEqual(f.store.execute('summary', input, 'host'), { refused: 'unauthorized' });
    assert.equal(getterCalls, 0);
    f.store.close();
    assert.deepEqual(f.call('publish', prepared(), 'intruder'), { refused: 'unauthorized' });
    assert.deepEqual(f.call('summary', {}, '__proto__'), { refused: 'unauthorized' });
  }));

  test('non-enumerable own data is refused at request and identity boundaries', () => fixture((f) => {
    const hiddenKey = { key: KEY, ...prepared() };
    Object.defineProperty(hiddenKey, 'key', { value: KEY, enumerable: false });
    const keyResult = f.store.execute('publish', hiddenKey, 'host');
    const hiddenBody = { key: KEY, deliveryId: 'hidden-body', body: PRIVATE };
    Object.defineProperty(hiddenBody, 'body', { value: PRIVATE, enumerable: false });
    const bodyResult = f.store.execute('reply', hiddenBody, 'receiver');
    const hiddenIdentity = { ...IDENTITY };
    Object.defineProperty(hiddenIdentity, 'programDigest', { value: IDENTITY.programDigest, enumerable: false });
    let identityRefused = false;
    try { f.open(hiddenIdentity); } catch (error) { identityRefused = error.message === 'InvalidHostIdentity'; }
    assert.ok(keyResult.refused === 'invalid-request' && bodyResult.refused === 'invalid-request' && identityRefused,
      'enumerable-data-boundary');
    assert.equal(f.call('summary').status, 'unpublished');
  }));

  test('task ownership and selected task identity are checked as well as wait ownership', () => fixture((f) => {
    decide(f); const claim = f.call('claim', {}, 'worker1');
    f.raw((db) => db.prepare('UPDATE tasks SET worker=? WHERE key=?').run('worker2', KEY));
    assert.equal(f.call('admit', { epoch: claim.epoch }, 'worker1').refused, 'worker-binding');
    f.raw((db) => db.prepare('UPDATE tasks SET worker=?,epoch=? WHERE key=?').run('worker1', 2, KEY));
    assert.equal(f.call('admit', { epoch: claim.epoch }, 'worker1').refused, 'stale-or-expired');
    f.raw((db) => db.prepare('UPDATE tasks SET task_id=? WHERE key=?').run('foreign-task', KEY));
    assert.equal(f.call('admit', { epoch: claim.epoch }, 'worker1').refused, 'no-task');
  }));

  test('claim and completion cannot replenish the original business expiry', () => fixture((f) => {
    decide(f, { businessExpiry: 32 });
    const claim = f.call('claim', {}, 'worker1'); assert.equal(claim.lease, 32);
    f.call('tick', { to: 32 });
    assert.equal(f.call('admit', { epoch: claim.epoch }, 'worker1').refused, 'stale-or-expired');
    assert.equal(f.call('complete', { epoch: claim.epoch, outcome: 'completed', resumedRunId: 'resumed-run' }, 'worker1').refused, 'stale-or-expired');
    assert.equal(f.call('claim', {}, 'worker2').refused, 'business-expired');
    assert.equal(f.call('summary').outcome, null);
  }));

  test('receipt capacity retains winner and deduplication rather than deleting history', () => fixture((f) => {
    f.call('publish', prepared());
    for (let i = 0; i < 4; i++) assert.equal(f.call('reply', { deliveryId: `reply-${i}`, body: PRIVATE }, 'receiver').admitted, true);
    assert.equal(f.call('reply', { deliveryId: 'overflow', body: PRIVATE }, 'receiver').refused, 'capacity-retain-evidence');
    assert.deepEqual(f.call('reply', { deliveryId: 'reply-0', body: PRIVATE }, 'receiver'), { duplicate: true });
    assert.deepEqual(f.call('summary').winner, { kind: 'reply', receiptRef: 'reply-0' });
    assert.equal(f.call('summary').inboxCount, 4);
    assert.equal(f.call('reply', { deliveryId: 'large', body: '🧸'.repeat(65) }, 'receiver').refused, 'receipt-bounds');
    assert.equal(f.call('reply', { deliveryId: 'https://capability.invalid/token', body: 'x' }, 'receiver').refused, 'receipt-bounds');
    assert.equal(f.call('publish', prepared({ checkpointWire: 'x'.repeat(65537), checkpointDigest: sha256('x'.repeat(65537)) })).refused, 'invalid-publication');
    conflictingReceipt(SOURCE);
  }));

  test('failed execution stays failed; its safe native reference is preserved without inferring a stage', () => fixture((f) => {
    decide(f); const claim = f.call('claim', {}, 'worker1');
    const failureRef = { runId: 'resumed-native-run', runtimeStageId: 'continue#2', category: 'internal' };
    const result = { epoch: claim.epoch, outcome: 'failed', resumedRunId: failureRef.runId, failureRef };
    assert.deepEqual(f.call('complete', result, 'worker1'), { completed: true });
    f.call('tick', { to: 100 });
    assert.deepEqual(f.call('complete', result, 'worker1'), { duplicate: true });
    const summary = f.call('summary');
    assert.equal(summary.outcome, 'failed'); assert.deepEqual(summary.failureRef, failureRef);
    assert.equal(f.call('complete', { ...result, outcome: 'completed' }, 'worker1').refused, 'unsupported-outcome');
    assert.equal(f.call('complete', { ...result, resumedRunId: 'another-native-run', failureRef: { runId: 'another-native-run' } }, 'worker1').refused, 'conflicting-result');
    assert.equal(JSON.stringify(summary).includes(PRIVATE), false);
  }));

  test('raw errors, wrong failure owners and next checkpoints are refused before terminal publication', () => fixture((f) => {
    decide(f); const claim = f.call('claim', {}, 'worker1');
    const basic = { epoch: claim.epoch, outcome: 'failed', resumedRunId: 'resumed-native-run' };
    assert.equal(f.call('complete', { ...basic, failureRef: { runId: 'other-run' } }, 'worker1').refused, 'unsupported-outcome');
    assert.equal(f.call('complete', { ...basic, failureRef: { runId: basic.resumedRunId, rawError: PRIVATE } }, 'worker1').refused, 'unsupported-outcome');
    assert.equal(f.call('complete', { ...basic, nextCheckpoint: PRIVATE }, 'worker1').refused, 'invalid-request');
    assert.equal(f.call('summary').outcome, null);
    assert.equal(f.call('complete', basic, 'worker1').completed, true);
    assert.equal(f.call('summary').failureRef, null);
  }));

  test('SDK/program identity changes and corrupted checkpoint bytes refuse admission', () => fixture((f) => {
    decide(f); const claim = f.call('claim', {}, 'worker1');
    for (const changed of [{ programDigest: '3'.repeat(64) }, { sdkDigest: '4'.repeat(64) }, { sdkVersion: '12.3.1' }, { mode: 'built' }]) {
      const other = f.open({ ...IDENTITY, ...changed });
      assert.equal(other.execute('admit', { key: KEY, epoch: claim.epoch }, 'worker1').refused, 'identity-mismatch');
    }
    f.raw((db) => db.prepare('UPDATE waits SET checkpoint_wire=? WHERE key=?').run('changed-private-bytes', KEY));
    assert.equal(f.call('admit', { epoch: claim.epoch }, 'worker1').refused, 'checkpoint-mismatch');
    assert.equal(f.call('summary').refused, 'checkpoint-mismatch');
  }));

  test('malformed retained winner cannot leak private data through a summary', () => fixture((f) => {
    decide(f);
    f.raw((db) => db.prepare('UPDATE waits SET winner=? WHERE key=?').run(JSON.stringify({ kind: 'timer', dueAt: 30, raw: PRIVATE }), KEY));
    const summary = f.call('summary');
    assert.deepEqual(summary, { refused: 'checkpoint-mismatch' });
    assert.equal(JSON.stringify(summary).includes(PRIVATE), false);
  }));

  test('storage errors remain unknown and never appear as an empty successful read', () => fixture((f) => {
    f.raw((db) => db.exec('DROP TABLE clock'));
    assert.deepEqual(f.call('summary'), { refused: 'storage-unavailable' });
    const absent = path.join(f.directory, 'absent.sqlite');
    assert.throws(() => new f.Store(absent, IDENTITY), { message: 'HostStoreUnavailable' });
    assert.equal(fs.existsSync(absent), false);
  }));

  test('the owned database and WAL are private, and unsafe directories/symlinks are refused', () => fixture((f) => {
    assert.equal(fs.statSync(f.filename).mode & 0o077, 0);
    assert.equal(fs.statSync(f.filename + '-wal').mode & 0o077, 0);
    const link = path.join(f.directory, 'alias.sqlite'); fs.symlinkSync(f.filename, link);
    assert.throws(() => new f.Store(link, IDENTITY), { message: 'HostStoreUnavailable' });
    const unsafe = path.join(f.directory, 'unsafe'); fs.mkdirSync(unsafe, { mode: 0o755 });
    assert.throws(() => new f.Store(path.join(unsafe, 'host.sqlite'), IDENTITY, { initialize: true }), { message: 'HostStoreUnavailable' });
  }));
}
