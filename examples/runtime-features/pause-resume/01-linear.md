---
name: Pause / Resume
group: Runtime Features
guide: https://footprintjs.github.io/footPrint/guides/features/pause-resume/
---

# Pause / Resume — Human in the Loop

A **pausable stage** stops execution and hands back a **JSON-serializable checkpoint**. Hours, days, or a different server later, `resume(checkpoint, input)` continues from exactly where it paused.

```
ReceiveRequest → ManagerApproval (PAUSE) → ProcessRefund → Notify
                     ↓                         ↑
                  checkpoint              human decision
```

## When to use

- **Human-in-the-loop approvals** — manager sign-off on refunds, reviewer approval on hires, legal review on contracts.
- **Async human input** — send a Slack message, wait for response, resume with the answer.
- **Long-running workflows** — pause for a batch job, a webhook, a scheduled event.
- **AI agents requesting confirmation** — pause before risky tool calls (deleting data, sending money).

## The pattern

```typescript
const approvalGate: PausableHandler<RefundState> = {
  execute: async (scope) => {
    // Return data = PAUSE. Return void = continue.
    return { question: `Approve $${scope.amount} refund?` };
  },
  resume: async (scope, input) => {
    scope.approved = input.approved;
    scope.approver = input.approver;
  },
};

const chart = flowChart('ReceiveRequest', ..., 'receive')
  .addPausableFunction('ManagerApproval', approvalGate, 'approval')
  .addFunction('ProcessRefund', ...)
  .build();
```

## What makes this powerful

**The checkpoint is pure JSON.** No closures, no class instances, no function references. Store it in Redis, Postgres, S3 — anywhere. When you're ready:

```typescript
await executor.resume(checkpoint, { approved: true, approver: 'Alice' });
```

And the **same execution runtime** continues — the narrative, metrics, commit log all extend from the exact point of pause. It's **not** a new run that replays history.

## Conditional pause

Return `undefined` from `execute` and the flow continues normally — no pause. Useful when only *some* cases need approval:

```typescript
execute: async (scope) => {
  if (scope.amount < 500) return;  // auto-approve small refunds
  return { question: `Approve $${scope.amount}?` };
},
```

## Key API

- `.addPausableFunction('Name', { execute, resume }, 'id')` — mount a pausable stage.
- `executor.isPaused()` — after `run()`, check if we paused.
- `executor.getCheckpoint()` — get the JSON checkpoint to persist.
- `executor.resume(checkpoint, input)` — resume with the human's answer.

## Narrative awareness

FlowRecorder fires `onPause` and `onResume` events on both observer systems. Custom recorders can:
- Persist pause state to a DB
- Send Slack / email notifications when pausing
- Alert on resume ("refund approved by Alice at 3:42 PM")

## Related

- **[Pause in Decider](./02-decider.md)** — pause inside a conditional branch.
- **[Pause in Subflow](./03-subflow.md)** — pause inside a nested flow.
- **[Full guide](https://footprintjs.github.io/footPrint/guides/features/pause-resume/)** — checkpoint shape, resumption semantics, and persistence patterns.
