import type { JoinedRun, Segment } from '../readLawWitness.js';
import { equal, fixtureValue, refuse } from '../readLawWitness.js';
import type { NativeFact } from '../readWitness.js';
import type { Context } from './types.js';

function original(run: JoinedRun, row: NativeFact): void {
  if (
    run.native.events.filter((event) => event === row).length !== 1 ||
    run.native.events.filter((event) => event.id === row.id).length !== 1 ||
    !Number.isSafeInteger(row.id) ||
    row.id <= 0 ||
    row.outcome !== 'returned' ||
    row.leg !== run.native.leg ||
    !(row.start < row.end)
  )
    return refuse('staged readback lacks one original successful native occurrence');
}
// Conservative overlap refusal uses JavaScript property identity; joins still require exact native addresses.
const prefix = (a: readonly Segment[], b: readonly Segment[]) =>
  a.length <= b.length && a.every((x, i) => String(x) === String(b[i]));
const overlaps = (a: readonly Segment[], b: readonly Segment[]) => prefix(a, b) || prefix(b, a);
const producer = (row: NativeFact) => row.tier === 'buffer-call' && ['set', 'merge', 'delete'].includes(row.method);
const tombstone = (row: NativeFact) =>
  row.method === 'delete' || (row.method === 'set' && row.value?.kind === 'undefined');

function at(root: unknown, path: readonly Segment[]): { found: true; value: unknown } | { found: false } {
  let node = root;
  for (const part of path) {
    if (node === null || typeof node !== 'object') return { found: false };
    const entry = Object.getOwnPropertyDescriptor(node, part);
    if (!entry) return { found: false };
    if (!Object.hasOwn(entry, 'value')) return refuse('staged record path is not own data');
    node = entry.value;
  }
  return { found: true, value: node };
}

