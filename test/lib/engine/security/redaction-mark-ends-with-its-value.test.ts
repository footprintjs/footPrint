/**
 * A mark ends when the hidden value is really gone, and not before.
 *
 * A value that came from a hidden key and is written under another name stays hidden under that name
 * (`s.copy = s.secret`): the new name is MARKED for the rest of the run. The law lets a delete end a
 * mark, because a key that is gone holds nothing to hide. That is right only when the delete removes
 * THE value the mark stands for. It was wrong in three ways, and each showed the secret in the commit
 * log and in the redacted state:
 *
 *   1. ANOTHER KEY OF THE SAME NAME. A run has more than one key of a name: every sub-flowchart has
 *      its own state, and every parallel branch its own namespace. The mark was kept by name alone,
 *      so a delete of `copy` inside a sub-flowchart (which never held the secret) ended the mark of
 *      the parent's `copy`, and the parent's next write of it went out in the clear.
 *   2. A DELETE THAT NEVER HAPPENED. The mark ended when the delete was staged. A try that deletes the
 *      key and then fails is thrown away by a retry: the key is still there, and its mark was gone.
 *   3. A VALUE STILL ON ITS WAY. A fan-out over hidden items marks its results key before any branch
 *      runs, and writes the results when the last branch is done. A branch that deleted a key of its
 *      own with that name ended the mark in between, and the results went out in the clear.
 *
 * Now a mark remembers every PLACE a hidden value under its name landed (the state it landed in and
 * the address under it). THE LAW: a delete ends a mark only by taking away its last place; a delete
 * anywhere else changes nothing. A value on its way holds a place of its own until it has landed. And
 * a delete that does not land (a discarded try, a commit that fails) gives back what it took.
 *
 * Found 2026-11-11 through the copy-on-write differentials at a fresh seed (1 and 2), and by asking
 * what else could end a mark early (3). Every program below that names a leak leaked before the fix,
 * through the public API.
 *
 * Test type: security scenario.
 */
import type { CommitValuesMode } from 'foottrace';
import { describe, expect, it } from 'vitest';

import { flowChart, FlowChartExecutor } from '../../../../src/index.js';

type S = Record<string, unknown> & {
  $getValue(key: string): unknown;
  $setValue(key: string, value: unknown): void;
};

const SECRET = 'sk-live-SUPER-SECRET-BYTES';
const POLICY = { keys: ['secret'] };
const ENCODINGS: CommitValuesMode[] = ['full', 'delta'];

/** Everything the run keeps or serves under the policy, as one text: the log, and the redacted views. */
function served(executor: FlowChartExecutor<never, never>): string {
  const plain = executor.getSnapshot();
  const redacted = executor.getSnapshot({ redact: true });
  return JSON.stringify([plain.commitLog, redacted.sharedState, redacted.subflowResults ?? null]);
}

/** `A` writes the secret, `B` writes the same object under the name `copy`. What follows is the test's. */
const start = () =>
  flowChart<S>(
    'A',
    (s) => {
      s.secret = [SECRET];
    },
    'a',
  ).addFunction(
    'B',
    (s) => {
      const scope = s as S;
      scope.$setValue('copy', scope.$getValue('secret')); // the same object, under another name
    },
    'b',
  );

/**
 * Put one more item in FRONT of the list. Not at its end, on purpose: under `commitValues: 'delta'` an
 * item added at the end is stored as the added item alone, and the old items are not written again.
 * In front, both encodings store the whole list, which is where a lost mark shows.
 */
const addToCopy = (s: S) => {
  (s.copy as string[]).unshift('more');
};
const deleteCopy = (s: S) => {
  delete (s as Record<string, unknown>).copy;
};

async function run(chart: unknown, commitValues: CommitValuesMode) {
  const executor = new FlowChartExecutor(chart as never, { commitValues } as never);
  executor.setRedactionPolicy(POLICY);
  await executor.run();
  return executor as FlowChartExecutor<never, never>;
}

