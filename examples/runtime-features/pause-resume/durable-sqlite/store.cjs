'use strict';

// Private, single-generation example adapter. Principals and the clock below are
// fixture policy, not production authentication, scheduling or clock authority.
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const KEY = 'tenant/workflow/operation/1';
const TASK = `${KEY}/resume`;
const MAX_CHECKPOINT_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = MAX_CHECKPOINT_BYTES + 4096;
const HEX = /^[a-f0-9]{64}$/;
const SAFE_REF = /^[A-Za-z0-9_.:-]{1,128}$/;
const DELIVERY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const OPERATIONS = Object.freeze({
  host: new Set(['publish', 'due', 'tick', 'summary']),
  receiver: new Set(['reply']),
  worker1: new Set(['claim', 'admit', 'complete']),
  worker2: new Set(['claim', 'admit', 'complete']),
});
const FIELDS = Object.freeze({
  publish: ['key', 'checkpointWire', 'checkpointDigest', 'pausedRunId', 'pausedStageId', 'dueAt', 'businessExpiry'],
  reply: ['key', 'deliveryId', 'body'],
  tick: ['key', 'to'],
  due: ['key'],
  summary: ['key'],
  claim: ['key'],
  admit: ['key', 'epoch'],
  complete: ['key', 'epoch', 'outcome', 'resumedRunId'],
});

const refused = (code) => ({ refused: code });
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const safeOrdinal = (value) => Number.isSafeInteger(value) && value > 0;
const safeClock = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 10000;

class Refusal extends Error {
  constructor(code) { super(code); this.code = code; }
}

function dataObject(value, keys, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  return ownKeys.length >= keys.length && ownKeys.length <= keys.length + optional.length
    && ownKeys.every((key) => typeof key === 'string' && [...keys, ...optional].includes(key)
      && Object.hasOwn(descriptors[key], 'value') && descriptors[key].enumerable === true)
    && keys.every((key) => Object.hasOwn(descriptors, key));
}

function identityWire(identity) {
  const keys = ['programDigest', 'sdkDigest', 'sdkVersion', 'mode'];
  if (!dataObject(identity, keys) || typeof identity.programDigest !== 'string' || !HEX.test(identity.programDigest)
      || typeof identity.sdkDigest !== 'string' || !HEX.test(identity.sdkDigest)
      || typeof identity.sdkVersion !== 'string' || identity.sdkVersion.length > 64
      || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(identity.sdkVersion)
      || !['source', 'built'].includes(identity.mode)) throw new Error('InvalidHostIdentity');
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, identity[key]])));
}

function requestShape(op, args, principal) {
  // A key or epoch is not a credential. These fixed principals only model an
  // already authenticated and workflow-scoped caller for the example.
  const key = args && typeof args === 'object' && Object.getOwnPropertyDescriptor(args, 'key');
  if (typeof principal !== 'string' || !Object.hasOwn(OPERATIONS, principal) || !OPERATIONS[principal].has(op)
      || !key || !Object.hasOwn(key, 'value') || key.value !== KEY)
    return 'unauthorized';
  if (!dataObject(args, FIELDS[op], op === 'complete' ? ['failureRef'] : [])) return 'invalid-request';
  if (Object.entries(args).some(([key, value]) => key !== 'failureRef' && !['string', 'number'].includes(typeof value)))
    return op === 'admit' || op === 'complete' ? 'invalid-epoch' : 'invalid-request';
  if ((op === 'admit' || op === 'complete') && !safeOrdinal(args.epoch)) return 'invalid-epoch';
  if (op === 'complete' && failureWire(args) === undefined) return 'unsupported-outcome';
  if (Buffer.byteLength(JSON.stringify(args)) > MAX_REQUEST_BYTES) return 'input-too-large';
  return null;
}

