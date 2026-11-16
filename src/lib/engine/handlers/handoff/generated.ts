/** Native generated origin is registered by code, never trusted from caller-owned fields. */
import type { LogAddress } from 'foottrace';

import type { ReadPrefix } from './prefix.js';
export interface GeneratedInput {
  readonly cutoff: number;
  readonly prefix?: ReadPrefix;
  readonly parent: LogAddress | undefined;
  readonly advanced: () => boolean;
  settled(address: LogAddress | undefined, beforeCommitIdx: number, failed: boolean, explicit: boolean): void;
}
const generated = new WeakMap<object, GeneratedInput>();
export function registerGenerated(options: object, origin: GeneratedInput): void {
  generated.set(options, origin);
}
export function generatedInput(options: object | undefined): GeneratedInput | undefined {
  return options && generated.get(options);
}
