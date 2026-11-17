/** Same-loaded-module-instance authority. Internal registration is never a public export. */
import type { CommitBundle, LogAddress } from 'foottrace';

import type { CaptureResult, FanoutCollections, InputHandoff } from './subflowHandoff.js';

export interface InputObservation {
  watch(view: object): void;
  finish(child: LogAddress | undefined, bundle: CommitBundle | undefined, resume: boolean): InputHandoff | undefined;
}
export interface FanoutObservation {
  observeSelector(native: boolean): () => void;
  count(total: number, branches: number): void;
  register(options: object, index: number, enabled: boolean): void;
  watchWrite(): void;
  close(): void;
  finish(bundle: CommitBundle | undefined): void;
}
/** Closed native port; only the optional library module constructs implementations. */
export interface SubflowCapturePort {
  readonly input: boolean;
  readonly fanout: boolean;
  beginInput(runtime: object, context: object, options: object | undefined): InputObservation | undefined;
  beginFanout(runtime: object, context: object): FanoutObservation;
  settled(
    options: object | undefined,
    address: LogAddress | undefined,
    cutoff: number,
    failed: boolean,
    explicit: boolean,
  ): void;
  view(runtime: object, redact: boolean): FanoutCollections | undefined;
  reset(runtime: object): void;
  noteRootRead(context: object, path: readonly string[], key: string | undefined, committed: boolean): void;
  privateResult<T extends CaptureResult>(result: T): T;
}
export interface SubflowCaptureOptions {
  /** Use the library factory from footprintjs/subflow-capture; bare new flags refuse. */
  captureInputHandoff?: boolean;
  /** Generated input and collection capture; requires the same factory capability. */
  captureFanoutHandoff?: boolean;
  /** Opaque same-instance library authority, never serialized or propagated through business input. */
  subflowCapture?: object;
}
const capabilities = new WeakMap<object, SubflowCapturePort>();
const fields = ['captureInputHandoff', 'captureFanoutHandoff', 'subflowCapture'] as const;
const message = 'Invalid subflow capture configuration';
/** One presence rule: inherited and accessor claims count without reading their values. */
function hasCaptureClaim(options: object): boolean {
  return fields.some((key) => Reflect.has(options, key));
}
/** Internal only. The public factory supplies a fixed frozen library backend, never caller callbacks. */
export function registerSubflowCapture(port: SubflowCapturePort): Readonly<Required<SubflowCaptureOptions>> {
  const token = Object.freeze({});
  capabilities.set(token, port);
  return Object.freeze({ captureInputHandoff: port.input, captureFanoutHandoff: port.fanout, subflowCapture: token });
}
/** Inspect raw caller fields before any constructor normalization or effect-capable option access. */
export function resolveSubflowCapture(options: object): SubflowCapturePort | undefined {
  if (!hasCaptureClaim(options)) return;
  const slots = fields.map((key) => Object.getOwnPropertyDescriptor(options, key));
  if (slots.some((slot) => !slot || !Object.hasOwn(slot, 'value'))) throw new TypeError(message);
  const [input, fanout, token] = slots.map((slot) => slot!.value);
  const port = token && typeof token === 'object' ? capabilities.get(token) : undefined;
  if (!port || input !== port.input || fanout !== port.fanout) throw new TypeError(message);
  return input || fanout ? port : undefined;
}
/** Inspect only offered transport configuration, never a child chart's arbitrary business input. */
export function refuseSubflowTransport(options: unknown): void {
  if (options !== null && (typeof options === 'object' || typeof options === 'function') && hasCaptureClaim(options))
    throw new TypeError(message);
}

/** Builder admission inspects offered data only; an ordinary driver getter keeps its stage-time evaluation. */
export function refuseDetachCapture(options: object): void {
  refuseSubflowTransport(options);
  const driver = Object.getOwnPropertyDescriptor(options, 'driver');
  if (driver && Object.hasOwn(driver, 'value')) refuseSubflowTransport(driver.value);
}

/** Private policy association: public RunPolicy objects never accept structural backend callbacks. */
const policies = new WeakMap<object, SubflowCapturePort>();
export function bindSubflowCapture<T extends object>(policy: T, port: SubflowCapturePort | undefined): T {
  if (port) policies.set(policy, port);
  return policy;
}
export function subflowCaptureFor(policy: object): SubflowCapturePort | undefined {
  return policies.get(policy);
}
export function inheritSubflowCapture<T extends object>(from: object, to: T): T {
  return bindSubflowCapture(to, policies.get(from));
}
