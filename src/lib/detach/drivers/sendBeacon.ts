/**
 * detach/drivers/sendBeacon.ts — Browser-only driver that ships work
 *                                via `navigator.sendBeacon` so it
 *                                survives page-unload.
 *
 * Pattern:  Strategy / Adapter — translates the consumer's child
 *           flowchart into a sendBeacon POST. The "child" is expected
 *           to produce a JSON-serializable payload via its
 *           `inputMapper`; the URL endpoint is set at driver creation.
 * Role:     The narrow but high-value driver for analytics / error
 *           reporting / page-leave telemetry — the one case where
 *           "fire-and-forget" must really mean "ships even if the
 *           user closes the tab right after."
 *
 * `navigator.sendBeacon` semantics:
 *   - Browser queues the POST in the OS network stack BEFORE returning
 *     control. Survives page-unload, navigation, refresh.
 *   - Limited to ~64 KB per call (per HTML5 spec).
 *   - Fire-and-forget — no response observable.
 *
 * Caveats:
 *   - Browser-only (`browserSafe: true, survivesUnload: true`).
 *     `validate()` throws helpfully if `navigator.sendBeacon` isn't a
 *     function (e.g., when imported in Node).
 *   - The driver does NOT run the child flowchart through a
 *     `FlowChartExecutor` — it serializes the input and POSTs. This
 *     is an intentional simplification: sendBeacon's semantics
 *     wouldn't survive an executor's async stages anyway.
 */

import type { FlowChart } from '../../builder/types.js';
import { asImpl, createHandle } from '../handle.js';
import { register, unregister } from '../registry.js';
import type { DetachDriver, DetachHandle } from '../types.js';

export interface SendBeaconDriverOptions {
  /** Endpoint URL — required. e.g., `'https://telemetry.example.com/ingest'`. */
  readonly url: string;
  /** Custom serializer. Defaults to `JSON.stringify(input)` with
   *  `application/json` content type. */
  readonly serialize?: (input: unknown) => Blob | string | FormData;
}

export function createSendBeaconDriver(opts: SendBeaconDriverOptions): DetachDriver {
  if (!opts.url) {
    throw new TypeError('[detach] createSendBeaconDriver requires a `url` option.');
  }

  function serialize(input: unknown): Blob | string | FormData {
    if (opts.serialize) return opts.serialize(input);
    return new Blob([JSON.stringify(input ?? null)], { type: 'application/json' });
  }

  return {
    name: 'send-beacon',
    capabilities: {
      browserSafe: true,
      survivesUnload: true,
    },
    validate(): void {
      if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
        throw new Error(
          '[detach] sendBeaconDriver requires a browser environment with `navigator.sendBeacon`. ' +
            'Use `microtaskBatchDriver` for in-process detach, or `setImmediateDriver` for Node.js.',
        );
      }
    },
    schedule(_child: FlowChart, input: unknown, refId: string): DetachHandle {
      const handle = createHandle(refId);
      register(handle);
      const impl = asImpl(handle);
      impl._markRunning();
      try {
        const payload = serialize(input);
        const accepted = navigator.sendBeacon(opts.url, payload as BodyInit);
        if (accepted) {
          impl._markDone({ accepted: true, url: opts.url });
        } else {
          impl._markFailed(
            new Error('[detach] navigator.sendBeacon refused the payload (likely over the ~64 KB limit).'),
          );
        }
      } catch (err) {
        impl._markFailed(err instanceof Error ? err : new Error(String(err)));
      } finally {
        unregister(impl.id);
      }
      return handle;
    },
  };
}
