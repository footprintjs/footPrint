import { expect, it, vi } from 'vitest';

import { attempt, disableDevMode, enableDevMode, isDevMode } from '../../../../src/index.js';

for (const observer of ['onAttempt', 'onEnd'] as const) {
  for (const outcome of ['answer', 'error'] as const) {
    it(`keeps the ${outcome} when ${observer} and its warning sink both throw`, async () => {
      const wasDev = isDevMode();
      enableDevMode();
      const observerError = new Error('PRIVATE-OBSERVER-MARKER');
      const warningError = new Error('warning sink failed');
      const workError = new Error('work failed');
      const answer = { answer: 7 };
      let work = 0;
      let records = 0;
      let summaries = 0;
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
        throw warningError;
      });
      try {
        const result = attempt(
          () => {
            work++;
            if (outcome === 'error') throw workError;
            return answer;
          },
          undefined,
          {
            onAttempt: () => {
              records++;
              if (observer === 'onAttempt') throw observerError;
            },
            onEnd: () => {
              summaries++;
              if (observer === 'onEnd') throw observerError;
            },
          },
        );
        if (outcome === 'answer') await expect(result).resolves.toBe(answer);
        else await expect(result).rejects.toBe(workError);
        expect(work).toBe(1);
        expect(records).toBe(1);
        expect(summaries).toBe(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE-OBSERVER-MARKER');
        expect(warn.mock.calls[0]).toHaveLength(1);
      } finally {
        warn.mockRestore();
        if (!wasDev) disableDevMode();
      }
    });
  }
}

it.each(['onAttempt', 'onEnd'] as const)(
  'stays silent with dev mode off after a throwing %s observer',
  async (observer) => {
    const wasDev = isDevMode();
    disableDevMode();
    const warn = vi.spyOn(console, 'warn');
    try {
      await expect(
        attempt(() => 7, undefined, {
          [observer]: () => {
            throw new Error('observer failed');
          },
        }),
      ).resolves.toBe(7);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      if (wasDev) enableDevMode();
    }
  },
);

it.each(['onAttempt', 'onEnd'] as const)(
  'observes ordinary rejected native Promises from %s and its warning sink without awaiting them',
  async (observer) => {
    const wasDev = isDevMode();
    enableDevMode();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => Promise.reject(new Error('warning failed')));
    try {
      await expect(
        attempt(() => 7, undefined, { [observer]: () => Promise.reject(new Error('observer failed')) }),
      ).resolves.toBe(7);
      await Promise.resolve();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]).toHaveLength(1);
    } finally {
      warn.mockRestore();
      if (!wasDev) disableDevMode();
    }
  },
);

it('ignores non-native thenables without reading their then getter', async () => {
  let probes = 0;
  const ignored = Object.defineProperty({}, 'then', {
    get() {
      probes++;
      throw new Error('must not probe');
    },
  });
  await expect(attempt(() => 7, undefined, { onEnd: () => ignored })).resolves.toBe(7);
  expect(probes).toBe(0);
});

it('observes a fulfilled native observer Promise without changing the result', async () => {
  await expect(attempt(() => 7, undefined, { onEnd: () => Promise.resolve('ignored') })).resolves.toBe(7);
  await Promise.resolve();
});
