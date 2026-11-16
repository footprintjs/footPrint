import { readRunEvidence, readStoredRecord } from 'foottrace';
import { memorySink } from 'foottrace/write';
import { expect, it } from 'vitest';

import { decide, flowChart, FlowChartExecutor, interrupt } from '../../../index.js';

const SECRET = 'private-run-evidence-7319';

it.each(['keys', 'patterns', 'fields', 'mark', 'taint', 'args'])(
  '%s selection serves decision thresholds before the new note',
  async (mode) => {
    const sink = memorySink();
    const chart = flowChart(
      'Seed',
      (s) => {
        if (mode === 'mark') s.$setValue('secret', SECRET, true);
        else s.secret = SECRET;
        s.profile = { secret: SECRET };
        s.visible = 'ordinary';
      },
      'seed',
    )
      .addDeciderFunction(
        'Choose',
        (s) => {
          const key = mode === 'fields' ? 'profile' : mode === 'taint' || mode === 'args' ? 'visible' : 'secret';
          const threshold = mode === 'taint' ? s.secret : mode === 'args' ? s.$getArgs().credential : SECRET;
          return decide(s, [{ when: { [key]: { ne: threshold } }, then: 'yes' }], 'no');
        },
        'choose',
      )
      .addFunctionBranch('yes', 'Yes', () => {})
      .addFunctionBranch('no', 'No', () => {})
      .end()
      .build();
    const ex = new FlowChartExecutor(chart, { sink });
    if (mode === 'patterns') ex.setRedactionPolicy({ patterns: [/secret/] });
    else if (mode === 'fields') ex.setRedactionPolicy({ fields: { profile: ['secret'] } });
    else if (mode !== 'mark') ex.setRedactionPolicy({ keys: ['secret', 'credential'] });
    await ex.run({ input: { credential: SECRET } });
    const notes = sink.entries.filter((e) => e.kind === 'note' && e.note === 'run.decision');
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes)).not.toContain(SECRET);
    const run = readRunEvidence(readStoredRecord(sink.entries), sink.entries[0].address.logRunId);
    expect(run.unread).toEqual([]);
    expect(run.decisions.rows[0].evidence.rules[0].conditions[0].thresholdRedacted).toBe(true);
    // A name remains a name even under patterns; no generic note rescrub.
    expect(run.decisions.rows[0].evidence.rules[0].conditions[0].key).not.toBe('[REDACTED]');
  },
);

it.each(['pausable', 'interrupt'])(
  '%s stop uses the same served payload while the checkpoint stays real',
  async (kind) => {
    const sink = memorySink();
    const question = { secret: SECRET, profile: { id: SECRET, public: 'kept' } };
    const builder = flowChart('Seed', () => {}, 'seed');
    const chart = (
      kind === 'pausable'
        ? builder.addPausableFunction('Ask', { execute: () => question, resume: () => {} }, 'ask')
        : builder.addFunction('Ask', (s) => interrupt(s, question), 'ask')
    ).build();
    const ex = new FlowChartExecutor(chart, { sink });
    ex.setRedactionPolicy({ keys: ['secret'], fields: { profile: ['id'] } });
    let observed;
    ex.attachFlowRecorder({
      id: 'pause-observer',
      onPause: (event) => {
        observed = event.pauseData;
      },
    });
    await ex.run();
    const stop = sink.entries.find((e) => e.kind === 'note' && e.note === 'run.stop');
    expect(stop.data.pausedBy).toBe(kind);
    expect(stop.data.payload).toEqual(observed);
    expect(JSON.stringify(stop)).not.toContain(SECRET);
    expect(ex.getCheckpoint().pauseData).toEqual(question);
    expect(question.secret).toBe(SECRET);
  },
);

it('serves descriptions under the existing diagnostic text selector', async () => {
  const sink = memorySink();
  const chart = flowChart('Step', () => {}, 'step').build();
  chart.root.description = SECRET;
  const ex = new FlowChartExecutor(chart, { sink });
  ex.setRedactionPolicy({ diagnostics: { keys: ['flowMessages.description'] } });
  await ex.run();
  const about = sink.entries.find((e) => e.kind === 'commit').about;
  expect(about.description).toBe('[REDACTED]');
  expect(JSON.stringify(about)).not.toContain(SECRET);
});

it('uses the already served break reason and never changes the live value', async () => {
  const sink = memorySink();
  const chart = flowChart(
    'Seed',
    (s) => {
      s.secret = SECRET;
    },
    'seed',
  )
    .addFunction(
      'Stop',
      (s) => {
        s.$break(s.secret);
      },
      'stop',
    )
    .build();
  const ex = new FlowChartExecutor(chart, { sink });
  ex.setRedactionPolicy({ keys: ['secret', 'credential'] });
  await ex.run();
  const stop = sink.entries.find((e) => e.kind === 'note' && e.note === 'run.stop');
  expect(stop.data.reason).toBe('[REDACTED]');
  expect(ex.getSnapshot().sharedState.secret).toBe(SECRET);
});
