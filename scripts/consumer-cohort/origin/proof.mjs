/** Immutable code-owned specimen bytes and pure receipt joins, separate from process/install effects. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseManifest } from '../../publish-release/archive/inspector.cjs';
import { readFileSync } from 'node:fs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const names = ['preflight.cjs', 'run.cjs', 'preflight.mjs', 'run.mjs'];
// Captured when the audited program loads, before any foreign producer commands.
const sources = new Map(
  names.map((name) => [name, readFileSync(new URL('./public-specimens/' + name, import.meta.url))]),
);
export const specimenFiles = () => new Map([...sources].map(([name, bytes]) => [name, Buffer.from(bytes)]));
const keys = (record, names) =>
  record &&
  typeof record === 'object' &&
  !Array.isArray(record) &&
  Object.keys(record).length === names.length &&
  names.every((key) => Object.hasOwn(record, key));
export function requireProducerReport(report, format, af, engine) {
  if (
    !keys(report, [
      'specimen',
      'format',
      'node',
      'producer',
      'recordedEvents',
      'droppedEvents',
      'resolvedPublicEntries',
    ]) ||
    report.specimen !== 'public-producer-version-with-mock-agent' ||
    report.format !== format ||
    typeof report.node !== 'string' ||
    report.node.length > 64 ||
    !keys(report.producer, ['agentfootprintVersion', 'footprintjsVersion']) ||
    report.producer.agentfootprintVersion !== af.version ||
    report.producer.footprintjsVersion !== engine.version ||
    !keys(report.resolvedPublicEntries, ['root', 'providers', 'observe']) ||
    !Number.isSafeInteger(report.recordedEvents) ||
    report.recordedEvents < 1 ||
    report.droppedEvents !== 0
  )
    throw Error('public producer-version result differs');
  return report;
}
export function requireProofReceipt(proof, selections) {
  const af = selections.get('agentfootprint'),
    engine = selections.get('footprintjs'),
    trace = selections.get('foottrace');
  if (
    !proof ||
    !Array.isArray(proof.reports) ||
    proof.reports.length !== 2 ||
    !Array.isArray(proof.processes) ||
    proof.processes.length !== 4 ||
    proof.afIntegrity !== af.integrity ||
    proof.engineIntegrity !== engine.integrity ||
    !trace ||
    proof.traceIntegrity !== trace.integrity ||
    proof.traceVersion !== trace.version ||
    !/^[a-f0-9]{64}$/.test(proof.installManifestHash) ||
    !/^[a-f0-9]{64}$/.test(proof.installLockHash)
  )
    throw Error('public version receipt incomplete');
  for (let i = 0; i < 4; i++) {
    const result = proof.processes[i];
    if (
      result?.script !== names[i] ||
      result.scriptSHA256 !== sha(sources.get(names[i])) ||
      result.status !== 0 ||
      result.signal ||
      result.errorCode
    )
      throw Error('public version process receipt differs');
  }
  for (let i = 0; i < 2; i++) {
    const report = proof.reports[i];
    let preflight, emitted;
    try {
      preflight = parseManifest(Buffer.from(proof.processes[i * 2].stdout));
      emitted = parseManifest(Buffer.from(proof.processes[i * 2 + 1].stdout));
    } catch {
      throw Error('public version output receipt differs');
    }
    if (
      preflight.format !== ['cjs', 'esm'][i] ||
      !isDeepStrictEqual(emitted, report) ||
      !isDeepStrictEqual(preflight.entries, report.resolvedPublicEntries)
    )
      throw Error('public version output receipt differs');
    requireProducerReport(report, ['cjs', 'esm'][i], af, engine);
  }
  return proof;
}
