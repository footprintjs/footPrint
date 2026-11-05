/** AUTHOR DRAFT — UNRUN. Intended destination: test/helpers/pauseLegViews/index.ts. */
export interface PauseFieldCapture {
  readonly leg: number;
  readonly field: string;
  readonly value: string;
}
export interface PauseLegView {
  readonly leg: number;
  readonly kept: Readonly<Record<string, string>>;
  /** Reversible physical names: strings are never parsed, projected, copied from another leg or reserialized. */
  readonly physicalByLogical: Readonly<Record<string, string>>;
}
const MAX_LEGS = 21; // Existing drive loop answers at most twenty pauses, plus the initial actual run.
const MAX_FIELDS = 7 * MAX_LEGS + 2 * (MAX_LEGS - 1) + 3;
const fail = (message: string): never => {
  throw new Error(`Unusable pause field ownership: ${message}`);
};
function data(object: unknown, field: string): unknown {
  if (object === null || typeof object !== 'object') return fail('missing own-data object');
  const descriptor = Object.getOwnPropertyDescriptor(object, field);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return fail('missing own-data field');
  return descriptor.value;
}

/** Field ownership metadata only. No native observation, fixture operation or state model lives here. */
export function pauseLegViews(
  out: Readonly<Record<string, string>>,
  captures: readonly PauseFieldCapture[],
  legCount: number,
  policy: boolean,
): readonly PauseLegView[] {
  if (!Number.isSafeInteger(legCount) || legCount < 1 || legCount > MAX_LEGS || typeof policy !== 'boolean')
    return fail('actual leg count/policy is outside the existing drive bounds');
  if (!Array.isArray(captures) || captures.length > MAX_FIELDS)
    return fail('capture count exceeds existing drive bounds');
  const expected = new Map<string, { leg: number; logical: string }>();
  const add = (leg: number, field: string, logical = field) => expected.set(field, { leg, logical });
  for (let leg = 0; leg < legCount; leg++) {
    for (const suffix of ['log', 'state', 'init', 'sub', 'folds']) {
      const field = `leg${leg}.${suffix}`;
      add(leg, field, suffix === 'sub' ? 'subflowResults' : field);
    }
    if (policy) {
      add(leg, `leg${leg}.red`);
      add(leg, `leg${leg}.redsub`, 'redactedSubflows');
    }
    if (leg < legCount - 1) {
      add(leg, `cp${leg + 1}`);
      add(leg, `cp${leg + 1}.tree`);
    }
  }
  for (const field of ['runError', 'errors', 'pauses']) add(legCount - 1, field);
  const physicalKeys = Reflect.ownKeys(out);
  if (
    physicalKeys.length !== expected.size ||
    physicalKeys.some((field) => typeof field !== 'string' || !expected.has(field))
  )
    return fail('missing or extra output field');
  const physicalValues = new Map<string, string>();
  for (const field of expected.keys()) {
    const value = data(out, field);
    if (typeof value !== 'string') return fail('output is not the actual retained string');
    physicalValues.set(field, value);
  }
  const views = Array.from({ length: legCount }, (_, leg) => ({
    leg,
    kept: Object.create(null) as Record<string, string>,
    physicalByLogical: Object.create(null) as Record<string, string>,
  }));
  const claimed = new Set<string>();
  for (const capture of captures) {
    const keys = Reflect.ownKeys(capture);
    if (keys.length !== 3 || keys.some((key) => !['leg', 'field', 'value'].includes(key as string)))
      return fail('capture is not the closed owner/field/string shape');
    const leg = data(capture, 'leg');
    const field = data(capture, 'field');
    const value = data(capture, 'value');
    if (typeof field !== 'string' || typeof value !== 'string' || !Number.isSafeInteger(leg))
      return fail('capture has unreadable owner/field/string');
    const target = expected.get(field);
    if (!target || target.leg !== leg || claimed.has(field)) return fail('extra, duplicate or wrong-leg capture');
    if (physicalValues.get(field) !== value) return fail('capture bytes do not match actual output');
    const view = views[target.leg];
    if (Object.hasOwn(view.kept, target.logical)) return fail('logical name collision');
    claimed.add(field);
    view.kept[target.logical] = value;
    view.physicalByLogical[target.logical] = field;
  }
  if (claimed.size !== expected.size) return fail('output field has no actual capture owner');
  return Object.freeze(
    views.map((view) =>
      Object.freeze({
        leg: view.leg,
        kept: Object.freeze(view.kept),
        physicalByLogical: Object.freeze(view.physicalByLogical),
      }),
    ),
  );
}