function failureWire(args) {
  if (!['completed', 'failed'].includes(args.outcome) || typeof args.resumedRunId !== 'string'
      || !SAFE_REF.test(args.resumedRunId)) return undefined;
  if (!Object.hasOwn(args, 'failureRef')) return null;
  const value = args.failureRef;
  if (args.outcome !== 'failed' || !dataObject(value, ['runId'], ['runtimeStageId', 'category'])
      || value.runId !== args.resumedRunId) return undefined;
  if (Object.hasOwn(value, 'runtimeStageId') && (typeof value.runtimeStageId !== 'string'
      || !/^[A-Za-z0-9_.:/#-]{1,256}$/.test(value.runtimeStageId))) return undefined;
  if (Object.hasOwn(value, 'category') && (typeof value.category !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/.test(value.category))) return undefined;
  return JSON.stringify({ runId: value.runId,
    ...(Object.hasOwn(value, 'runtimeStageId') ? { runtimeStageId: value.runtimeStageId } : {}),
    ...(Object.hasOwn(value, 'category') ? { category: value.category } : {}) });
}

function winnerValue(wait) {
  if (wait.status === 'waiting') return wait.winner === null ? { value: null } : null;
  if (!['decided', 'claimed', 'completed'].includes(wait.status) || typeof wait.winner !== 'string') return null;
  let winner;
  try { winner = JSON.parse(wait.winner); } catch { return null; }
  if (dataObject(winner, ['kind', 'receiptRef']) && winner.kind === 'reply'
      && typeof winner.receiptRef === 'string' && DELIVERY_ID.test(winner.receiptRef)) return { value: winner };
  if (dataObject(winner, ['kind', 'dueAt']) && winner.kind === 'timer'
      && safeClock(winner.dueAt) && winner.dueAt === wait.due_at) return { value: winner };
  return null;
}

function stateBound(wait) {
  if (['waiting', 'decided'].includes(wait.status)) return wait.epoch === 0 && wait.worker === null
    && wait.lease === null && wait.outcome === null && wait.resumed_run_id === null && wait.failure_ref === null;
  if (!['claimed', 'completed'].includes(wait.status) || !safeOrdinal(wait.epoch)
      || !['worker1', 'worker2'].includes(wait.worker) || !safeClock(wait.lease)
      || wait.lease === 0 || wait.lease > wait.business_expiry) return false;
  if (wait.status === 'claimed') return wait.outcome === null && wait.resumed_run_id === null && wait.failure_ref === null;
  if (!['completed', 'failed'].includes(wait.outcome) || typeof wait.resumed_run_id !== 'string'
      || !SAFE_REF.test(wait.resumed_run_id) || wait.resumed_run_id === wait.paused_run_id) return false;
  if (wait.failure_ref === null) return true;
  try {
    return failureWire({ outcome: wait.outcome, resumedRunId: wait.resumed_run_id,
      failureRef: JSON.parse(wait.failure_ref) }) !== undefined;
  } catch { return false; }
}

function checkpointMatches(wait) {
  return typeof wait.checkpoint_wire === 'string'
    && Buffer.byteLength(wait.checkpoint_wire) <= MAX_CHECKPOINT_BYTES
    && typeof wait.checkpoint_digest === 'string' && HEX.test(wait.checkpoint_digest)
    && sha256(wait.checkpoint_wire) === wait.checkpoint_digest;
}

function publication(args, identity) {
  if (typeof args.checkpointWire !== 'string' || Buffer.byteLength(args.checkpointWire) > MAX_CHECKPOINT_BYTES
      || typeof args.checkpointDigest !== 'string' || !HEX.test(args.checkpointDigest)
      || sha256(args.checkpointWire) !== args.checkpointDigest
      || typeof args.pausedRunId !== 'string' || !SAFE_REF.test(args.pausedRunId) || args.pausedStageId !== 'wait'
      || !safeClock(args.dueAt) || !safeClock(args.businessExpiry) || args.dueAt >= args.businessExpiry)
    return null;
  return JSON.stringify({ identity, checkpointDigest: args.checkpointDigest, pausedRunId: args.pausedRunId,
    pausedStageId: args.pausedStageId, dueAt: args.dueAt, businessExpiry: args.businessExpiry });
}

function privateDatabaseFile(filename, initialize) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0'))
    throw new Error('InvalidHostDatabasePath');
  const parent = fs.lstatSync(path.dirname(filename));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && parent.uid !== process.getuid()))
    throw new Error('InvalidHostDatabaseDirectory');
  if (initialize) {
    const descriptor = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
      | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(descriptor);
  }
  const file = fs.lstatSync(filename);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0
      || (typeof process.getuid === 'function' && file.uid !== process.getuid()))
    throw new Error('InvalidHostDatabaseFile');
}

