/** Data shapes for the consumer range tests (scripts/consumer-range.mjs): locks, peers, one consumer. */
import { declaredRange } from '../../scripts/audit-consumers.mjs';

// What the registry held on 12 Nov 2026, before 12.0.0, for the versions that matter here.
export const PUBLISHED = ['10.0.0', '11.0.0', '11.0.1', '11.1.0', '11.2.0', '12.0.0-rc.0'];
export const lockOf = (packages: Record<string, unknown>) => ({
  lockfileVersion: 3,
  packages: { '': {}, ...packages },
});
export const peer = (version: string, range: string, optional = false) => ({
  version,
  peerDependencies: { footprintjs: range },
  ...(optional ? { peerDependenciesMeta: { footprintjs: { optional: true } } } : {}),
});

/** Every declaration of one consumer, its manifest, tree and pins given as data. */
export function rangeFor(
  manifest: unknown,
  { lock = lockOf({}) as unknown, pins = {} as Record<string, unknown> } = {},
) {
  const dir = '/ws/app/app';
  return declaredRange([dir], Object.keys(pins), new Map([[dir, manifest]]), {
    installedTree: () => lock,
    publishedPeers: (pin: string) => pins[pin],
  });
}
