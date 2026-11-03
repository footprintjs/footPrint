/** Private component registrations above the pure frame layer. No event invocation here. */
import { observeNativeFailure } from '../attempt/observerDiagnostics.js';
import type { RunFrame } from '../memory/RunFrame.js';
import type { CombinedRecorder } from './CombinedRecorder.js';
import { type ComponentEnd, type FinalizationFailures, FinalizationBook } from './FinalizationBook.js';

/** Component-local ordinary recorder using the canonical served-event/error boundary.
 * WHY: mid-run consumers need preceding events synchronously, never one beat behind.
 * Absent/inline delivery is admitted; deferred, invalid or accessor delivery refuses
 * with ERR_COMPONENT_RECORDER_DELIVERY rather than being silently overridden.
 */
export type InlineComponentRecorder = Omit<CombinedRecorder, 'delivery'> & { readonly delivery?: 'inline' };
/** Synchronous component wiring, captured before its stages or mappers run.
 * WHY: mounts have no public run wrapper to bind their private integration state.
 */
export interface ComponentSetup {
  /** Runs on the actual protected scope before stage callbacks, stream start or item selection.
   * Factory construction effects precede this boundary; returned asynchronous work is refused.
   */
  readonly bindScope?: (scope: unknown) => void;
  readonly recorder?: InlineComponentRecorder;
}
export interface ComponentPort {
  open(frame: RunFrame, finalizers: FinalizationBook): ComponentSetup;
}
interface Registration {
  readonly namespace: WeakRef<object>;
  readonly port: WeakRef<ComponentPort>;
}
interface ComponentControl {
  readonly ports: ComponentPort[];
  readonly leg: Set<ComponentControl>;
  readonly finalizers: FinalizationBook;
  readonly owned: boolean;
  binders: Array<(scope: unknown) => void>;
  recorders: object[];
  opened: boolean;
}
const registrations = new WeakMap<object, Set<Registration>>();
const controls = new WeakMap<object, ComponentControl>();
const observationLegs = new WeakMap<object, Set<ComponentControl>>();

/** Called by first component slot issuance; the lifecycle itself strongly owns its port. */
export function registerComponentPort(token: object, namespace: object, port: ComponentPort): void {
  let entries = registrations.get(token);
  if (!entries) {
    entries = new Set();
    registrations.set(token, entries);
  }
  for (const entry of entries) {
    const ns = entry.namespace.deref();
    const existing = entry.port.deref();
    if (!ns || !existing) {
      entries.delete(entry);
      continue;
    }
    if (ns === namespace) {
      if (existing !== port) throw new TypeError('Lifecycle component port cannot change after declaration');
      return;
    }
  }
  entries.add({ namespace: new WeakRef(namespace), port: new WeakRef(port) });
}

/** Entry captures live ports before any caller can change future chart declarations. */
export function captureComponentControl(frame: RunFrame, finalizers?: FinalizationBook): void {
  if (frame.retired) throw new TypeError('Native component entry has retired');
  const entries = frame.componentRoot === undefined ? undefined : registrations.get(frame.componentRoot);
  const ports: ComponentPort[] = [];
  for (const entry of entries ?? []) {
    const namespace = entry.namespace.deref();
    const port = entry.port.deref();
    if (!namespace || !port) {
      entries!.delete(entry);
      continue;
    }
    ports.push(port);
  }
  let leg = observationLegs.get(frame.legKey);
  if (!leg) {
    leg = new Set();
    observationLegs.set(frame.legKey, leg);
  }
  const control: ComponentControl = {
    ports,
    leg,
    finalizers: finalizers ?? new FinalizationBook(),
    owned: finalizers !== undefined,
    binders: [],
    recorders: [],
    opened: false,
  };
  controls.set(frame.componentKey, control);
  leg.add(control);
}

