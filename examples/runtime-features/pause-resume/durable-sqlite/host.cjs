'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { ROOT, fromRoot, trustedIdentity, refusal, privatePaths } = require('./identity.cjs');
const { isSafeCode } = require('./codes.cjs');

const PUBLIC_FIELDS = new Set(['pid', 'initialized', 'sdkVersion', 'mode', 'identity', 'nodeVersion', 'sqliteVersion', 'published',
  'duplicate', 'refused', 'failed', 'clock', 'admitted', 'checked', 'claimed', 'epoch', 'lease',
  'status', 'winner', 'hostNow', 'taskCount', 'outboxCount', 'inboxCount', 'pausedRunId',
  'resumedRunId', 'outcome', 'failureRef', 'pausedStageId', 'checkpointDigest', 'nativeCheckpointVersion',
  'pausedRuntimeStageId', 'nativeResumedFrom', 'nativeResumeRunId', 'nativeLinkObserved',
  'newNativeRunId', 'effects', 'nativeTimeoutMs', 'remainingBusinessMs', 'originalErrorPreserved',
  'completed', 'corruptedFixture']);

class Driver {
  constructor(mode) {
    this.mode = mode;
    this.active = new Set();
    this.directories = [];
    this.exits = [];
    this.deadline = performance.now() + 100_000;
    this.identity = trustedIdentity(mode, 'terminal');
  }

  launch(context, op, principal = 'host', data = {}, expectedSignal = null, expectedCode = 0) {
    if (performance.now() >= this.deadline) throw refusal('SCENARIO_BUDGET_EXPIRED');
    const loader = this.mode === 'source' ? ['--require', fromRoot.resolve('tsx/cjs')] : [];
    const child = spawn(process.execPath, [...loader, path.join(__dirname, 'worker.cjs'), this.mode,
      context.db, op, principal, context.variant], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? os.defpath ?? '/usr/bin:/bin', TSX_DISABLE_CACHE: '1',
        TSX_TSCONFIG_PATH: path.join(ROOT, 'examples/tsconfig.json') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.active.add(child);
    const done = new Promise((resolve, reject) => {
      let output = '', errors = '', settled = false;
      const stop = (code) => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(refusal(code));
      };
      const timeout = setTimeout(() => stop('OWNED_CHILD_TIMEOUT'), 15_000);
      child.stdout.setEncoding('utf8').on('data', (bytes) => {
        output += bytes;
        if (Buffer.byteLength(output) > 16 * 1024) stop('CHILD_OUTPUT_BOUNDS');
      });
      child.stderr.setEncoding('utf8').on('data', (bytes) => {
        errors += bytes;
        if (Buffer.byteLength(errors) > 16 * 1024) stop('CHILD_OUTPUT_BOUNDS');
      });
      child.on('error', () => stop('OWNED_CHILD_START_FAILED'));
      child.on('close', (code, signal) => {
        clearTimeout(timeout);
        this.active.delete(child);
        this.exits.push({ case: context.name, operation: op, pid: child.pid, code, signal, expectedSignal, expectedCode });
        if (settled) return;
        settled = true;
        if (code !== expectedCode || signal !== expectedSignal) return reject(refusal('OWNED_CHILD_EXIT_MISMATCH'));
        if (/PRIVATE-NATIVE-CHECKPOINT-SENTINEL|checkpointWire|privateToken/.test(output + errors)) {
          return reject(refusal('PRIVATE_OUTPUT_REFUSED'));
        }
        if (expectedSignal) return resolve({ deliberatelyKilled: true });
        let result;
        try { result = JSON.parse(output); } catch { return reject(refusal('CHILD_RESULT_JSON')); }
        if (!result || typeof result !== 'object' || Array.isArray(result)
            || Object.keys(result).some((key) => !PUBLIC_FIELDS.has(key))) return reject(refusal('CHILD_RESULT_SHAPE'));
        if (result.failed && !isSafeCode(result.failed)) return reject(refusal('CHILD_RESULT_SHAPE'));
        if (result.failed && expectedCode === 0) return reject(refusal(result.failed));
        resolve(result);
      });
      child.stdin.on('error', () => {}); // A deliberate SIGKILL can close an already-owned input pipe.
      child.stdin.end(JSON.stringify(data));
    });
    // A held child can fail while the parent awaits its readiness file. Keep
    // that rejection handled until the caller awaits the original promise.
    done.catch(() => {});
    return { child, done };
  }

  call(context, op, principal = 'host', data = {}, expectedSignal = null, expectedCode = 0) {
    return this.launch(context, op, principal, data, expectedSignal, expectedCode).done;
  }

