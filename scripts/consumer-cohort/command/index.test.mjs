import { expect, it } from 'vitest';
import { guardedCommand } from './index.mjs';
it('guards successful and nonzero commands in order and returns their exact outcomes', () => {
  for (const result of [
    { ok: true, status: 0 },
    { ok: false, status: 71 },
    { ok: false, status: null },
  ]) {
    const events = [];
    expect(
      guardedCommand(
        'fixed',
        'root',
        () => events.push('guard'),
        () => {
          events.push('run');
          return result;
        },
      ),
    ).toBe(result);
    expect(events).toEqual(['guard', 'run', 'guard']);
  }
});
it('does not run a command or after guard when its before guard refuses', () => {
  let calls = 0;
  const original = Error('before');
  expect(() =>
    guardedCommand(
      'fixed',
      'root',
      () => {
        calls++;
        throw original;
      },
      () => {
        throw Error('must not run');
      },
    ),
  ).toThrow(original);
  expect(calls).toBe(1);
});
for (const thrown of [Error('primary'), undefined, null, 0])
  it('preserves thrown command value ' + String(thrown) + ' and still guards after it', () => {
    let calls = 0;
    let caught = false;
    let actual;
    try {
      guardedCommand(
        'fixed',
        'root',
        () => {
          calls++;
        },
        () => {
          throw thrown;
        },
      );
    } catch (e) {
      caught = true;
      actual = e;
    }
    expect(caught).toBe(true);
    expect(actual).toBe(thrown);
    expect(calls).toBe(2);
  });
it('preserves command failure as primary and after failure as secondary', () => {
  const command = Error('command'),
    guard = Error('guard');
  let calls = 0;
  let caught;
  try {
    guardedCommand(
      'fixed',
      'root',
      () => {
        if (++calls === 2) throw guard;
      },
      () => {
        throw command;
      },
    );
  } catch (e) {
    caught = e;
  }
  expect(caught.errors).toEqual([command, guard]);
  expect(caught.cause).toBe(command);
});
it('retains a nonzero command outcome when its after guard also fails', () => {
  const result = { ok: false, status: 71 },
    guard = Error('guard');
  let calls = 0;
  let caught;
  try {
    guardedCommand(
      'fixed',
      'root',
      () => {
        if (++calls === 2) throw guard;
      },
      () => result,
    );
  } catch (e) {
    caught = e;
  }
  expect(caught.errors[0].result).toBe(result);
  expect(caught.errors[1]).toBe(guard);
});
for (const result of [
  undefined,
  { ok: true },
  { ok: true, status: 0, skipped: true },
  { ok: true, status: 0, signal: 'SIGKILL' },
  { ok: true, status: 0, errorCode: 'ETIMEDOUT' },
])
  it('refuses missing or skipped outcome ' + JSON.stringify(result), () => {
    let calls = 0;
    expect(() =>
      guardedCommand(
        'fixed',
        'root',
        () => {
          calls++;
        },
        () => result,
      ),
    ).toThrow('paired command failed');
    expect(calls).toBe(2);
  });
for (const result of [
  { ok: true, status: 71 },
  { ok: true, status: null },
  { ok: false, status: 0 },
])
  it('refuses contradictory success and actual status ' + JSON.stringify(result), () => {
    let guards = 0;
    expect(() =>
      guardedCommand(
        'fixed',
        'root',
        () => {
          guards++;
        },
        () => result,
      ),
    ).toThrow('paired command failed');
    expect(guards).toBe(2);
  });
