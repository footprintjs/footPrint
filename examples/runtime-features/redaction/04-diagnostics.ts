/** Explicit diagnostic retention; no post-run scrub or content scanning.
 * Run: npx tsx examples/runtime-features/redaction/04-diagnostics.ts
 */
import { flowChart, FlowChartExecutor, type EmitEvent } from 'footprintjs';

function check(condition: boolean): void {
  if (!condition) throw new Error('Diagnostic retention example failed');
}

async function main() {
  const profile = { token: 'private-token', label: 'conference-demo' };
  const chart = flowChart(
    'Observe',
    (scope) => {
      scope.$debug('profile', profile);
      scope.$error('secret', 'private-error');
      scope.$log(profile);
      scope.$log({ ...profile, label: 'second-message' });
      return profile;
    },
    'observe',
  ).build();
  const executor = new FlowChartExecutor(chart);
  executor.setRedactionPolicy({
    diagnostics: {
      keys: ['errors.secret'],
      fields: { logs: ['profile.token', 'messages.0.token'] },
    },
  });
  const events: EmitEvent[] = [];
  executor.attachEmitRecorder({ id: 'diagnostics-demo', onEmit: (event) => events.push(event) });
  const result = await executor.run();
  const tree = executor.getSnapshot().executionTree;
  check(Object.is(result, profile));
  check(profile.token === 'private-token');
  check(tree.errors.secret === '[REDACTED]');
  check(JSON.stringify(tree.logs.profile) === JSON.stringify({ token: '[REDACTED]', label: 'conference-demo' }));
  check(
    JSON.stringify(tree.logs.messages) ===
      JSON.stringify([
        { token: '[REDACTED]', label: 'conference-demo' },
        { token: '[REDACTED]', label: 'second-message' },
      ]),
  );
  check(!JSON.stringify(events).includes('private-token'));
  check(!JSON.stringify(events).includes('private-error'));
  console.log('Diagnostic values and legacy emitted payloads are masked; live result is unchanged.');
  // Boundary output and operational state are NOT selected by diagnostics.
  // Add state-key/boundary selectors separately before sharing those surfaces.
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