  async setup(name, variant = 'terminal', expiry = 1000) {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-native-host-')));
    fs.chmodSync(directory, 0o700);
    this.directories.push(directory);
    const context = { name, directory, db: path.join(directory, 'host.sqlite'), variant };
    const initialized = await this.call(context, 'init');
    const runtime = { node: initialized.nodeVersion, sqlite: initialized.sqliteVersion };
    if (this.runtime) assert.deepEqual(runtime, this.runtime, 'NATIVE_RUNTIME_CHANGED');
    else this.runtime = runtime;
    const paused = await this.call(context, 'produce', 'host', { businessExpiry: expiry });
    assert.equal(paused.published, true, 'NATIVE_CHECKPOINT_NOT_PUBLISHED');
    assert.equal(paused.nativeCheckpointVersion, 2, 'NATIVE_CHECKPOINT_FORMAT');
    context.paused = paused;
    return context;
  }

  async decideTimer(context) {
    await this.call(context, 'tick', 'host', { to: 30 });
    await this.call(context, 'due');
    const claim = await this.call(context, 'claim', 'worker1');
    assert.equal(claim.claimed, true, 'NATIVE_TASK_NOT_CLAIMED');
    return claim;
  }

  async summary(context) {
    return this.call(context, 'summary');
  }

  effectCount(context) {
    const paths = privatePaths(context.db);
    if (!fs.existsSync(paths.effects)) return 0;
    return fs.readFileSync(paths.effects, 'utf8').trim().split('\n').filter(Boolean).length;
  }

  async waitForReady(context) {
    const paths = privatePaths(context.db);
    const until = performance.now() + 12_000;
    while (!fs.existsSync(paths.ready)) {
      if (performance.now() >= until) throw refusal('OWNED_GATE_TIMEOUT');
      await delay(5);
    }
    return JSON.parse(fs.readFileSync(paths.ready, 'utf8'));
  }

  async close() {
    const live = [...this.active];
    await Promise.all(live.map((child) => new Promise((resolve) => {
      child.once('close', resolve);
      child.kill('SIGKILL');
    })));
    for (const directory of this.directories) fs.rmSync(directory, { recursive: true });
    assert.equal(this.active.size, 0, 'OWNED_CHILD_REMAINED');
    assert.ok(this.directories.every((directory) => !fs.existsSync(directory)), 'PRIVATE_SCRATCH_REMAINED');
  }
}

async function happy(driver, kind) {
  const context = await driver.setup(kind);
  if (kind === 'reply') {
    await driver.call(context, 'tick', 'host', { to: 12 });
    await driver.call(context, 'reply', 'receiver', { deliveryId: 'reply1', body: 'safe-synthetic' });
  } else {
    await driver.call(context, 'tick', 'host', { to: 30 });
    await driver.call(context, 'due');
  }
  const claim = await driver.call(context, 'claim', 'worker1');
  const result = await driver.call(context, 'resume', 'worker1', { epoch: claim.epoch });
  assert.equal(result.completed, true, 'NATIVE_CONTINUATION_NOT_COMMITTED');
  assert.equal(result.newNativeRunId, true, 'NATIVE_RUN_NOT_NEW');
  assert.equal(result.pausedRunId, context.paused.pausedRunId, 'PAUSED_LINK_CHANGED');
  assert.deepEqual(result.nativeResumedFrom, { runId: context.paused.pausedRunId,
    runtimeStageId: context.paused.pausedRuntimeStageId }, 'NATIVE_PAUSE_LINK_CHANGED');
  assert.equal(result.nativeResumeRunId, result.resumedRunId, 'NATIVE_RESUME_EVENT_RUN_CHANGED');
  assert.notEqual(result.pid, context.paused.pid, 'PRODUCER_PROCESS_REUSED');
  assert.equal(result.outcome, kind === 'reply' ? 'reply-recorded' : 'waiting-ended', 'WRONG_NATIVE_BRANCH');
  assert.ok(result.nativeTimeoutMs <= result.remainingBusinessMs, 'BUSINESS_BUDGET_REPLENISHED');
  const saved = await driver.summary(context);
  assert.equal(saved.taskCount, 1); assert.equal(saved.outboxCount, 1);
  assert.equal(saved.resumedRunId, result.resumedRunId); assert.equal(saved.winner.kind, kind);
  return { case: kind, freshProcess: true, newNativeRunId: true, retainedPausedLink: true,
    checkpointDigest: context.paused.checkpointDigest, taskCount: saved.taskCount, outcome: result.outcome };
}

async function tampering(driver) {
  const results = [];
  for (const field of ['wire', 'program', 'sdk', 'format', 'pause-link']) {
    const context = await driver.setup(`tamper-${field}`);
    const claim = await driver.decideTimer(context);
    await driver.call(context, 'tamper', 'host', { field });
    const nativeShape = ['format', 'pause-link'].includes(field);
    const result = await driver.call(context, 'resume', 'worker1', { epoch: claim.epoch }, null, nativeShape ? 1 : 0);
    assert.equal(nativeShape ? result.failed : result.refused,
      nativeShape ? 'CHECKPOINT_BINDING' : field === 'wire' ? 'checkpoint-mismatch' : 'identity-mismatch');
    assert.equal(driver.effectCount(context), 0, 'EFFECT_BEFORE_BINDING_ADMISSION');
    results.push({ field, refusedBeforeEffect: true });
  }
  return { case: 'checkpoint-program-sdk-format-refusals', results };
}