describe.each(ENCODINGS)('a mark ends with its value (%s)', (commitValues) => {
  it('control: the copy is hidden, and stays hidden when a later stage adds to it', async () => {
    const executor = await run(start().addFunction('C', addToCopy, 'c').build(), commitValues);
    expect(executor.getSnapshot().sharedState.copy).toEqual(['more', SECRET]);
    expect(served(executor)).not.toContain(SECRET);
    expect(executor.getSnapshot({ redact: true }).sharedState.copy).toBe('REDACTED');
  });

  it('a sub-flowchart that deletes ITS OWN key of that name does not un-hide the parent’s', async () => {
    const inner = flowChart<S>('Inner', deleteCopy, 'inner').build();
    const chart = start()
      .addSubFlowChart('mount', inner, 'Mount', { inputMapper: () => ({}), outputMapper: () => ({}) } as never)
      .addFunction('C', addToCopy, 'c')
      .build();
    const executor = await run(chart, commitValues);

    expect(executor.getSnapshot().sharedState.copy).toEqual(['more', SECRET]); // the parent's value is still there
    expect(served(executor)).not.toContain(SECRET);
    expect(executor.getSnapshot({ redact: true }).sharedState.copy).toBe('REDACTED');
  });

  it('a parallel branch that deletes ITS OWN key of that name does not un-hide the parent’s', async () => {
    const chart = start()
      .addSelectorFunction('Pick', () => ['left', 'right'], 'pick')
      .addFunctionBranch('left', 'Left', deleteCopy)
      .addFunctionBranch('right', 'Right', (s) => {
        s.other = 1;
      })
      .end()
      .addFunction('C', addToCopy, 'c')
      .build();
    const executor = await run(chart, commitValues);

    expect(executor.getSnapshot().sharedState.copy).toEqual(['more', SECRET]);
    expect(served(executor)).not.toContain(SECRET);
  });

  it('a delete in a try that fails and is retried does not un-hide the key it never removed', async () => {
    let tries = 0;
    const chart = start()
      .addFunction(
        'C',
        (s) => {
          tries += 1;
          if (tries === 1) {
            deleteCopy(s as S); // staged, then thrown away with the failed try
            throw new Error('the first try fails');
          }
          addToCopy(s as S);
        },
        'c',
      )
      .retry({ attempts: 2 })
      .build();
    const executor = await run(chart, commitValues);

    expect(tries).toBe(2);
    expect(executor.getSnapshot().sharedState.copy).toEqual(['more', SECRET]);
    expect(served(executor)).not.toContain(SECRET);
  });

  it('a fan-out over hidden items: a branch that deletes ITS OWN key named like the results key does not un-hide the results', async () => {
    // Each branch's `item` is one of the secrets, and each branch's final state is one result.
    const branch = flowChart<S>(
      'Work',
      (s) => {
        delete (s as Record<string, unknown>).outs; // its own key: the results are not written yet
      },
      'work',
    ).build();
    const chart = flowChart<S>(
      'A',
      (s) => {
        s.secret = [SECRET, `${SECRET}-2`];
      },
      'a',
    )
      .addParallelForEach('Fan', 'fan', {
        items: (s: S) => s.secret as string[],
        branch: () => branch,
        into: 'outs',
        maxBranches: 4,
      } as never)
      .build();
    const executor = await run(chart, commitValues);

    const outs = executor.getSnapshot().sharedState.outs as { item: string }[];
    expect(outs.map((out) => out.item)).toEqual([SECRET, `${SECRET}-2`]); // the live results are real
    expect(served(executor)).not.toContain(SECRET);
    expect(executor.getSnapshot({ redact: true }).sharedState.outs).toBe('REDACTED');
  });

  it('a fan-out over hidden items: a branch that hides and deletes a key named like the results key does not un-hide the results', async () => {
    // The items are objects, so a branch can put its item under another name by reference. Under the
    // name of the results key that is a hidden value in THIS branch, and its delete takes it away
    // again. The results are still on their way: the fan-out holds the name until they have landed.
    const branch = flowChart<S>(
      'Work',
      (s) => {
        s.outs = s.item;
        delete (s as Record<string, unknown>).outs;
      },
      'work',
    ).build();
    const chart = flowChart<S>(
      'A',
      (s) => {
        s.secret = [{ token: SECRET }, { token: `${SECRET}-2` }];
      },
      'a',
    )
      .addParallelForEach('Fan', 'fan', {
        items: (s: S) => s.secret as object[],
        branch: () => branch,
        into: 'outs',
        maxBranches: 4,
      } as never)
      .build();
    const executor = await run(chart, commitValues);

    const outs = executor.getSnapshot().sharedState.outs as { item: { token: string } }[];
    expect(outs.map((out) => out.item.token)).toEqual([SECRET, `${SECRET}-2`]); // every branch ran to its end
    expect(served(executor)).not.toContain(SECRET);
    expect(executor.getSnapshot({ redact: true }).sharedState.outs).toBe('REDACTED');
  });

  it('a retried delete gives its mark back even when the last other key of that name was deleted meanwhile', async () => {
    // Two branches, each with a `copy` of its hidden item. Branch 0 stages a delete of its own and waits.
    // Branch 1 really deletes its own: the last OTHER place. Then branch 0's try fails and is thrown
    // away, so its `copy` is still there, and still hidden.
    let afterFirstDelete!: () => void;
    const firstDeleteStaged = new Promise<void>((resolve) => (afterFirstDelete = resolve));
    let afterSecondDelete!: () => void;
    const secondDeleteStaged = new Promise<void>((resolve) => (afterSecondDelete = resolve));
    let tries = 0;
    const branch = flowChart<S>(
      'Copy',
      (s) => {
        s.copy = s.item; // the same list under another name: hidden, in this branch
      },
      'copy',
    )
      .addFunction(
        'Work',
        async (s) => {
          if (s.index !== 0) {
            await firstDeleteStaged;
            deleteCopy(s as S);
            afterSecondDelete();
            return;
          }
          tries += 1;
          if (tries === 1) {
            deleteCopy(s as S);
            afterFirstDelete();
            await secondDeleteStaged;
            throw new Error('the first try fails');
          }
          addToCopy(s as S);
        },
        'work',
      )
      .retry({ attempts: 2 })
      .build();
    const chart = flowChart<S>(
      'A',
      (s) => {
        s.secret = [[SECRET], [`${SECRET}-2`]];
      },
      'a',
    )
      .addParallelForEach('Fan', 'fan', {
        items: (s: S) => s.secret as string[][],
        branch: () => branch,
        into: 'outs',
        maxBranches: 4,
      } as never)
      .build();
    const executor = await run(chart, commitValues);

    expect(tries).toBe(2);
    const outs = executor.getSnapshot().sharedState.outs as { copy?: string[] }[];
    expect(outs[0].copy).toEqual(['more', SECRET]); // branch 0 still has its copy, with the item added
    expect(outs[1].copy).toBeUndefined(); // branch 1 really deleted its own
    expect(served(executor)).not.toContain(SECRET);
  });

  it('the law stays for fields too: the stage that deletes a record a mapper handed on ends its hidden fields', async () => {
    // The policy hides `profile.email`. The mapper hands the sub-flowchart's profile to the parent as
    // `person`: the same hidden field under a new name. The merge-back writes it field by field. Once
    // the parent deletes `person`, a new `person` is shown whole.
    const inner = flowChart<S>(
      'Load',
      (s) => {
        s.profile = { name: 'Ann', email: SECRET };
      },
      'load',
    ).build();
    const chart = flowChart<S>('A', () => undefined, 'a')
      .addSubFlowChart('mount', inner, 'Mount', {
        inputMapper: () => ({}),
        outputMapper: (out: S) => ({ person: out.profile }),
      } as never)
      .addFunction(
        'Forget',
        (s) => {
          delete (s as Record<string, unknown>).person;
        },
        'forget',
      )
      .addFunction(
        'New',
        (s) => {
          s.person = { email: 'public@example.test' };
        },
        'new',
      )
      .build();
    const executor = new FlowChartExecutor(chart as never, { commitValues } as never);
    executor.setRedactionPolicy({ fields: { profile: ['email'] } });
    await executor.run();

    const all = served(executor as FlowChartExecutor<never, never>);
    expect(all).not.toContain(SECRET);
    expect(all).toContain('public@example.test');
  });

  it('the law stays: the stage that really deletes the key ends the mark, and a new value under that name is shown', async () => {
    const chart = start()
      .addFunction(
        'C',
        (s) => {
          deleteCopy(s as S);
        },
        'c',
      )
      .addFunction(
        'D',
        (s) => {
          s.copy = ['public'];
        },
        'd',
      )
      .build();
    const executor = await run(chart, commitValues);

    expect(served(executor)).not.toContain(SECRET);
    expect(executor.getSnapshot({ redact: true }).sharedState.copy).toEqual(['public']);
  });

  it('within one stage, delete then a new value: that commit still hides the key, and the next stage’s value is shown', async () => {
    const chart = start()
      .addFunction(
        'C',
        (s) => {
          deleteCopy(s as S);
          s.copy = ['public'];
        },
        'c',
      )
      .build();
    const sameStage = await run(chart, commitValues);
    expect(served(sameStage)).not.toContain(SECRET);
    // As before this change: a path the stage deleted under the rule is scrubbed in that stage's commit.
    expect(sameStage.getSnapshot({ redact: true }).sharedState.copy).toBe('REDACTED');

    const later = await run(
      start()
        .addFunction(
          'C',
          (s) => {
            deleteCopy(s as S);
            s.copy = ['public'];
          },
          'c',
        )
        .addFunction(
          'D',
          (s) => {
            s.copy = ['public again'];
          },
          'd',
        )
        .build(),
      commitValues,
    );
    expect(later.getSnapshot({ redact: true }).sharedState.copy).toEqual(['public again']);
  });
});
