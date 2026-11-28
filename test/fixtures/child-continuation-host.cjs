'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const question = 'Approve the synthetic refund?';

async function worker() {
  const esm = process.argv[3] === 'esm';
  const { flowChart, FlowChartExecutor, interrupt } = esm ? await import('footprintjs') : require('footprintjs');
  const { createChildContinuation } = esm
    ? await import('footprintjs/child-continuation')
    : require('footprintjs/child-continuation');
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const calls = { lookup: 0, executeHalf: 0, resumeHalf: 0, interruptBody: 0, interruptAnswered: 0, refund: 0 };
  const syntheticError = new Error('provider declined the synthetic refund');
  const finance = flowChart(
    'Find order',
    (scope) => {
      calls.lookup++;
      scope.order = { id: 'order-fixture', amount: 42 };
    },
    'order',
  )
    .addPausableFunction(
      'Manager approval',
      {
        execute() {
          calls.executeHalf++;
          return { reason: question };
        },
        resume(scope, answer) {
          calls.resumeHalf++;
          scope.managerApproved = answer?.approved === true;
        },
      },
      'manager',
    )
    .addFunction(
      'Payment approval',
      (scope) => {
        if (!scope.managerApproved) return;
        calls.interruptBody++;
        const answer = interrupt(scope, { reason: question });
        calls.interruptAnswered++;
        scope.paymentApproved = answer?.approved === true;
      },
      'payment',
    )
    .addFunction(
      'Settle actual result',
      (scope) => {
        if (!scope.managerApproved || !scope.paymentApproved) return { outcome: 'declined' };
        if (request.fail) throw syntheticError;
        calls.refund++;
        return { outcome: 'refunded', receipt: 'refund-' + scope.order.id, amount: scope.order.amount };
      },
      'effect',
    )
    .build();
  const shape = flowChart(
    'Return the original shape',
    () => ({ paused: true, checkpoint: { fake: true } }),
    'shape',
  ).build();
  const parent = flowChart('Parent enters', () => {}, 'root')
    .addSubFlowChartNext('finance', finance, 'Finance', { outputMapper: (value) => ({ finance: value }) })
    .addFunction('Return finished finance result', (scope) => scope.finance, 'parent-finished')
    .build();
  const chart = request.variant === 'shape' ? shape : request.variant === 'mounted' ? parent : finance;
  if (request.variant === 'bridge') {
    const binding = { occurrence: 'conversation-1/turn-1/call-2', implementation: 'finance-impl@1+policy@1' };
    let loads = 0;
    const child = createChildContinuation(
      binding,
      (implementation) => {
        assert.equal(implementation, binding.implementation);
        loads++;
        return new FlowChartExecutor(chart);
      },
      request.restoring ? { kind: 'restore', saved: request.saved } : { kind: 'new' },
    );
    try {
      const entry = request.restoring
        ? { kind: 'answer', gate: request.gate, answer: request.answer }
        : { kind: 'start' };
      const outcome = await child.advance(entry);
      process.stdout.write(JSON.stringify({ pid: process.pid, calls, loads, outcome }));
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          pid: process.pid,
          calls,
          loads,
          error: { message: error.message, original: error === syntheticError },
        }),
      );
    }
    return;
  }
  return (async () => {
    const executor = new FlowChartExecutor(chart);
    try {
      const raw = request.checkpoint ? await executor.resume(request.checkpoint, request.answer) : await executor.run();
      const checkpoint = executor.getCheckpoint();
      process.stdout.write(
        JSON.stringify({
          pid: process.pid,
          calls,
          result: checkpoint ? undefined : raw,
          paused: checkpoint !== undefined,
          checkpoint,
        }),
      );
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          pid: process.pid,
          calls,
          pause: false,
          error: { name: error.name, message: error.message, original: error === syntheticError },
        }),
      );
    }
  })();
}

