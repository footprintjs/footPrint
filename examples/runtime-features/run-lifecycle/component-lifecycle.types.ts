import type {
  CombinedRecorder,
  ComponentEnd,
  ComponentRun,
  ComponentSetup,
  InlineComponentRecorder,
  NativeComponentEntry,
  RunLifecycleOptions,
} from 'footprintjs';

export function checkComponentPublicTypes(component: ComponentRun): void {
  const entry: NativeComponentEntry = component.entry;
  const originRun: string = component.origin.runId;
  const inline: InlineComponentRecorder = { id: 'typed', delivery: 'inline', onEmit: () => undefined };
  const setup: ComponentSetup = { recorder: inline, bindScope: () => undefined };
  const options: RunLifecycleOptions = { runnerId: originRun, componentSetup: () => setup };
  component.onFinalize(async (end) => {
    const terminal: ComponentEnd['kind'] = end.kind;
  });
  const broad: CombinedRecorder = { id: 'deferred', delivery: 'deferred' };
  // @ts-expect-error A broadly deferred recorder cannot become an inline component subscriber.
  const deferred: InlineComponentRecorder = broad;
  // @ts-expect-error Component recorders cannot request deferred delivery.
  const invalid: InlineComponentRecorder = { id: 'invalid', delivery: 'deferred' };
  // @ts-expect-error Component entry coordinates are immutable.
  component.entry.ordinal = 2;
  // @ts-expect-error Native entry run IDs cannot be relabeled.
  component.entry.runId = 'application-id';
  // @ts-expect-error The terminal control vocabulary is closed.
  const end: ComponentEnd = { kind: 'cancelled' };
  // @ts-expect-error Setup must complete synchronously before component effects.
  const asyncOptions: RunLifecycleOptions = { runnerId: 'async', componentSetup: async () => ({}) };
}
