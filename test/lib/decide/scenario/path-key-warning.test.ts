/**
 * Scenario test: a rule key that looks like a path and names nothing is reported in dev mode.
 *
 * WHY. A fork's children write under `runs/<child id>/`, so a decider after the fork that writes
 * `{ 'runs.look-tag.tagExists': { eq: true } }` reads a key that is not there: rule keys are top-level state
 * names, a path is not followed, the rule can never match and the decision falls to the default, silently. In a
 * chart that decides whether to publish, that is the worst kind of fault. Dev mode now says so, once per key per
 * run, and changes nothing else: not what is decided, not the evidence, not the story, not the record.
 *
 * Every test runs a real chart. Groups: the warning in `decide()` and in `select()`, the production gate, the
 * boundary (what must NOT be reported, each beside a control rule that is), the once-per-run law, and the
 * property that everything a run tells is the same with and without the warning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DecisionEvidence, SelectionEvidence } from '../../../../src/index';
import { decide, disableDevMode, enableDevMode, flowChart, FlowChartExecutor, select } from '../../../../src/index';

type Rules = Parameters<typeof decide>[1];

const PATH_KEY = 'runs.look-tag.tagExists';
const pathRules: Rules = [{ when: { [PATH_KEY]: { eq: true } }, then: 'released', label: 'tag exists' }];

/** A fork whose child writes `tagExists`, then a decider: the shape of the fault. */
function forkThenDecide(rules: Rules, seen: { evidence?: DecisionEvidence } = {}) {
  return flowChart(
    'Request',
    (s) => {
      s.version = '1.0.0';
    },
    'request',
  )
    .addListOfFunction([
      {
        id: 'look-tag',
        name: 'Look for the tag',
        fn: (s) => {
          s.tagExists = true;
        },
      },
      {
        id: 'look-npm',
        name: 'Ask npm',
        fn: (s) => {
          s.npmHasVersion = false;
        },
      },
    ])
    .addDeciderFunction(
      'Decide',
      (s) => {
        const result = decide(s, rules, 'held');
        seen.evidence = result.evidence;
        return result;
      },
      'decide',
    )
    .addFunctionBranch('released', 'Released', (s) => {
      s.out = 'released';
    })
    .addFunctionBranch('held', 'Held', (s) => {
      s.out = 'held';
    })
    .setDefault('held')
    .end()
    .build();
}

/** The same fault through `select()`. */
function forkThenSelect(rules: Rules, seen: { evidence?: SelectionEvidence } = {}) {
  return flowChart(
    'Request',
    (s) => {
      s.version = '1.0.0';
    },
    'request',
  )
    .addListOfFunction([
      {
        id: 'look-tag',
        name: 'Look for the tag',
        fn: (s) => {
          s.tagExists = true;
        },
      },
    ])
    .addSelectorFunction(
      'Pick',
      (s) => {
        const result = select(s, rules);
        seen.evidence = result.evidence;
        return result;
      },
      'pick',
    )
    .addFunctionBranch('released', 'Released', (s) => {
      s.out = 'released';
    })
    .end()
    .build();
}

/** A decision in a loop: it runs `times` times, and every pass reads the same dotted key. */
function decisionInALoop(times: number) {
  return flowChart(
    'Start',
    (s) => {
      s.passes = 0;
    },
    'start',
  )
    .addFunction(
      'Count',
      (s) => {
        s.passes = (s.passes as number) + 1;
      },
      'count',
    )
    .addDeciderFunction(
      'Again',
      (s) =>
        decide(
          s,
          [
            { when: { passes: { gte: times } }, then: 'finish', label: 'enough' },
            { when: { 'runs.look-tag.tagExists': { eq: true } }, then: 'finish', label: 'by a path' },
          ],
          'again',
        ),
      'check',
    )
    .addFunctionBranch('again', 'Again', (s) => {
      s.looped = true;
    })
    .loopTo('count')
    .addFunctionBranch('finish', 'Finish', (s) => {
      s.done = true;
    })
    .setDefault('finish')
    .end()
    .build();
}

const warnings = (spy: ReturnType<typeof vi.spyOn>): string[] => spy.mock.calls.map((call) => String(call[0]));
const pathWarnings = (spy: ReturnType<typeof vi.spyOn>): string[] =>
  warnings(spy).filter((text) => text.includes('looks like a path'));

