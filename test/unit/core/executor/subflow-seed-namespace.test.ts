/**
 * Focused test: verify that seedSubflowGlobalStore writes to the correct
 * pipeline-namespaced path so that stages can read via getValue(['agent'], 'messages')
 */
import { PipelineRuntime } from '../../../../src/core/memory/PipelineRuntime';
import { seedSubflowGlobalStore } from '../../../../src/core/executor/handlers/SubflowInputMapper';

describe('seedSubflowGlobalStore pipeline namespace', () => {
  it('should write nested objects to pipeline-namespaced paths readable by getValue', () => {
    const runtime = new PipelineRuntime('test-subflow');
    const rootCtx = runtime.rootStageContext;

    seedSubflowGlobalStore(runtime, {
      agent: {
        messages: [{ role: 'user', content: 'Alex Chen', timestamp: Date.now() }],
      },
    });

    const messages = rootCtx.getValue(['agent'], 'messages');
    expect(Array.isArray(messages)).toBe(true);
    expect((messages as any[]).length).toBe(1);
    expect((messages as any[])[0].role).toBe('user');
  });

  it('should survive a second stage writing to the same namespace', () => {
    const runtime = new PipelineRuntime('test-subflow');
    const rootCtx = runtime.rootStageContext;

    seedSubflowGlobalStore(runtime, {
      agent: {
        messages: [{ role: 'user', content: 'Alex Chen', timestamp: Date.now() }],
      },
    });

    // Simulate SeedScope writing other agent keys
    rootCtx.setObject(['agent'], 'systemTemplate', 'You are a social media analyst');
    rootCtx.setObject(['agent'], 'maxIterations', 5);
    rootCtx.setObject(['agent'], 'loopCount', 0);
    rootCtx.commit();

    const messages = rootCtx.getValue(['agent'], 'messages');
    expect(Array.isArray(messages)).toBe(true);
    expect((messages as any[]).length).toBe(1);

    const template = rootCtx.getValue(['agent'], 'systemTemplate');
    expect(template).toBe('You are a social media analyst');
  });

  it('should be visible in createNext context (simulating SeedScope → AssemblePrompt)', () => {
    const runtime = new PipelineRuntime('test-subflow');
    const rootCtx = runtime.rootStageContext;

    // Step 1: seedSubflowGlobalStore writes messages (before SeedScope runs)
    seedSubflowGlobalStore(runtime, {
      agent: {
        messages: [{ role: 'user', content: 'Alex Chen', timestamp: Date.now() }],
      },
    });

    // Step 2: SeedScope runs on rootCtx, writes other keys, commits
    rootCtx.setObject(['agent'], 'systemTemplate', 'You are a social media analyst');
    rootCtx.setObject(['agent'], 'loopCount', 0);
    rootCtx.commit();

    // Step 3: createNext for the next stage (AssemblePrompt)
    const nextCtx = rootCtx.createNext('', 'AssemblePrompt');

    // Step 4: AssemblePrompt reads messages — should see the seeded data
    const messages = nextCtx.getValue(['agent'], 'messages');
    console.log('createNext messages:', messages);
    expect(Array.isArray(messages)).toBe(true);
    expect((messages as any[]).length).toBe(1);
    expect((messages as any[])[0].content).toBe('Alex Chen');
  });
});
