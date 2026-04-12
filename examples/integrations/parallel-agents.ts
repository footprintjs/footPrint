/**
 * Parallel Agents — Fan-out/fan-in with LLM merge.
 *
 * Runs research and writing agents concurrently, then merges
 * results with an LLM call. Each branch runs in isolated scope.
 *
 * Run: npx ts-node examples/quick-start/parallel-agents.ts
 */

import { Parallel, Agent } from 'agentfootprint';
import type { LLMProvider } from 'agentfootprint';

// Mock provider for demonstration
function mockLLM(): LLMProvider {
  let call = 0;
  return {
    chat: async () => {
      call++;
      if (call === 1) return { content: 'Combined analysis: AI safety requires both technical rigor and clear communication...' };
      return { content: 'Fallback response.' };
    },
  };
}

// Mock runners (in production, these would be Agent.create({provider}).build())
const researchRunner = {
  run: async (message: string) => ({
    content: `Research findings on "${message}":\n- Key risk: misalignment between AI objectives and human values\n- Current approaches: RLHF, constitutional AI, interpretability\n- Open problems: scalable oversight, deceptive alignment`,
    messages: [],
    iterations: 1,
  }),
};

const writingRunner = {
  run: async (message: string) => ({
    content: `Draft on "${message}":\nArtificial intelligence safety is one of the most critical challenges facing technology today. As systems become more capable, ensuring they remain aligned with human values becomes paramount.`,
    messages: [],
    iterations: 1,
  }),
};

(async () => {
  const provider = mockLLM();

  const parallel = Parallel.create({ provider, name: 'report-pipeline' })
    .agent('research', researchRunner, 'Deep research on the topic')
    .agent('writing', writingRunner, 'Draft initial content')
    .mergeWithLLM('Synthesize the research findings and writing draft into a final, coherent report. Incorporate specific data from the research into the writing.')
    .build();

  console.log('=== Parallel Agent Execution ===\n');
  console.log('Running research + writing in parallel...\n');

  const result = await parallel.run('AI safety in 2026');

  console.log('--- Branch Results ---');
  for (const branch of result.branches) {
    console.log(`\n[${branch.id}] (${branch.status}):`);
    console.log(`  ${branch.content.slice(0, 100)}...`);
  }

  console.log('\n--- Merged Result ---');
  console.log(result.content);

  console.log('\n--- Narrative ---');
  parallel.getNarrative().forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
