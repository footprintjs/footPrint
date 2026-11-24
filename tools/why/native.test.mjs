import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FlowChartExecutor, flowChart } from '../../dist/esm/index.js';

const command = fileURLToPath(new URL('why.mjs', import.meta.url));
const value = 'private-recorded-answer';
const start = () =>
  flowChart(
    'Set answer',
    (scope) => {
      scope.answer = value;
    },
    'set-answer',
  );

for (const commitValues of ['full', 'delta']) {
  test(`reports a deleted key separately from its removal stage in a native ${commitValues} record`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'footprint-why-native-'));
    context.after(() => rm(directory, { recursive: true, force: true }));

    async function savedReport(chart, name) {
      const executor = new FlowChartExecutor(chart, { commitValues });
      await executor.run();
      const snapshot = executor.getSnapshot();
      const location = join(directory, `${name}.json`);
      await writeFile(location, JSON.stringify(snapshot));
      const outcome = spawnSync(process.execPath, [command, location, 'answer'], { encoding: 'utf8' });
      assert.equal(outcome.status, 0, outcome.stderr);
      assert.ok(!outcome.stdout.includes(value));
      return { snapshot, report: JSON.parse(outcome.stdout) };
    }

    const deletion = start()
      .addFunction('Remove answer', (scope) => scope.$delete('answer'), 'remove-answer')
      .build();
    const { snapshot, report } = await savedReport(deletion, 'deleted');
    const remover = snapshot.commitLog.find(({ stageId }) => stageId === 'remove-answer');
    assert.ok(remover);
    assert.deepEqual(report.writer, {
      runtimeStageId: remover.runtimeStageId,
      commitIdx: snapshot.commitLog.indexOf(remover),
    });
    assert.ok(report.walk);
    assert.deepEqual(report.valueBasis, ['deleted']);

    const control = await savedReport(start().build(), 'set-only');
    assert.ok(control.report.writer);
    assert.deepEqual(control.report.valueBasis, []);
  });
}
