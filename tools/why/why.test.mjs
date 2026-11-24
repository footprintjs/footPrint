import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectSnapshotKey } from './inspect.mjs';

function commit(runtimeStageId, idx, overwrite) {
  return {
    idx,
    runtimeStageId,
    stageId: runtimeStageId,
    stage: runtimeStageId,
    overwrite,
    updates: {},
    trace: Object.keys(overwrite).map((path) => ({ path, verb: 'set' })),
    redactedPaths: [],
  };
}

function fixture() {
  const row = {
    kind: 'source-link',
    version: 1,
    consumer: 'prepare',
    linkBasis: 'citation',
    namedBy: 'model',
    check: 'value-found',
    input: { key: 'history', element: 0 },
    output: { key: 'answer', checkedIn: 'written' },
  };
  const snapshot = {
    runId: 'run',
    logAddress: { logRunId: 'run', drillPath: [] },
    initialState: { history: ['input-only-value'] },
    commitLog: [
      commit('prepare', 0, {
        served: [{ kind: 'served', version: 1, consumer: 'prepare', served: [{ key: 'history', elements: [[0, 1]] }] }],
        prepared: true,
      }),
      commit('answer', 1, { answer: 'output-only-value', evidence: [row] }),
      commit('reassert', 2, {}),
    ],
    executionTree: {
      id: 'prepare',
      runtimeStageId: 'prepare',
      stageReads: { history: ['input-only-value'] },
      next: {
        id: 'answer',
        runtimeStageId: 'answer',
        stageReads: { prepared: true },
        next: {
          id: 'reassert',
          runtimeStageId: 'reassert',
          stageWrites: { answer: 'output-only-value' },
        },
      },
    },
    controlDeps: {},
  };
  const sourceLinks = {
    version: 1,
    status: 'captured',
    limitations: [],
    links: [{
      consumer: { runtimeStageId: 'prepare' },
      linkBasis: row.linkBasis,
      namedBy: row.namedBy,
      check: row.check,
      input: row.input,
      output: { ...row.output, runtimeStageId: 'answer', commitIdx: 1 },
      served: { key: 'served' },
      witness: { key: 'evidence', element: 0, runtimeStageId: 'answer', commitIdx: 1 },
    }],
  };
  return { snapshot, sourceLinks };
}

test('reports the writer, its data dependency, and the later same-value write', async () => {
  const { snapshot } = fixture();
  const report = await inspectSnapshotKey(snapshot, 'answer');
  assert.deepEqual(report.writer, { runtimeStageId: 'answer', commitIdx: 1 });
  assert.ok(report.walk.edges.some((edge) => edge.kind === 'data' && edge.to.includes('"key":"prepared"')), JSON.stringify(report.walk));
  assert.deepEqual(report.unchangedWrites.writes.map((write) => write.runtimeStageId), ['reassert']);
  assert.deepEqual(report.sourceLinks, { status: 'not-collected' });
  assert.doesNotMatch(JSON.stringify(report), /input-only-value|output-only-value/);
});

test('a retained source link does not change the causal walk', async () => {
  const { snapshot, sourceLinks } = fixture();
  const report = await inspectSnapshotKey(snapshot, 'answer', sourceLinks);
  const baseline = await inspectSnapshotKey(snapshot, 'answer');
  assert.deepEqual(report.walk, baseline.walk);
  assert.equal(report.sourceLinks.links[0]?.standing, 'witnessed', JSON.stringify(report.sourceLinks));
  assert.doesNotMatch(JSON.stringify(report), /input-only-value|output-only-value/);
});

test('surfaces missing identity and distinguishes a key without a visible writer', async () => {
  const { snapshot } = fixture();
  const missingKey = await inspectSnapshotKey(snapshot, 'unwritten');
  assert.deepEqual(missingKey.writerBasis, ['never-written']);
  assert.equal(missingKey.walk, null);
  assert.equal(missingKey.sourceLinks.status, 'not-queried');
  const missingAddress = await inspectSnapshotKey({ ...snapshot, logAddress: undefined }, 'answer');
  assert.deepEqual(missingAddress.projectionGaps, [{ code: 'not-collected' }]);
  assert.equal(missingAddress.writer, null);
});

test('the command reads saved JSON, accepts a bound inventory, and rejects malformed input', async (context) => {
  const { snapshot, sourceLinks } = fixture();
  const directory = await mkdtemp(join(tmpdir(), 'footprint-why-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const snapshotPath = join(directory, 'snapshot.json');
  const sourceLinksPath = join(directory, 'source-links.json');
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  await writeFile(sourceLinksPath, JSON.stringify(sourceLinks));

  const command = fileURLToPath(new URL('why.mjs', import.meta.url));
  const run = () => spawnSync(process.execPath, [command, snapshotPath, 'answer', '--source-links', sourceLinksPath], {
    encoding: 'utf8',
  });
  const completed = run();
  assert.equal(completed.status, 0, completed.stderr);
  assert.deepEqual(JSON.parse(completed.stdout), await inspectSnapshotKey(snapshot, 'answer', sourceLinks));

  await writeFile(snapshotPath, '{');
  const refused = run();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not valid JSON/);
  assert.equal(refused.stdout, '');
});