class Store {
  #db;
  #identity;

  constructor(filename, identity, { initialize = false } = {}) {
    this.#identity = identityWire(identity);
    try {
      privateDatabaseFile(filename, initialize);
      this.#db = new DatabaseSync(filename);
      this.#db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
      if (initialize) {
        this.#db.exec(`
          PRAGMA journal_mode=WAL;
          CREATE TABLE clock(now INTEGER NOT NULL);
          INSERT INTO clock VALUES(0);
          CREATE TABLE waits(key TEXT PRIMARY KEY, immutable TEXT NOT NULL,
            checkpoint_wire TEXT NOT NULL, checkpoint_digest TEXT NOT NULL,
            paused_run_id TEXT NOT NULL, paused_stage_id TEXT NOT NULL,
            due_at INTEGER NOT NULL, business_expiry INTEGER NOT NULL,
            status TEXT NOT NULL, winner TEXT, epoch INTEGER NOT NULL DEFAULT 0,
            worker TEXT, lease INTEGER, outcome TEXT, resumed_run_id TEXT, failure_ref TEXT);
          CREATE TABLE inbox(seq INTEGER PRIMARY KEY, key TEXT NOT NULL,
            delivery_id TEXT NOT NULL, body TEXT NOT NULL, admitted INTEGER NOT NULL,
            UNIQUE(key, delivery_id));
          CREATE TABLE outbox(key TEXT PRIMARY KEY, operation TEXT NOT NULL);
          CREATE TABLE tasks(key TEXT PRIMARY KEY, task_id TEXT UNIQUE NOT NULL,
            status TEXT NOT NULL, worker TEXT, epoch INTEGER NOT NULL DEFAULT 0);
        `);
      }
    } catch {
      try { this.#db?.close(); } catch { /* The original fixed refusal is retained. */ }
      throw new Error('HostStoreUnavailable');
    }
  }

  close() {
    this.#db.close();
  }

  #wait() {
    return this.#db.prepare('SELECT * FROM waits WHERE key=?').get(KEY);
  }

  #task() {
    return this.#db.prepare('SELECT * FROM tasks WHERE key=? AND task_id=?').get(KEY, TASK);
  }

  #binding(wait) {
    let immutable;
    try { immutable = JSON.parse(wait.immutable); } catch { return 'identity-mismatch'; }
    if (!dataObject(immutable, ['identity', 'checkpointDigest', 'pausedRunId', 'pausedStageId', 'dueAt', 'businessExpiry'])
        || immutable.identity !== this.#identity) return 'identity-mismatch';
    if (immutable.checkpointDigest !== wait.checkpoint_digest || immutable.pausedRunId !== wait.paused_run_id
        || immutable.pausedStageId !== wait.paused_stage_id || immutable.dueAt !== wait.due_at
        || immutable.businessExpiry !== wait.business_expiry || !safeClock(wait.due_at)
        || !safeClock(wait.business_expiry) || wait.due_at >= wait.business_expiry
        || typeof wait.paused_run_id !== 'string' || !SAFE_REF.test(wait.paused_run_id)
        || wait.paused_stage_id !== 'wait' || !Number.isSafeInteger(wait.epoch) || wait.epoch < 0
        || !winnerValue(wait) || !stateBound(wait) || !checkpointMatches(wait)) return 'checkpoint-mismatch';
    return null;
  }

  #select(now) {
    const wait = this.#wait();
    if (!wait || wait.status !== 'waiting') return;
    const invalid = this.#binding(wait);
    if (invalid) throw new Refusal(invalid);
    const receipt = this.#db.prepare('SELECT seq,delivery_id,admitted FROM inbox WHERE key=? AND admitted<? ORDER BY seq LIMIT 1')
      .get(KEY, wait.due_at);
    if (receipt && (!safeOrdinal(receipt.seq) || !safeClock(receipt.admitted)
        || typeof receipt.delivery_id !== 'string' || !DELIVERY_ID.test(receipt.delivery_id)))
      throw new Refusal('receipt-mismatch');
    if (!receipt && now < wait.due_at) return;
    const winner = receipt ? { kind: 'reply', receiptRef: receipt.delivery_id } : { kind: 'timer', dueAt: wait.due_at };
    this.#db.prepare("UPDATE waits SET status='decided',winner=? WHERE key=?").run(JSON.stringify(winner), KEY);
    this.#db.prepare("INSERT INTO tasks(key,task_id,status) VALUES(?,?,'queued')").run(KEY, TASK);
  }

  execute(op, args, principal) {
    let invalid;
    try { invalid = requestShape(op, args, principal); } catch { return refused('invalid-request'); }
    if (invalid) return refused(invalid);
    let transaction = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      transaction = true;
      // This serialized sample is not wall time at COMMIT. A rolled-back
      // transaction admits no sample, winner, task or result.
      const now = this.#db.prepare('SELECT now FROM clock').get().now;
      if (!safeClock(now)) throw new Refusal('clock-unavailable');
      const result = this.#operate(op, args, principal, now);
      this.#db.exec('COMMIT');
      transaction = false;
      return result;
    } catch (error) {
      if (transaction) {
        try { this.#db.exec('ROLLBACK'); } catch { /* Storage remains unknown. */ }
      }
      return refused(error instanceof Refusal ? error.code : 'storage-unavailable');
    }
  }

  #operate(op, args, principal, now) {
    if (op === 'tick') {
      if (!safeClock(args.to) || args.to < now) return refused('invalid-clock');
      this.#db.prepare('UPDATE clock SET now=?').run(args.to);
      return { clock: args.to };
    }
    if (op === 'publish') {
      const immutable = publication(args, this.#identity);
      if (!immutable) return refused('invalid-publication');
      const old = this.#wait();
      if (old) {
        const binding = this.#binding(old);
        if (binding) return refused(binding);
        return old.immutable === immutable && old.checkpoint_wire === args.checkpointWire
          ? { duplicate: true } : refused('conflicting-publication');
      }
      this.#db.prepare(`INSERT INTO waits(key,immutable,checkpoint_wire,checkpoint_digest,paused_run_id,
        paused_stage_id,due_at,business_expiry,status) VALUES(?,?,?,?,?,?,?,?,'waiting')`)
        .run(KEY, immutable, args.checkpointWire, args.checkpointDigest, args.pausedRunId, args.pausedStageId,
          args.dueAt, args.businessExpiry);
      this.#db.prepare('INSERT INTO outbox VALUES(?,?)').run(KEY, 'stable-operation');
      this.#select(now);
      return { published: true };
    }
    if (op === 'reply') {
      if (typeof args.deliveryId !== 'string' || !DELIVERY_ID.test(args.deliveryId)
          || typeof args.body !== 'string' || Buffer.byteLength(args.body) > 256)
        return refused('receipt-bounds');
      const old = this.#db.prepare('SELECT body FROM inbox WHERE key=? AND delivery_id=?').get(KEY, args.deliveryId);
      if (old) return old.body === args.body ? { duplicate: true } : refused('conflicting-receipt');
      if (this.#db.prepare('SELECT COUNT(*) AS n FROM inbox WHERE key=?').get(KEY).n >= 4)
        return refused('capacity-retain-evidence');
      this.#db.prepare('INSERT INTO inbox(key,delivery_id,body,admitted) VALUES(?,?,?,?)')
        .run(KEY, args.deliveryId, args.body, now);
      this.#select(now);
      return { admitted: true };
    }
    if (op === 'due') {
      this.#select(now);
      return { checked: true };
    }
    const wait = this.#wait();
    if (op === 'summary') {
      if (wait) {
        const binding = this.#binding(wait);
        if (binding) return refused(binding);
      }
      const count = (table) => this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE key=?`).get(KEY).n;
      let failureRef = null;
      if (wait?.failure_ref !== null && wait?.failure_ref !== undefined) {
        try {
          const value = JSON.parse(wait.failure_ref);
          const checked = failureWire({ outcome: wait.outcome, resumedRunId: wait.resumed_run_id, failureRef: value });
          if (checked === undefined) return refused('checkpoint-mismatch');
          failureRef = value;
        } catch { return refused('checkpoint-mismatch'); }
      }
      return { status: wait?.status ?? 'unpublished', winner: wait ? winnerValue(wait).value : null,
        epoch: wait?.epoch ?? 0, lease: wait?.lease ?? null, hostNow: now,
        taskCount: count('tasks'), outboxCount: count('outbox'), inboxCount: count('inbox'),
        pausedRunId: wait?.paused_run_id ?? null, resumedRunId: wait?.resumed_run_id ?? null,
        outcome: wait?.outcome ?? null, failureRef };
    }
    if (!wait) return refused('no-task');
    const binding = this.#binding(wait);
    if (binding) return refused(binding);
    const task = this.#task();
    if (!task) return refused('no-task');
    if (op === 'claim') {
      if (wait.status === 'completed' || task.status === 'done') return refused('no-task');
      if (!['decided', 'claimed'].includes(wait.status)) return refused('not-decided');
      if (now >= wait.business_expiry) return refused('business-expired');
      if (wait.status === 'claimed' && now < wait.lease) return refused('active-lease');
      const epoch = wait.epoch + 1;
      if (!safeOrdinal(epoch)) return refused('invalid-epoch');
      const lease = Math.min(now + 5, wait.business_expiry);
      this.#db.prepare("UPDATE waits SET status='claimed',worker=?,epoch=?,lease=? WHERE key=?")
        .run(principal, epoch, lease, KEY);
      this.#db.prepare("UPDATE tasks SET status='claimed',worker=?,epoch=? WHERE key=? AND task_id=?")
        .run(principal, epoch, KEY, TASK);
      return { claimed: true, epoch, lease };
    }
    if (wait.worker !== principal || task.worker !== principal) return refused('worker-binding');
    if (op === 'complete' && wait.status === 'completed') {
      return wait.epoch === args.epoch && task.epoch === args.epoch && task.status === 'done'
        && wait.outcome === args.outcome && wait.resumed_run_id === args.resumedRunId && wait.failure_ref === failureWire(args)
        ? { duplicate: true } : refused('conflicting-result');
    }
    if (wait.status !== 'claimed' || task.status !== 'claimed' || wait.epoch !== args.epoch
        || task.epoch !== args.epoch || now >= wait.lease || now >= wait.business_expiry)
      return refused('stale-or-expired');
    if (op === 'admit') return { admitted: true, key: KEY, taskId: TASK, epoch: args.epoch,
      checkpointWire: wait.checkpoint_wire, checkpointDigest: wait.checkpoint_digest,
      pausedRunId: wait.paused_run_id, pausedStageId: wait.paused_stage_id,
      winner: winnerValue(wait).value, hostNow: now, leaseUntil: wait.lease,
      businessExpiry: wait.business_expiry, remainingMs: Math.min(1000, wait.business_expiry - now),
      identity: JSON.parse(this.#identity) };
    if (args.resumedRunId === wait.paused_run_id) return refused('unsupported-outcome');
    this.#db.prepare("UPDATE waits SET status='completed',outcome=?,resumed_run_id=?,failure_ref=? WHERE key=?")
      .run(args.outcome, args.resumedRunId, failureWire(args), KEY);
    this.#db.prepare("UPDATE tasks SET status='done' WHERE key=? AND task_id=?").run(KEY, TASK);
    return { completed: true };
  }
}

module.exports = { Store };
