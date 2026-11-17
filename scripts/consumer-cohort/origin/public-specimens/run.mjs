// Code-owned public archive probe; run only in its admitted neutral install root.
// Native ESM imports select the package's public import-condition entries.
import assert from 'node:assert/strict';
import { Agent } from 'agentfootprint';
import { MockProvider } from 'agentfootprint/providers';
import { recordRun, buildRecordingEnvelope } from 'agentfootprint/observe';

async function main() {
  const expected = process.argv.slice(2);
  assert.equal(expected.length, 2, 'Supply the two exact admitted audit versions');
  const [agentfootprintVersion, footprintjsVersion] = expected;
  assert.equal(typeof agentfootprintVersion, 'string');
  assert.equal(typeof footprintjsVersion, 'string');

  const reply = 'paired-version-specimen-ok';
  const agent = Agent.create({
    provider: new MockProvider({ replies: [reply], thinkingMs: 0, chunkDelayMs: 0 }),
    model: 'mock',
  })
    .system('Return the scripted reply.')
    .build();
  const recorder = recordRun(agent);
  let report;
  try {
    const answer = await agent.run({ message: 'Run the local version specimen.' });
    assert.equal(answer, reply, 'The real agent must finish with the scripted reply');
    // The caller states completion after awaiting this one real, successful run.
    const envelope = buildRecordingEnvelope(recorder, { run: { complete: true } });
    assert.equal(envelope.format, 'agentfootprint.recording.v1');
    assert.deepEqual(envelope.producer, { agentfootprintVersion, footprintjsVersion });
    assert.ok(envelope.recording.events.length > 0);
    assert.ok(envelope.recording.snapshot !== undefined && envelope.recording.snapshot !== null);
    assert.ok(envelope.recording.structure !== undefined && envelope.recording.structure !== null);
    assert.equal(envelope.run.droppedEvents, 0);
    assert.equal(typeof envelope.run.runId, 'string');
    assert.ok(envelope.run.runId.length > 0);
    report = {
      specimen: 'public-producer-version-with-mock-agent',
      format: 'esm',
      node: process.versions.node,
      producer: envelope.producer,
      recordedEvents: envelope.recording.events.length,
      droppedEvents: envelope.run.droppedEvents,
      resolvedPublicEntries: {
        root: import.meta.resolve('agentfootprint'),
        providers: import.meta.resolve('agentfootprint/providers'),
        observe: import.meta.resolve('agentfootprint/observe'),
      },
    };
  } finally {
    try {
      recorder.stop();
    } finally {
      await agent.shutdown();
    }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