async function replay(driver, held) {
  const context = await driver.setup(held ? 'stale-after-native-effect' : 'crash-after-native-effect');
  const first = await driver.decideTimer(context);
  let stale;
  if (held) {
    const pending = driver.launch(context, 'resume-hold', 'worker1', { epoch: first.epoch });
    const ready = await driver.waitForReady(context);
    await driver.call(context, 'tick', 'host', { to: 35 });
    const second = await driver.call(context, 'claim', 'worker2');
    fs.writeFileSync(path.join(context.directory, 'release'), 'release', { mode: 0o600, flag: 'wx' });
    stale = await pending.done;
    assert.equal(stale.refused, 'worker-binding', 'STALE_NATIVE_RESULT_ACCEPTED');
    assert.equal(stale.resumedRunId, ready.resumedRunId);
    const recovered = await driver.call(context, 'resume', 'worker2', { epoch: second.epoch });
    assert.equal(recovered.completed, true);
  } else {
    await driver.call(context, 'resume-crash', 'worker1', { epoch: first.epoch }, 'SIGKILL', null);
    assert.equal(driver.effectCount(context), 1, 'NATIVE_EFFECT_NOT_RECORDED_BEFORE_KILL');
    await driver.call(context, 'tick', 'host', { to: 35 });
    const second = await driver.call(context, 'claim', 'worker2');
    assert.equal(second.epoch, first.epoch + 1);
    const staleAdmission = await driver.call(context, 'resume', 'worker1', { epoch: first.epoch });
    assert.equal(staleAdmission.refused, 'worker-binding');
    assert.equal(driver.effectCount(context), 1, 'STALE_WORKER_RAN_NATIVE_EFFECT');
    assert.equal((await driver.call(context, 'resume', 'worker2', { epoch: second.epoch })).completed, true);
  }
  const saved = await driver.summary(context);
  assert.equal(driver.effectCount(context), 2); assert.equal(saved.taskCount, 1);
  assert.equal(saved.winner.kind, 'timer'); assert.equal(saved.epoch, 2);
  return { case: context.name, physicalSyntheticEffects: 2, logicalTasks: 1,
    stalePublicationRefused: held, staleAdmissionRefused: !held, exactlyOnceOutsideExecution: false };
}

async function boundaries(driver) {
  const context = await driver.setup('original-expiry', 'terminal', 32);
  const claim = await driver.decideTimer(context);
  await driver.call(context, 'tick', 'host', { to: 32 });
  const expired = await driver.call(context, 'resume', 'worker1', { epoch: claim.epoch });
  assert.equal(expired.refused, 'stale-or-expired'); assert.equal(driver.effectCount(context), 0);
  const repause = await driver.setup('unsupported-next-pause', 'repause');
  const pauseClaim = await driver.decideTimer(repause);
  const paused = await driver.call(repause, 'resume', 'worker1', { epoch: pauseClaim.epoch });
  assert.equal(paused.refused, 'unsupported-next-pause');
  assert.equal((await driver.summary(repause)).status, 'claimed');
  const failure = await driver.setup('native-failure');
  const failureClaim = await driver.decideTimer(failure);
  const failed = await driver.call(failure, 'resume-fail', 'worker1', { epoch: failureClaim.epoch });
  assert.equal(failed.completed, true); assert.equal(failed.outcome, 'failed');
  assert.equal(failed.originalErrorPreserved, true);
  assert.equal(failed.failureRef.runId, failed.resumedRunId);
  assert.match(failed.failureRef.runtimeStageId, /^continue#/);
  const saved = await driver.summary(failure);
  assert.equal(saved.outcome, 'failed'); assert.equal(saved.failureRef.runId, failed.resumedRunId);
  return { case: 'expiry-next-pause-native-failure', expiredBeforeEffect: true,
    nextPauseNotCompletion: true, nativeFailureIdentified: true, originalLiveErrorPreserved: true };
}

async function runExample({ mode = 'built' } = {}) {
  const driver = new Driver(mode);
  let cases;
  try {
    cases = [await happy(driver, 'reply'), await happy(driver, 'timer'), await tampering(driver),
      await replay(driver, false), await replay(driver, true), await boundaries(driver)];
    assert.deepEqual(trustedIdentity(mode, 'terminal'), driver.identity, 'ARTIFACTS_CHANGED_DURING_PROOF');
  } finally { await driver.close(); }
  return { mode, sdkVersion: driver.identity.sdkVersion, identity: driver.identity, runtime: driver.runtime, cases,
    childExits: driver.exits, ownedChildrenExited: driver.exits.length, privateScratchRemoved: true,
    limits: ['Fixed test principals and injected clock; no production authorization or scheduler',
      'One static generation; next pauses are refused; no nested or parallel wait support',
      'No provider, delivery, cancellation, deduplication, power-loss or semantic root-cause guarantee',
      'Native pause linkage is retained; historical read ancestry across resumes is not inferred'] };
}

module.exports = { runExample };