function leg(request) {
  const child = spawnSync(process.execPath, [__filename, 'worker', process.argv[2]], {
    encoding: 'utf8',
    input: JSON.stringify(request),
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

function chain(variant) {
  const start = leg({ variant });
  const first = leg({ variant, checkpoint: start.checkpoint, answer: { approved: true } });
  const finish = leg({ variant, checkpoint: first.checkpoint, answer: { approved: true } });
  assert.equal(new Set([start.pid, first.pid, finish.pid]).size, 3);
  assert.equal(start.checkpoint.checkpointVersion, 2);
  assert.equal(start.checkpoint.pausedBy, undefined);
  assert.equal(first.checkpoint.pausedBy, 'interrupt');
  assert.equal(start.checkpoint.pauseData.reason, first.checkpoint.pauseData.reason);
  assert.notDeepEqual(start.checkpoint.pausedExecution, first.checkpoint.pausedExecution);
  assert.deepEqual(first.calls, {
    lookup: 0,
    executeHalf: 0,
    resumeHalf: 1,
    interruptBody: 1,
    interruptAnswered: 0,
    refund: 0,
  });
  assert.deepEqual(finish.calls, {
    lookup: 0,
    executeHalf: 0,
    resumeHalf: 0,
    interruptBody: 1,
    interruptAnswered: 1,
    refund: 1,
  });
  assert.equal(start.calls.lookup, 1);
  assert.equal(start.calls.executeHalf, 1);
  assert.equal(start.calls.refund, 0);
  assert.deepEqual(finish.result, { outcome: 'refunded', receipt: 'refund-order-fixture', amount: 42 });
  assert.equal(finish.paused, false);
  return [start, first, finish];
}

if (process.argv[2] === 'worker') {
  worker().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  const earlier = { tool: 'VIP lookup', result: { vip: true } };
  let host = { earlier, current: undefined, gate: undefined, finished: undefined };
  const invoke = (gate, answer, extra = {}) => {
    const result = leg({
      variant: 'bridge',
      restoring: host.current !== undefined,
      saved: host.current,
      gate,
      answer,
      ...extra,
    });
    if (result.outcome?.kind === 'waiting') {
      host = JSON.parse(JSON.stringify({ ...host, current: result.outcome.saved, gate: result.outcome.gate }));
    } else if (result.outcome?.kind === 'finished') {
      assert.equal(host.finished, undefined);
      host = { earlier: host.earlier, finished: result.outcome.value };
    }
    return result;
  };
  const start = invoke();
  assert.equal(start.outcome.kind, 'waiting');
  assert.equal(start.outcome.pauseData.reason, question);
  assert.equal(start.loads, 1);
  const firstGate = host.gate;
  const next = invoke(firstGate, { approved: true });
  assert.equal(next.loads, 1);
  assert.equal(next.outcome.kind, 'waiting');
  assert.equal(next.outcome.pauseData.reason, question);
  assert.notDeepEqual(host.gate, firstGate);
  assert.equal(host.gate.revision, firstGate.revision + 1);
  const old = invoke(firstGate, { approved: true });
  assert.equal(old.outcome.kind, 'unavailable');
  assert.equal(old.loads, 0);
  assert.equal(old.calls.refund, 0);
  const final = invoke(host.gate, { approved: true });
  assert.equal(final.outcome.kind, 'finished');
  assert.equal(final.loads, 1);
  assert.equal(new Set([start.pid, next.pid, final.pid]).size, 3);
  const mounted = chain('mounted');
  assert.deepEqual(
    [start.calls, next.calls, final.calls],
    mounted.map((row) => row.calls),
  );
  assert.deepEqual(host.finished, { outcome: 'refunded', receipt: 'refund-order-fixture', amount: 42 });
  assert.deepEqual([host.earlier, host.finished], [earlier, mounted[2].result]);
  const denied = leg({
    variant: 'bridge',
    restoring: true,
    saved: start.outcome.saved,
    gate: firstGate,
    answer: { approved: false },
  });
  assert.deepEqual(denied.outcome, { kind: 'finished', value: { outcome: 'declined' } });
  assert.equal(denied.calls.refund, 0);
  const failure = leg({
    variant: 'bridge',
    restoring: true,
    saved: next.outcome.saved,
    gate: next.outcome.gate,
    answer: { approved: true },
    fail: true,
  });
  assert.equal(failure.error.original, true);
  assert.equal(failure.calls.refund, 0);
  process.stdout.write(
    JSON.stringify(
      {
        format: process.argv[2],
        node: process.version,
        processIds: [start.pid, next.pid, final.pid],
        calls: [start.calls, next.calls, final.calls],
        waitingRevisions: [firstGate.revision, next.outcome.gate.revision],
        staleLoaderCalls: old.loads,
        denialRefunds: denied.calls.refund,
        originalFailure: failure.error.original,
        receipt: host.finished,
      },
      null,
      2,
    ) + '\n',
  );
}
