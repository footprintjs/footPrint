---
name: Streaming
group: Features
guide: https://footprintjs.github.io/footPrint/guides/features/streaming/
---

# Streaming — Tokens in Real Time

A **streaming stage** emits tokens (or chunks) as they arrive — perfect for LLM responses, file processing, event streams, and anything where you want the user to see partial output before the full result is ready.

```
UserQuery → CallLLM (streaming) → Format
                │
                ├── "The" → "quick" → "brown" → "fox"     (tokens stream)
                └── final: "The quick brown fox"
```

## When to use

- **LLM token-by-token responses** — show output as it's generated, don't wait for completion.
- **Long-running computations** with progress (percent complete, milestones).
- **Server-sent events / WebSocket stages** that yield chunks over time.
- **Agent traces** — stream intermediate reasoning as the agent thinks.

## The StreamCallback lifecycle

```typescript
// The streaming stage's 3rd arg is `streamCallback` — call it once per chunk.
.addStreamingFunction('CallLLM', async (scope, _breakFn, streamCallback) => {
  let full = '';
  for await (const token of llmClient.stream(prompt)) {
    streamCallback(token);   // push a chunk to the executor's stream handlers
    full += token;
  }
  scope.fullResponse = full;  // assemble the final text yourself
}, 'call-llm')
```

The consumer observes tokens by passing `StreamHandlers` to the executor:

```typescript
const executor = new FlowChartExecutor(chart, {
  streamHandlers: {
    onStart: (ctx) => {/* stream began */},
    onToken: (token, ctx) => console.log(token),  // per chunk → route to UI
    onEnd: (ctx) => {/* stream complete */},
  },
});
```

## What the narrative captures

Each chunk fires an event, but the narrative summarizes by default:

```
Stage 2: CallLLM
  Stream started
  42 chunks received (2,134 chars)
  Stream done
```

Click into the Inspector to see individual tokens with timestamps. The full text is available in scope after the stream closes.

## Back-pressure and cancellation

- Upstream can cancel via `scope.$break()` — the stream stops cleanly.
- Throwing from the stage signals a streaming error (LLM disconnect, rate limit) — it propagates as a normal stage error.
- Timeouts and `AbortSignal` via `run({ env: { signal } })` cancel in-flight streams.

## Consumer patterns

**React**: `streamHandlers.onToken` → setState → user sees live updates.

**Node server**: `streamHandlers.onToken` → `res.write(token)` → browser's fetch sees Server-Sent Events.

**Recorder**: Attach a custom StreamRecorder to log tokens to a DB for audit.

## Streaming ≠ async iterator

A streaming stage is still **one stage** — the flow moves to the next stage when the stage function **returns**. It doesn't branch or fork. Inside the stage, you decide what to do with each chunk.

If you need **multiple parallel streams**, combine streaming with Fork or Subflow.

## Key API

- `.addStreamingFunction('Name', fn, 'id', streamId?, description?)` — declare a streaming stage.
- `streamCallback(chunk)` — the stage fn's 3rd arg; push a chunk.
- `new FlowChartExecutor(chart, { streamHandlers })` — observe via `{ onStart, onToken, onEnd }`.
- The stage ends when its function returns; throwing signals a stream error.

## Related

- **[Stream + Subflow](./streaming/02-subflow.md)** — stream inside a mounted subflow.
- **[Stream + Loop](./streaming/03-loop.md)** — resume streaming across loop iterations.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/features/streaming/)** — back-pressure, AbortSignal integration, and consumer patterns.
