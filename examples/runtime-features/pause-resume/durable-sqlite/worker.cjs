'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('./store.cjs');
const { trustedIdentity, privatePaths, loadSdk, sha, refusal, nativeCheckpoint } = require('./identity.cjs');
const programs = require('./workflow.cjs');
const { safeFailure } = require('./codes.cjs');

const KEY = 'tenant/workflow/operation/1';
const RUN_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const CATEGORIES = ['timeout', 'rate-limited', 'server', 'network', 'auth', 'permanent', 'unknown'];
const allowed = {
  init: [], produce: ['businessExpiry'], tick: ['to'], reply: ['deliveryId', 'body'],
  due: [], claim: [], summary: [], resume: ['epoch'], 'resume-crash': ['epoch'],
  'resume-hold': ['epoch'], 'resume-fail': ['epoch'], tamper: ['field'],
};

async function input(op) {
  let wire = '';
  for await (const bytes of process.stdin) {
    wire += bytes;
    if (Buffer.byteLength(wire) > 2048) throw refusal('INPUT_BOUNDS');
  }
  let value;
  try { value = JSON.parse(wire); } catch { throw refusal('INPUT_JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => !allowed[op].includes(key))) throw refusal('INPUT_SHAPE');
  return value;
}

function appendEffect(paths, value) {
  privatePaths(paths.dbPath);
  if (fs.existsSync(paths.effects) && fs.statSync(paths.effects).size > 8192) throw refusal('EFFECT_BOUNDS');
  const file = fs.openSync(paths.effects,
    fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeSync(file, JSON.stringify(value) + '\n'); fs.fsyncSync(file); }
  finally { fs.closeSync(file); }
}

function holdForParent(paths, resumedRunId) {
  fs.writeFileSync(paths.ready, JSON.stringify({ resumedRunId }), { mode: 0o600, flag: 'wx' });
  const until = performance.now() + 10_000;
  while (!fs.existsSync(paths.release)) {
    if (performance.now() >= until) throw refusal('OWNED_GATE_TIMEOUT');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  privatePaths(paths.dbPath);
}

// Test-only corruption of this owned private database, never a public mutation API.
function tamper(paths, field) {
  const db = new DatabaseSync(paths.dbPath);
  try {
    const row = db.prepare('SELECT * FROM waits WHERE key=?').get(KEY);
    if (!row) throw refusal('TAMPER_FIXTURE_MISSING');
    if (field === 'wire') {
      db.prepare('UPDATE waits SET checkpoint_wire=? WHERE key=?').run(row.checkpoint_wire + ' ', KEY);
    } else if (['program', 'sdk'].includes(field)) {
      const immutable = JSON.parse(row.immutable);
      const identity = JSON.parse(immutable.identity);
      identity[field === 'program' ? 'programDigest' : 'sdkDigest'] = '0'.repeat(64);
      immutable.identity = JSON.stringify(identity);
      db.prepare('UPDATE waits SET immutable=? WHERE key=?').run(JSON.stringify(immutable), KEY);
    } else if (['format', 'pause-link'].includes(field)) {
      const checkpoint = JSON.parse(row.checkpoint_wire);
      if (field === 'format') checkpoint.checkpointVersion = 999;
      else delete checkpoint.pausedExecution.runtimeStageId;
      const wire = JSON.stringify(checkpoint);
      const immutable = JSON.parse(row.immutable);
      immutable.checkpointDigest = sha(wire);
      db.prepare('UPDATE waits SET checkpoint_wire=?,checkpoint_digest=?,immutable=? WHERE key=?')
        .run(wire, sha(wire), JSON.stringify(immutable), KEY);
    } else throw refusal('TAMPER_CASE_UNSUPPORTED');
  } finally { db.close(); }
  return { corruptedFixture: true };
}

function executor(sdk, variant, effect) {
  const value = new sdk.FlowChartExecutor(programs[variant](sdk, effect));
  value.enableNarrative();
  value.setRedactionPolicy({ keys: ['privateToken'] });
  return value;
}

async function produce(store, sdk, variant, args) {
  const value = executor(sdk, variant, () => { throw refusal('EFFECT_BEFORE_PUBLICATION'); });
  let pausedEvent;
  value.attachFlowRecorder({ id: 'private-host-pause-link', onPause: (event) => { pausedEvent = event.traversalContext; } });
  await value.run();
  if (!value.isPaused()) throw refusal('NATIVE_PAUSE_MISSING');
  const checkpoint = value.getCheckpoint();
  const wire = JSON.stringify(checkpoint);
  const binding = { key: KEY, checkpointWire: wire, checkpointDigest: sha(wire),
    pausedRunId: checkpoint.pausedExecution?.runId, pausedStageId: checkpoint.pausedStageId,
    dueAt: 30, businessExpiry: args.businessExpiry ?? 1000 };
  nativeCheckpoint(wire, binding);
  if (!RUN_ID.test(binding.pausedRunId) || !/^wait#[0-9]+$/.test(checkpoint.pausedExecution.runtimeStageId)) {
    throw refusal('NATIVE_REFERENCE_UNSUPPORTED');
  }
  if (pausedEvent?.runId !== checkpoint.pausedExecution.runId
      || pausedEvent?.runtimeStageId !== checkpoint.pausedExecution.runtimeStageId) {
    throw refusal('NATIVE_PAUSE_REFERENCE_MISSING');
  }
  const published = store.execute('publish', binding, 'host');
  return { ...published, pausedRunId: binding.pausedRunId, pausedStageId: binding.pausedStageId,
    pausedRuntimeStageId: pausedEvent.runtimeStageId,
    checkpointDigest: binding.checkpointDigest, nativeCheckpointVersion: checkpoint.checkpointVersion };
}

async function resume(store, sdk, variant, principal, args, op, paths) {
  const admittedAt = performance.now();
  const admitted = store.execute('admit', { key: KEY, epoch: args.epoch }, principal);
  if (admitted.refused) return admitted;
  const checkpoint = nativeCheckpoint(admitted.checkpointWire, admitted);
  const originalError = new Error('SYNTHETIC_CONTINUATION_FAILURE');
  let effects = 0;
  const value = executor(sdk, variant, (receipt) => {
    appendEffect(paths, { kind: receipt.kind, epoch: args.epoch });
    effects++;
    if (op === 'resume-crash') process.kill(process.pid, 'SIGKILL');
    if (op === 'resume-fail') throw originalError;
  });
  let resumedEvent;
  value.attachFlowRecorder({ id: 'private-host-resume-link', onResume: (event) => { resumedEvent = event.traversalContext; } });
  const nativeTimeoutMs = Math.floor(Math.min(1000, admitted.remainingMs - (performance.now() - admittedAt)));
  if (nativeTimeoutMs <= 0) return { refused: 'local-budget-expired' };
  let originalErrorPreserved = false;
  try { await value.resume(checkpoint, admitted.winner, { timeoutMs: nativeTimeoutMs }); }
  catch (error) {
    if (error !== originalError) throw refusal('NATIVE_RESUME_FAILED');
    originalErrorPreserved = true;
  }
  const snapshot = value.getSnapshot();
  if (!RUN_ID.test(snapshot.runId)) throw refusal('NATIVE_REFERENCE_UNSUPPORTED');
  if (snapshot.runId === admitted.pausedRunId) throw refusal('NATIVE_RUN_ID_REUSED');
  if (resumedEvent?.runId !== snapshot.runId
      || resumedEvent?.resumedFrom?.runId !== checkpoint.pausedExecution.runId
      || resumedEvent?.resumedFrom?.runtimeStageId !== checkpoint.pausedExecution.runtimeStageId) {
    throw refusal('NATIVE_PAUSE_LINK_MISSING');
  }
  const facts = { pausedRunId: admitted.pausedRunId, resumedRunId: snapshot.runId,
    pausedStageId: admitted.pausedStageId, effects, nativeTimeoutMs,
    remainingBusinessMs: admitted.remainingMs, newNativeRunId: true,
    nativeResumedFrom: { runId: resumedEvent.resumedFrom.runId, runtimeStageId: resumedEvent.resumedFrom.runtimeStageId },
    nativeResumeRunId: resumedEvent.runId, nativeLinkObserved: true };
  if (value.isPaused()) return { ...facts, refused: 'unsupported-next-pause' };
  if (!originalErrorPreserved && snapshot.sharedState.continued !== true) throw refusal('CONTINUATION_MISSING');
  const failure = value.getFailureContext();
  const failureRef = originalErrorPreserved && failure?.stage?.runId === snapshot.runId
    ? { runId: failure.stage.runId, ...(failure.stage.runtimeStageId ? { runtimeStageId: failure.stage.runtimeStageId } : {}),
      ...(failure.category ? { category: failure.category } : {}) } : undefined;
  if (originalErrorPreserved && !failureRef) throw refusal('NATIVE_FAILURE_REFERENCE_MISSING');
  if (failureRef && (!/^continue#[0-9]+$/.test(failureRef.runtimeStageId)
      || !CATEGORIES.includes(failureRef.category))) throw refusal('NATIVE_REFERENCE_UNSUPPORTED');
  const outcome = originalErrorPreserved ? 'failed' : snapshot.sharedState.outcome;
  if (!['failed', 'reply-recorded', 'waiting-ended'].includes(outcome)) throw refusal('NATIVE_OUTCOME_UNSUPPORTED');
  if (op === 'resume-hold') holdForParent(paths, snapshot.runId);
  const result = store.execute('complete', { key: KEY, epoch: args.epoch,
    outcome: originalErrorPreserved ? 'failed' : 'completed', resumedRunId: snapshot.runId,
    ...(failureRef ? { failureRef } : {}) }, principal);
  return { ...result, ...facts, outcome,
    originalErrorPreserved, ...(failureRef ? { failureRef } : {}) };
}

async function main() {
  process.umask(0o077);
  const [mode, dbPath, op, principal, variant] = process.argv.slice(2);
  if (!Object.hasOwn(allowed, op)) throw refusal('OPERATION_UNSUPPORTED');
  const paths = privatePaths(dbPath, op === 'init');
  const identity = trustedIdentity(mode, variant);
  const args = await input(op);
  const sdk = op === 'produce' || op.startsWith('resume') ? loadSdk(mode) : undefined;
  if (op === 'tamper') {
    if (principal !== 'host') return { refused: 'unauthorized' };
    return tamper(paths, args.field);
  }
  const store = new Store(dbPath, identity, { initialize: op === 'init' });
  try {
    if (op === 'init') return { initialized: true, sdkVersion: identity.sdkVersion, mode, identity,
      nodeVersion: process.versions.node, sqliteVersion: process.versions.sqlite };
    if (op === 'produce') {
      if (principal !== 'host') return { refused: 'unauthorized' };
      return await produce(store, sdk, variant, args);
    }
    if (op.startsWith('resume')) return await resume(store, sdk, variant, principal, args, op, paths);
    return store.execute(op, { key: KEY, ...args }, principal);
  } finally { store.close(); }
}

main().then((result) => {
  const output = JSON.stringify({ ...result, pid: process.pid });
  if (Buffer.byteLength(output) > 16 * 1024 || output.includes('PRIVATE-NATIVE-CHECKPOINT-SENTINEL')) {
    throw refusal('PUBLIC_OUTPUT_REFUSED');
  }
  process.stdout.write(output);
}).catch((error) => {
  const code = safeFailure(error);
  process.stdout.write(JSON.stringify({ failed: code, pid: process.pid }));
  process.exitCode = 1;
});
