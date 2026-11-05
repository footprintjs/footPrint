/** Closed ruled rows; method roles describe observations, never permission from a count. */
export type ProjectionKind = 'push' | 'elem' | 'setIn' | 'batch';
export interface Profile {
  readonly operation: ProjectionKind;
  readonly projection: 'append' | 'element-field' | 'literal-field' | 'deep-copy-append';
  readonly identity: 'shallow-array' | 'changed-element' | 'literal-payload' | 'disjoint-deep-prefix';
  readonly baselineReads: readonly ('getValue' | 'getValueDirect')[];
}
const row = (profile: Profile): Profile =>
  Object.freeze({ ...profile, baselineReads: Object.freeze([...profile.baselineReads]) });
export const PROFILES: Readonly<Record<ProjectionKind, Profile>> = Object.freeze({
  push: row({
    operation: 'push',
    projection: 'append',
    identity: 'shallow-array',
    baselineReads: ['getValue', 'getValue', 'getValueDirect', 'getValueDirect'],
  }),
  elem: row({
    operation: 'elem',
    projection: 'element-field',
    identity: 'changed-element',
    baselineReads: ['getValue', 'getValue', 'getValueDirect', 'getValueDirect', 'getValueDirect'],
  }),
  setIn: row({
    operation: 'setIn',
    projection: 'literal-field',
    identity: 'literal-payload',
    baselineReads: ['getValue', 'getValue'],
  }),
  batch: row({
    operation: 'batch',
    projection: 'deep-copy-append',
    identity: 'disjoint-deep-prefix',
    baselineReads: ['getValue'],
  }),
});
export const isProjectionOperation = (name: string): name is ProjectionKind => Object.hasOwn(PROFILES, name);