function deliveryError(): TypeError {
  return Object.assign(new TypeError('Component recorders require inline delivery'), {
    code: 'ERR_COMPONENT_RECORDER_DELIVERY',
  });
}
function admitRecorder(value: unknown): object {
  if (value === null || typeof value !== 'object') throw new TypeError('Component recorder must be an object');
  let current: object | null = value;
  for (let i = 0; current !== null && i < 32; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'delivery');
    if (descriptor) {
      if (!Object.hasOwn(descriptor, 'value') || (descriptor.value !== undefined && descriptor.value !== 'inline'))
        throw deliveryError();
      return value;
    }
    current = Object.getPrototypeOf(current);
  }
  if (current !== null) throw deliveryError();
  return value;
}
function admitSetup(value: unknown): ComponentSetup {
  const object = value !== null && typeof value === 'object';
  if (!object || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) {
    observeNativeFailure(value, () => undefined);
    throw new TypeError('Component setup must return a synchronous own-data configuration');
  }
  // Admit the inspected own values once. Keeping the host object's prototype
  // would let an absent field adopt an inherited callback or invoke its getter.
  const result: ComponentSetup = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if ((key !== 'bindScope' && key !== 'recorder') || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('Unknown or accessor component setup field');
    }
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  if (result.bindScope !== undefined && typeof result.bindScope !== 'function')
    throw new TypeError('Component binder must be a function');
  if (result.recorder !== undefined) admitRecorder(result.recorder);
  return result;
}

export function openComponentControl(frame: RunFrame): void {
  if (frame.retired) throw new TypeError('Native component setup has retired');
  const control = controls.get(frame.componentKey);
  if (!control || control.opened) return;
  control.opened = true;
  for (const port of control.ports) {
    const setup = admitSetup(port.open(frame, control.finalizers));
    if (setup.bindScope) control.binders.push(setup.bindScope);
    if (setup.recorder) control.recorders.push(setup.recorder);
  }
}

export function bindComponentScope(frame: RunFrame | undefined, scope: unknown): void {
  if (!frame) return;
  if (frame.retired) throw new TypeError('Component scope binding has retired');
  const control = controls.get(frame.componentKey);
  if (!control) return;
  for (const bind of control.binders) {
    const returned: unknown = bind(scope);
    if (returned !== null && (typeof returned === 'object' || typeof returned === 'function')) {
      observeNativeFailure(returned, () => undefined);
      throw new TypeError('Component scope binder must be synchronous');
    }
  }
}

export function hasComponentRecorders(frame: RunFrame | undefined): boolean {
  return !!frame && !frame.retired && (controls.get(frame.componentKey)?.recorders.length ?? 0) > 0;
}

/** Native-owned selection only; hooks.fire remains the one callback invocation loop. */
export function* componentRecorders(frame: RunFrame | undefined, external: readonly object[]): Iterable<object> {
  const scoped = frame && !frame.retired ? controls.get(frame.componentKey)?.recorders ?? [] : [];
  const seen = new Set<object>();
  for (const recorder of scoped) {
    if (!seen.has(recorder)) {
      seen.add(recorder);
      yield recorder;
    }
  }
  for (const recorder of external) if (!seen.has(recorder)) yield recorder;
}

function clearObservation(control: ComponentControl): void {
  control.binders.length = 0;
  control.recorders.length = 0;
  control.ports.length = 0;
}

/** Drop every leg subscription, including a failFast sibling still in host async work.
 * Already-registered cleanup remains with its actual component settlement owner.
 */
export function retireLegComponentObservations(frame: RunFrame): void {
  const leg = observationLegs.get(frame.legKey);
  if (!leg) return;
  observationLegs.delete(frame.legKey);
  for (const control of leg) clearObservation(control);
  leg.clear();
}

/** Native retirement drops observation/setup closures; owned root control settles later. */
export async function retireComponentControl(frame: RunFrame, end: ComponentEnd): Promise<FinalizationFailures> {
  const control = controls.get(frame.componentKey);
  controls.delete(frame.componentKey);
  frame.retireComponent();
  if (!control) return { count: 0 };
  control.leg.delete(control);
  clearObservation(control);
  return control.owned ? { count: 0 } : control.finalizers.finish(end);
}
