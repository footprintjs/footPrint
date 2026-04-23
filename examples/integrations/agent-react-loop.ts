/**
 * Agent ReAct Loop — RouteResponse Decider Pattern
 *
 * Demonstrates the agent loop's decider architecture:
 *   ParseResponse -> RouteResponse(decider)
 *     |-- 'tool-calls' -> ExecuteTools subflow
 *     '-- 'final'      -> Finalize ($break)
 *
 * The RouteResponse decider is visible in the flowchart as a diamond with
 * two branches. The narrative shows WHY each branch was chosen.
 *
 * This demo uses mock() — no API key required.
 */

import { Agent, mock, defineTool } from 'agentfootprint';

// ── Define tools ──────────────────────────────────────────────────────────

const weatherTool = defineTool({
  id: 'get-weather',
  description: 'Get current weather for a city',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
  },
  handler: async ({ city }) => ({
    content: `${city}: 72°F, sunny with a light breeze`,
  }),
});

const unitsTool = defineTool({
  id: 'convert-units',
  description: 'Convert temperature between Fahrenheit and Celsius',
  inputSchema: {
    type: 'object',
    properties: { temp: { type: 'number' }, from: { type: 'string' } },
  },
  handler: async ({ temp, from }) => {
    const result = from === 'F' ? ((temp - 32) * 5) / 9 : (temp * 9) / 5 + 32;
    const to = from === 'F' ? 'C' : 'F';
    return { content: `${temp}°${from} = ${Math.round(result)}°${to}` };
  },
});

// ── Mock LLM: two tool calls then final answer ───────────────────────────
// Turn 1: Agent calls get-weather tool
// Turn 2: Agent calls convert-units tool
// Turn 3: Agent gives final answer (no tools)

const provider = mock([
  {
    content: 'Let me check the weather first.',
    toolCalls: [{ id: 'tc-1', name: 'get-weather', arguments: { city: 'San Francisco' } }],
  },
  {
    content: 'Now let me convert that to Celsius.',
    toolCalls: [{ id: 'tc-2', name: 'convert-units', arguments: { temp: 72, from: 'F' } }],
  },
  {
    content: 'San Francisco is currently 72°F (22°C), sunny with a light breeze. Perfect weather!',
  },
]);

// ── Build and run ────────────────────────────────────────────────────────

const agent = Agent.create({ provider, name: 'weather-agent' })
  .system('You are a weather assistant. Always convert temperatures to both F and C.')
  .tool(weatherTool)
  .tool(unitsTool)
  .maxIterations(5)
  .build();

console.log('=== Running Agent ReAct Loop ===');
console.log();

const result = await agent.run('What is the weather in San Francisco?');

console.log('Result:', result.content);
console.log('Iterations:', result.iterations);
console.log();

// ── Show message history (no duplicates!) ────────────────────────────────

console.log('=== Message History ===');
result.messages.forEach((m, i) => {
  const content = typeof m.content === 'string'
    ? m.content.slice(0, 80)
    : JSON.stringify(m.content).slice(0, 80);
  const extra = (m as any).toolCalls ? ' (+toolCalls)' : '';
  console.log(`  [${i}] ${m.role}: ${content}${extra}`);
});

// Verify: exactly 1 system, 1 user — no duplicates from the decider pattern
const systemCount = result.messages.filter(m => m.role === 'system').length;
const userCount = result.messages.filter(m => m.role === 'user').length;
console.log();
console.log(`  System messages: ${systemCount} (should be 1)`);
console.log(`  User messages: ${userCount} (should be 1)`);
console.log(`  Tool results: ${result.messages.filter(m => m.role === 'tool').length}`);
console.log();

// ── Show narrative — the decider decisions are visible ───────────────────

console.log('=== Narrative ===');
const narrative = agent.getNarrativeEntries().map(e => e.text);
narrative.forEach(line => console.log(' ', line));
console.log();

// ── Show structured entries — filter for decision events ─────────────────

const entries = agent.getNarrativeEntries();
const decisions = entries.filter((e: any) => e.type === 'condition');
console.log(`=== Decisions (${decisions.length} RouteResponse evaluations) ===`);
decisions.forEach((d: any) => console.log(' ', d.text));
