import { decide } from 'footprintjs-baseline';

export function admitStage(scope) {
  const { input, ports } = scope.$getEnv();
  scope.plan = ports.admitPlan(input.planBytes, input.family, input.context.manifest.version);
  scope.mode = input.mode;
}

export function routeStage(scope) {
  return decide(
    scope,
    [
      { when: { mode: { eq: 'pack' } }, then: 'pack', label: 'Build same-run artifacts' },
      { when: { mode: { eq: 'audit' } }, then: 'audit', label: 'Run original consumer commands' },
    ],
    { branch: 'refuse', label: 'Unsupported operation' },
  );
}

export function refuseStage() {
  throw new Error('unsupported cohort operation');
}
