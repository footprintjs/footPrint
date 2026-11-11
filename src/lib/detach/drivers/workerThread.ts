/**
 * detach/drivers/workerThread.ts — Run detached work in a Node.js
 *                                  Worker Thread (or browser Web Worker).
 *
 * Pattern:  Adapter — translates the consumer's child flowchart into
 *           a worker message + lifecycle handoff. The worker is owned
 *           by the driver instance (a given `worker`, or one built from
 *           `workerScript` on first use).
 *
 * When the worker stops:
 *   - Node (`worker.on`): `error` or `exit` means the worker is gone.
 *     Every in-flight handle fails and is unregistered, and the worker
 *     is dropped. The lost work is NOT retried. The next `schedule()`
 *     builds a fresh worker from `workerScript`; a given `worker`
 *     cannot be rebuilt, so its later handles fail. A late reply for a
 *     handle that already failed is ignored.
 *   - Web Worker (`addEventListener`): there is no stop signal. An
 *     uncaught error does not end a Web Worker, and its `error` event
 *     cannot be tied to one task, so the driver listens to `message`
 *     only. The worker must answer every message, failures included;
 *     a message it never answers leaves its handle `running`.
 *   - The driver never calls `terminate()`: the worker is yours.
 *   - With `addDetachAndForget` nobody holds the handle, so a crash is
 *     visible only to code that keeps the handle or flushes
 *     (`flushAllDetached`).
 * Role:     CPU-isolation driver — when detached work is genuinely
 *           expensive (heavy parsing, hashing, image processing) and
 *           you don't want it blocking the main thread's event loop
 *           even for a microtask burst.
 *
 * Caveats / IMPORTANT v1 limitations:
 *   - The worker entry point is a CONSUMER-PROVIDED file path / URL —
 *     this driver does NOT auto-spawn FlowChartExecutor in a worker.
 *     Workers can't `import('footprintjs')` portably without setup,
 *     and the worker file's lifecycle differs by runtime
 *     (Node Worker vs Web Worker vs Bun). Consumer writes the worker
 *     code; this driver just hands them a uniform `(input, handle)`
 *     API.
 *   - The "child flowchart" parameter is IGNORED in v1 (we only ship
 *     the input). The chart shape doesn't survive structuredClone +
 *     postMessage anyway. v2 may add a serialization protocol.
 *
 * Two ways to consume:
 *
 *   1. Node.js: pass a file path
 *      `createWorkerThreadDriver({ workerScript: '/path/to/worker.js' })`
 *
 *   2. Browser: pass a URL or pre-built Worker instance
 *      `createWorkerThreadDriver({ worker: new Worker(url) })`
 */

import type { FlowChart } from '../../builder/types.js';
import { asError } from '../errors.js';
import { asImpl, createHandle } from '../handle.js';
import { register, unregister } from '../registry.js';
import type { DetachDriver, DetachHandle } from '../types.js';

// Node-only CommonJS `require`. We don't ship @types/node, so declare
// the minimal shape here. Used only in the lazy `workerScript` path;
// browser consumers pass a pre-constructed `Worker` and never hit it.
declare const require: ((mod: string) => unknown) | undefined;

interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate?(): unknown;
  on?(event: string, listener: (msg: unknown) => void): void;
  addEventListener?(event: string, listener: (msg: unknown) => void): void;
}

export interface WorkerThreadDriverOptions {
  /** Pre-constructed Worker instance. Pass either this OR
   *  `workerScript` — not both. */
  readonly worker?: WorkerLike;
  /** Path / URL to the worker script. Used only when `worker` is
   *  not provided; the driver constructs a Worker from this on demand
   *  (Node `worker_threads` API). */
  readonly workerScript?: string;
}

interface InFlight {
  readonly handle: DetachHandle;
}

let nextMessageId = 0;