/** Original encoder + producer/address joins only; no replay or inferred output identity. */
export function requireOwnStagedRead(
  context: Context,
  side: 'baseline' | 'build',
  read: NativeFact,
  get: NativeFact,
  lastProducer: NativeFact,
  acceptedProducers: ReadonlySet<NativeFact>,
): void {
  const run = side === 'baseline' ? context.a : context.b;
  const commit = side === 'baseline' ? context.cause.baselineCommit : context.cause.buildCommit;
  const row = run.commits[context.index];
  for (const event of [read, get, lastProducer, commit]) original(run, event);
  const address = get.address;
  if (
    !Array.isArray(address) ||
    !address.length ||
    address.length > 128 ||
    address.some(
      (part) => typeof part !== 'string' && !(typeof part === 'number' && Number.isSafeInteger(part) && part >= 0),
    ) ||
    read.tier !== 'stage-call' ||
    read.method !== 'getValue' ||
    read.phase !== 'read' ||
    get.tier !== 'buffer-call' ||
    get.method !== 'get' ||
    get.phase !== 'read' ||
    !read.result ||
    !equal(get.result, read.result) ||
    read.gets?.length !== 1 ||
    read.gets[0] !== get.id ||
    !(read.start < get.start && get.end < read.end && read.end < commit.start) ||
    !producer(lastProducer) ||
    !acceptedProducers.has(lastProducer) ||
    !equal(lastProducer.address, address) ||
    !(lastProducer.end < get.start) ||
    typeof get.frame !== 'number' ||
    !Number.isSafeInteger(get.frame) ||
    get.frame <= 0 ||
    get.frame !== read.frame ||
    get.frame !== lastProducer.frame ||
    !get.header ||
    !equal(get.header, read.header) ||
    !equal(get.header, lastProducer.header) ||
    typeof get.buffer !== 'number' ||
    !Number.isSafeInteger(get.buffer) ||
    get.buffer <= 0 ||
    get.buffer !== lastProducer.buffer ||
    typeof get.epoch !== 'number' ||
    !Number.isSafeInteger(get.epoch) ||
    get.epoch < 0 ||
    get.epoch !== lastProducer.epoch
  )
    return refuse('staged readback read/get/last producer is not the exact original address and frame');
  if (
    !row ||
    row.nativeId !== commit.id ||
    commit.tier !== 'buffer-call' ||
    commit.method !== 'commit' ||
    commit.frame !== get.frame ||
    !equal(commit.header, get.header) ||
    commit.buffer !== get.buffer ||
    commit.epoch !== get.epoch ||
    !commit.encoder ||
    commit.encoder.bytes !== row.bytes ||
    !(
      commit.start < commit.encoder.start &&
      commit.encoder.start < commit.encoder.end &&
      commit.encoder.end < commit.end
    ) ||
    commit.encoder.method !== (commit.encoder.mode === 'full' ? 'toChangeOnlyPayload' : 'toDeltaPayload') ||
    !['full', 'delta'].includes(commit.encoder.mode)
  )
    return refuse('staged readback has no exact original encoder/outer join');
  for (const event of run.native.events) {
    if (
      !producer(event) ||
      event.buffer !== get.buffer ||
      event.epoch !== get.epoch ||
      !event.address ||
      !overlaps(event.address, address) ||
      event === lastProducer ||
      event.end <= lastProducer.end ||
      event.start >= commit.start
    )
      continue;
    original(run, event);
    if (event.start < get.end) return refuse('staged readback has an intervening overlapping producer');
    if (
      !acceptedProducers.has(event) ||
      event.frame !== get.frame ||
      !equal(event.header, get.header) ||
      !equal(event.address, address) ||
      !['set', 'merge'].includes(event.method) ||
      read.resultObject === undefined ||
      event.valueObject !== read.resultObject ||
      !equal(event.value, read.result) ||
      event.end >= commit.start
    )
      return refuse('staged readback has an unaccounted or changed later producer');
  }
  const bytes = commit.encoder.bytes;
  if (new TextEncoder().encode(bytes).byteLength > 1_048_576) return refuse('staged record readback exceeds bound');
  let payload: unknown;
  try {
    payload = JSON.parse(bytes);
  } catch {
    return refuse('staged readback encoder is not fixture JSON');
  }
  if (JSON.stringify(payload) !== bytes) return refuse('staged readback never normalizes encoder bytes');
  const overwrite = at(payload, ['overwrite']);
  const updates = at(payload, ['updates']);
  if (
    !overwrite.found ||
    !updates.found ||
    overwrite.value === null ||
    updates.value === null ||
    typeof overwrite.value !== 'object' ||
    typeof updates.value !== 'object' ||
    Array.isArray(overwrite.value) ||
    Array.isArray(updates.value)
  )
    return refuse('staged readback has no closed own record patch roots');
  const slots = [at(overwrite.value, address), at(updates.value, address)];
  const present = slots.filter((slot): slot is { found: true; value: unknown } => slot.found);
  const expected = JSON.stringify(fixtureValue(read.result));
  if (!present.length) {
    const deletedBy = context.reads[side === 'baseline' ? 0 : 1].deletedBy;
    if (
      read.result.kind !== 'undefined' ||
      get.base?.found !== false ||
      get.base.value.kind !== 'undefined' ||
      lastProducer !== deletedBy ||
      !tombstone(lastProducer)
    )
      return refuse('omitted staged value is not proved absent base plus original last tombstone');
    return;
  }
  const actual = present.filter((slot) => JSON.stringify(slot.value) === expected);
  if (actual.length !== 1) return refuse('staged read value differs from or is ambiguous in its own record');
  for (const slot of present) {
    if (slot === actual[0]) continue;
    const deletedBy = context.reads[side === 'baseline' ? 0 : 1].deletedBy;
    original(run, deletedBy);
    if (
      slot.value !== '«undefined»' ||
      !tombstone(deletedBy) ||
      deletedBy.frame !== get.frame ||
      deletedBy.buffer !== get.buffer ||
      deletedBy.epoch !== get.epoch ||
      !equal(deletedBy.header, get.header) ||
      !equal(deletedBy.address, address) ||
      !(deletedBy.end < lastProducer.start)
    )
      return refuse('opposite staged slot is not the proved original tombstone');
  }
}
