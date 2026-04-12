/**
 * Agent with Persistent Memory
 *
 * Demonstrates multi-turn conversation memory using agentfootprint.
 *
 * The memory stack:
 *   PrepareMemory subflow — loads stored history from ConversationStore before
 *     each turn, applies an optional MessageStrategy (sliding window, summarize, etc.)
 *   CommitMemory stage   — fire-and-forget save after the turn completes
 *
 * Flowchart (with memory):
 *   SeedScope → PrepareMemory → ApplyPreparedMessages → PromptAssembly
 *     → CallLLM → ParseResponse → HandleResponse → CommitMemory → loopTo(CallLLM)
 *
 * Both PrepareMemory and CommitMemory appear in the narrative — the LLM context
 * window management is now visible and explainable.
 *
 * This demo uses the mock() adapter so no API key is required.
 */

import { Agent, InMemoryStore, mock, userMessage, assistantMessage } from 'agentfootprint';
import { FlowChartExecutor } from 'footprintjs';

// ── Shared store ──────────────────────────────────────────────────────────────
// In production: swap InMemoryStore for RedisStore, PostgresStore, DynamoDBStore, etc.
const store = new InMemoryStore();

// ── Mock LLM ─────────────────────────────────────────────────────────────────
// Two responses for a two-turn conversation
const provider = mock([
  { content: 'Nice to meet you, Alice! I\'ll remember your name.' },
  { content: 'Your name is Alice — you told me in our first message.' },
]);

// ── Turn 1: Fresh conversation ────────────────────────────────────────────────
const agent = Agent.create({ provider, name: 'memory-demo' })
  .system('You are a helpful assistant with persistent memory.')
  .memory({ store, conversationId: 'demo-conv' })
  .build();

console.log('=== Turn 1 ===');
const turn1 = await agent.run('Hi! My name is Alice.');
console.log('Agent:', turn1.content);
console.log('Messages in store:', store.size('demo-conv'));
console.log();

// ── Inspect narrative after turn 1 ───────────────────────────────────────────
// The narrative shows PrepareMemory loading history and CommitMemory saving it
const narrative1 = agent.getNarrative();
console.log('=== Narrative (Turn 1) ===');
narrative1.forEach(line => console.log(' ', line));
console.log();

// ── Turn 2: Returning conversation ───────────────────────────────────────────
// A new agent instance using the SAME store — simulates a server restart.
// PrepareMemory will load the history from turn 1 before the LLM call.
const agent2 = Agent.create({ provider, name: 'memory-demo' })
  .system('You are a helpful assistant with persistent memory.')
  .memory({ store, conversationId: 'demo-conv' })
  .build();

console.log('=== Turn 2 (new agent instance, same store) ===');
const turn2 = await agent2.run('Do you remember my name?');
console.log('Agent:', turn2.content);
console.log('Messages in store:', store.size('demo-conv'));
console.log();

// ── Inspect snapshot ──────────────────────────────────────────────────────────
const snapshot2 = agent2.getSnapshot();
const messages = snapshot2?.sharedState?.messages as Array<{ role: string; content: string }> ?? [];
console.log('=== Final Message History ===');
messages.forEach(m => console.log(`  [${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`));
console.log();

// ── With sliding window strategy ──────────────────────────────────────────────
// Strategy trims history before each LLM call (protects context window).
// The store still holds the full history — only LLM context is trimmed.
console.log('=== With Sliding Window Strategy ===');
const windowStore = new InMemoryStore();
// Pre-seed with 6 messages
windowStore.save('windowed', [
  userMessage('Message 1'),
  assistantMessage('Reply 1'),
  userMessage('Message 2'),
  assistantMessage('Reply 2'),
  userMessage('Message 3'),
  assistantMessage('Reply 3'),
]);

const windowedAgent = Agent.create({ provider: mock([{ content: 'Got it.' }]) })
  .memory({
    store: windowStore,
    conversationId: 'windowed',
    strategy: { prepare: async (msgs) => msgs.slice(-4) },  // keep last 4
  })
  .build();

const windowedResult = await windowedAgent.run('New question');
console.log('Agent:', windowedResult.content);
console.log('Full store size:', windowStore.size('windowed'));
console.log('(Strategy trimmed to last 4 messages for LLM, full history stays in store)');
