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
.addStreamingFunction('CallLLM', async (scope, stream) => {
  stream.onChunk((token) => {
    // Fires for every chunk — route to UI, aggregate, log.
    console.log(token);
  });

  // Call your LLM. stream.emit() pushes a chunk.
  for await (const token of llmClient.stream(prompt)) {
    stream.emit(token);
  }

  stream.done();  // signals end-of-stream
  scope.fullResponse = stream.fullText();  // final assembled text
}, 'call-llm')
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
- `stream.abort(error)` — signal a streaming error (LLM disconnect, rate limit).
- Timeouts and `AbortSignal` via `run({ env: { signal } })` cancel in-flight streams.

## Consumer patterns

**React**: `stream.onChunk` → setState → user sees live updates.

**Node server**: `stream.onChunk` → `res.write(chunk)` → browser's fetch sees Server-Sent Events.

**Recorder**: Attach a custom StreamRecorder to log tokens to a DB for audit.

## Streaming ≠ async iterator

A streaming stage is still **one stage** — the flow moves to the next stage only when `stream.done()` is called. It doesn't branch or fork. Inside the stage, you decide what to do with each chunk.

If you need **multiple parallel streams**, combine streaming with Fork or Subflow.

## Key API

- `.addStreamingFunction('Name', fn, 'id')` — declare a streaming stage.
- `stream.emit(chunk)` — push a chunk.
- `stream.onChunk(handler)` — listen for chunks.
- `stream.fullText()` — assembled text at end.
- `stream.done()` / `stream.abort(error)` — terminate.

## Related

- **[Stream + Subflow](./streaming/02-subflow.md)** — stream inside a mounted subflow.
- **[Stream + Loop](./streaming/03-loop.md)** — resume streaming across loop iterations.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/features/streaming/)** — back-pressure, AbortSignal integration, and consumer patterns.