export function createWorkerThreadDriver(opts: WorkerThreadDriverOptions): DetachDriver {
  let worker: WorkerLike | undefined;
  /** Set once the given `worker` stopped: there is no factory to rebuild it. */
  let givenWorkerStopped = false;
  const inFlight = new Map<number, InFlight>();

  /** The current Node worker stopped: fail what it held and drop it. It is never terminated here: it is gone. */
  function onStopped(stopped: WorkerLike, cause: unknown): void {
    if (worker !== stopped) return; // a worker already dropped (e.g. the `exit` after its `error`)
    worker = undefined;
    if (!opts.workerScript) givenWorkerStopped = true;
    const error = new Error(`[detach] workerThreadDriver: the worker stopped (${asError(cause).message}).`);
    for (const [messageId, slot] of [...inFlight]) {
      inFlight.delete(messageId);
      const impl = asImpl(slot.handle);
      impl._markFailed(error);
      unregister(impl.id);
    }
  }

  // If consumer provided a Worker at construction time, bind its
  // handlers eagerly so replies are routed back to handles.
  // Lazy construction (via `workerScript`) defers binding to first use.
  if (opts.worker) {
    worker = opts.worker;
    bindWorker(worker, inFlight, onStopped);
  }

  function ensureWorker(): WorkerLike {
    if (worker) return worker;
    if (!opts.workerScript) {
      throw new Error(
        givenWorkerStopped
          ? '[detach] workerThreadDriver: the given `worker` stopped and cannot be rebuilt; ' +
            'pass `workerScript` to have the driver build a fresh one.'
          : '[detach] workerThreadDriver: provide either `worker` (a constructed Worker) ' +
            'or `workerScript` (a path/URL) at driver creation.',
      );
    }
    // Lazy-import Node's worker_threads — keeps browser bundles clean.
    if (typeof require !== 'function') {
      throw new Error('[detach] workerThreadDriver: `workerScript` requires Node.js (CommonJS `require`).');
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Worker } = require('worker_threads') as { Worker: new (s: string) => WorkerLike };
    worker = new Worker(opts.workerScript);
    bindWorker(worker, inFlight, onStopped);
    return worker;
  }

  return {
    name: 'worker-thread',
    capabilities: { nodeSafe: true, cpuIsolated: true },
    validate(): void {
      if (!opts.worker && !opts.workerScript) {
        throw new Error('[detach] workerThreadDriver requires either a pre-built `worker` or a `workerScript` path.');
      }
    },
    schedule(_child: FlowChart, input: unknown, refId: string): DetachHandle {
      const handle = createHandle(refId);
      register(handle);
      const impl = asImpl(handle);
      impl._markRunning();

      const messageId = nextMessageId++;
      inFlight.set(messageId, { handle });

      try {
        const w = ensureWorker();
        w.postMessage({ messageId, refId, input });
      } catch (err) {
        impl._markFailed(asError(err));
        unregister(impl.id);
        inFlight.delete(messageId);
      }

      return handle;
    },
  };
}

function bindWorker(
  worker: WorkerLike,
  inFlight: Map<number, InFlight>,
  onStopped: (worker: WorkerLike, cause: unknown) => void,
): void {
  const handler = (msg: unknown): void => {
    const m = msg as { messageId?: number; ok?: boolean; result?: unknown; error?: string } | undefined;
    if (!m || typeof m.messageId !== 'number') return;
    const slot = inFlight.get(m.messageId);
    if (!slot) return;
    inFlight.delete(m.messageId);

    const impl = asImpl(slot.handle);
    if (m.ok) {
      impl._markDone(m.result);
    } else {
      impl._markFailed(new Error(m.error ?? 'worker reported failure'));
    }
    unregister(impl.id);
  };

  // Node Worker (worker_threads): EventEmitter-shape (`on('message', ...)`). `error` and `exit` mean it is gone.
  if (typeof worker.on === 'function') {
    worker.on('message', handler);
    worker.on('error', (err) => onStopped(worker, err));
    worker.on('exit', (code) => onStopped(worker, `exit code ${String(code)}`));
  }
  // Browser Worker / Web Worker: EventTarget-shape (`addEventListener`). It has no stop signal: an `error`
  // event does not end the worker and names no task, so only replies are heard.
  else if (typeof worker.addEventListener === 'function') {
    worker.addEventListener('message', (evt: unknown) => handler((evt as { data?: unknown })?.data));
  }
}