describe('a rule key that looks like a path and names nothing', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    disableDevMode();
    warnSpy.mockRestore();
  });

  describe('unit: decide() in dev mode', () => {
    it('warns once, naming the key, what a rule key is, and what to do instead', async () => {
      enableDevMode();
      await new FlowChartExecutor(forkThenDecide(pathRules)).run();

      const found = pathWarnings(warnSpy);
      expect(found).toHaveLength(1);
      expect(found[0]).toBe(
        '[footprint] decide()/select() filter: the key "runs.look-tag.tagExists" (rule 0, \'tag exists\') looks like ' +
          'a path, but rule keys are top-level state names and a path is not followed, and the state holds no key ' +
          'of that name, so this condition can never match. Lift the value to a top-level key in a stage before the ' +
          'decision (a small stage after the fork: scope.name = ...), or use a function rule that reads the path ' +
          "(when: (s) => s.$read('runs.look-tag.tagExists') === true).",
      );
    });

    it('names the rule by its index when it has no label', async () => {
      enableDevMode();
      await new FlowChartExecutor(forkThenDecide([{ when: { [PATH_KEY]: { eq: true } }, then: 'released' }])).run();

      expect(pathWarnings(warnSpy)[0]).toContain('(rule 0)');
    });

    it('warns for each distinct dotted key that names nothing', async () => {
      enableDevMode();
      await new FlowChartExecutor(
        forkThenDecide([
          { when: { 'runs.look-tag.tagExists': { eq: true } }, then: 'released' },
          { when: { 'runs.look-npm.npmHasVersion': { eq: true } }, then: 'released' },
        ]),
      ).run();

      const found = pathWarnings(warnSpy);
      expect(found).toHaveLength(2);
      expect(found[0]).toContain('"runs.look-tag.tagExists"');
      expect(found[1]).toContain('"runs.look-npm.npmHasVersion"');
    });
  });

  describe('unit: select() in dev mode', () => {
    it('warns the same way', async () => {
      enableDevMode();
      await new FlowChartExecutor(forkThenSelect(pathRules)).run();

      const found = pathWarnings(warnSpy);
      expect(found).toHaveLength(1);
      expect(found[0]).toContain('"runs.look-tag.tagExists"');
      expect(found[0]).toContain('a path is not followed');
    });
  });

  describe('security: nothing in production', () => {
    it('stays silent when dev mode is off, in decide() and in select(), and speaks when it is on', async () => {
      disableDevMode();
      await new FlowChartExecutor(forkThenDecide(pathRules)).run();
      await new FlowChartExecutor(forkThenSelect(pathRules)).run();
      expect(warnSpy).not.toHaveBeenCalled();

      // The control: the very same charts, dev mode on, do warn. Without it "silent" proves nothing.
      enableDevMode();
      await new FlowChartExecutor(forkThenDecide(pathRules)).run();
      await new FlowChartExecutor(forkThenSelect(pathRules)).run();
      expect(pathWarnings(warnSpy)).toHaveLength(2);
    });
  });

  describe('boundary: what is not reported', () => {
    /**
     * Each test below puts a CONTROL rule first: a dotted key that names nothing. It is evaluated (first-match,
     * it never matches) and must be the ONLY key reported, so "not reported" is shown beside a warning that
     * does fire, not by a silence that would also be the silence of no warning at all.
     */
    const control: Rules[number] = { when: { 'control.missing': { eq: true } }, then: 'released', label: 'control' };
    const reportedKeys = () => pathWarnings(warnSpy).map((text) => /the key "([^"]*)"/.exec(text)?.[1]);

    it('does not warn for a dotted key that IS a top-level state key', async () => {
      enableDevMode();
      const chart = flowChart(
        'Start',
        (s) => {
          s.$setValue('a.b', true);
        },
        'start',
      )
        .addDeciderFunction(
          'Decide',
          (s) => decide(s, [control, { when: { 'a.b': { eq: true } }, then: 'yes', label: 'literal key' }], 'no'),
          'decide',
        )
        .addFunctionBranch('yes', 'Yes', (s) => {
          s.out = 'yes';
        })
        .addFunctionBranch('released', 'Released', (s) => {
          s.out = 'released';
        })
        .addFunctionBranch('no', 'No', (s) => {
          s.out = 'no';
        })
        .setDefault('no')
        .end()
        .build();
      const executor = new FlowChartExecutor(chart);
      await executor.run();

      expect(executor.getSnapshot().sharedState.out).toBe('yes'); // the literal dotted key was read and matched
      expect(reportedKeys()).toEqual(['control.missing']);
    });

    it('does not warn for a plain key that names nothing: a missing value is an ordinary state', async () => {
      enableDevMode();
      await new FlowChartExecutor(
        forkThenDecide([control, { when: { neverWritten: { eq: true } }, then: 'released' }]),
      ).run();

      expect(reportedKeys()).toEqual(['control.missing']);
    });

    it('does not warn for a function rule that reads the path', async () => {
      enableDevMode();
      const executor = new FlowChartExecutor(
        forkThenDecide([
          control,
          { when: (s) => (s as any).$read(PATH_KEY) === true, then: 'released', label: 'tag exists' },
        ]),
      );
      await executor.run();

      expect(executor.getSnapshot().sharedState.out).toBe('released'); // the function rule found the value
      expect(reportedKeys()).toEqual(['control.missing']);
    });

    it('does not warn for a dotted key the stage lifted to a top-level name', async () => {
      enableDevMode();
      const chart = flowChart('Request', () => {}, 'request')
        .addListOfFunction([
          {
            id: 'look-tag',
            name: 'Look for the tag',
            fn: (s) => {
              s.tagExists = true;
            },
          },
        ])
        .addFunction(
          'Lift',
          (s) => {
            s.tagExists = (s as any).$read('runs.look-tag.tagExists');
          },
          'lift',
        )
        .addDeciderFunction(
          'Decide',
          (s) =>
            decide(s, [control, { when: { tagExists: { eq: true } }, then: 'tagged', label: 'tag exists' }], 'held'),
          'decide',
        )
        .addFunctionBranch('tagged', 'Tagged', (s) => {
          s.out = 'tagged';
        })
        .addFunctionBranch('released', 'Released', (s) => {
          s.out = 'released';
        })
        .addFunctionBranch('held', 'Held', (s) => {
          s.out = 'held';
        })
        .setDefault('held')
        .end()
        .build();
      const executor = new FlowChartExecutor(chart);
      await executor.run();

      expect(executor.getSnapshot().sharedState.out).toBe('tagged'); // the lifted key matched
      expect(reportedKeys()).toEqual(['control.missing']);
    });
  });

  describe('scenario: once per key per run', () => {
    it('a decision run five times in a loop warns once, not five times', async () => {
      enableDevMode();
      const executor = new FlowChartExecutor(decisionInALoop(5));
      await executor.run();

      expect(executor.getSnapshot().sharedState.passes).toBe(5);
      expect(pathWarnings(warnSpy)).toHaveLength(1);
    });

    it('a second run of the same chart warns again: the memory is the run, not the process', async () => {
      enableDevMode();
      const executor = new FlowChartExecutor(forkThenDecide(pathRules));
      await executor.run();
      await executor.run();

      expect(pathWarnings(warnSpy)).toHaveLength(2);
    });
  });

  describe('property: what a run tells is the same with and without the warning', () => {
    /** Everything a run decides, records and tells, as text, minus what differs between any two runs: the run id and the clock. */
    async function tellings(devMode: boolean) {
      if (devMode) enableDevMode();
      else disableDevMode();
      const seen: { evidence?: DecisionEvidence } = {};
      const executor = new FlowChartExecutor(forkThenDecide(pathRules, seen));
      executor.enableNarrative();
      await executor.run();
      const snapshot = executor.getSnapshot();
      const runId = (snapshot.commitLog[0] as { runId?: string } | undefined)?.runId;
      const text = (value: unknown) =>
        JSON.stringify(value)
          .split(runId ?? '\u0000')
          .join('<run>')
          .replace(/"timestamp":\d+/g, '"timestamp":0');
      return {
        branch: snapshot.sharedState.out,
        evidence: JSON.stringify(seen.evidence),
        narrative: executor.getNarrativeEntries().map((entry) => entry.text),
        state: JSON.stringify(snapshot.sharedState),
        commitLog: text(snapshot.commitLog),
        tree: text(snapshot.executionTree),
      };
    }

    it('the decision, its evidence, the story, the state and the commit log do not change', async () => {
      const quiet = await tellings(false);
      expect(warnSpy).not.toHaveBeenCalled();
      const loud = await tellings(true);

      expect(pathWarnings(warnSpy)).toHaveLength(1); // the loud run did warn
      expect(loud.branch).toBe('held'); // the rule still never matches: only the warning is new
      expect(loud).toEqual(quiet);
    });
  });
});
