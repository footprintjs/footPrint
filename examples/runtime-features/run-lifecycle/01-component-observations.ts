import {
  createRunLifecycle,
  flowChart,
  FlowChartExecutor,
  select,
  type RunLifecycle,
  type RunSlot,
  type TypedScope,
} from 'footprintjs';

type Fixture = { tool: string; costUnits: number };
type Totals = { tools: string[]; costUnits: number };
type Report = Totals & {
  entry: { readonly runId: string; readonly ordinal: number };
  end: 'completed' | 'paused' | 'failed';
};

function isFixture(value: unknown): value is Fixture {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.tool === 'string' &&
    typeof row.costUnits === 'number' &&
    Number.isSafeInteger(row.costUnits) &&
    row.costUnits >= 0
  );
}

async function example() {
  const reports: Report[] = [];
  let entered = 0;
  let releaseBoth!: () => void;
  const bothEntered = new Promise<void>((resolve) => {
    releaseBoth = resolve;
  });
  let totalsSlot: RunSlot<Totals>;

  const worker = flowChart<string, TypedScope<Record<string, unknown>>>(
    'Fixture tool',
    async (scope) => {
      const fixture = scope.$getArgs<Fixture>();
      entered += 1;
      if (entered === 2) releaseBoth();
      await bothEntered; // Both mounted bodies have entered.

      // SIMULATED tool event and cost units. No tool/provider call is made.
      scope.$emit('fixture.tool', fixture);

      // Read now, inside the body: no observer drain or terminal flush.
      const saved = workerOwner.forScope(scope).read(totalsSlot);
      if (
        !saved.present ||
        saved.value.tools.length !== 1 ||
        saved.value.tools[0] !== fixture.tool ||
        saved.value.costUnits !== fixture.costUnits
      ) {
        throw new Error("Expected only this component's inline fixture event");
      }
      return fixture.tool;
    },
    'fixture-tool',
  ).build();

  const workerOwner: RunLifecycle = createRunLifecycle(worker, {
    runnerId: 'fixture-worker',
    componentSetup(component) {
      const totals = component.local(totalsSlot, () => ({
        tools: [] as string[],
        costUnits: 0,
      }));
      component.onFinalize(async (end) => {
        await Promise.resolve(); // Joined control, not an observer notification.
        reports.push({
          entry: component.entry,
          tools: [...totals.tools],
          costUnits: totals.costUnits,
          end: end.kind,
        });
      });
      return {
        recorder: {
          id: 'fixture-only', // Same ID; each mount has its own component bank.
          onEmit(event) {
            if (event.name !== 'fixture.tool' || !isFixture(event.payload)) return;
            totals.tools.push(event.payload.tool);
            totals.costUnits += event.payload.costUnits;
          },
        },
      };
    },
  });
  totalsSlot = workerOwner.slot<Totals>('component'); // Declare BEFORE entry.

  const parent = flowChart('Begin', () => undefined, 'begin')
    .addSelectorFunction(
      'Both fixtures',
      (scope) =>
        select(scope, [
          { when: () => true, then: 'alpha', label: 'Alpha fixture' },
          { when: () => true, then: 'beta', label: 'Beta fixture' },
        ]),
      'both',
    )
    .addSubFlowChartBranch('alpha', worker, 'Alpha fixture', {
      inputMapper: () => ({ tool: 'alpha.lookup', costUnits: 2 }),
    })
    .addSubFlowChartBranch('beta', worker, 'Beta fixture', {
      inputMapper: () => ({ tool: 'beta.lookup', costUnits: 7 }),
    })
    .end()
    .build();

  try {
    await new FlowChartExecutor(parent).run({ timeoutMs: 5_000 });
  } finally {
    releaseBoth(); // Release this demonstration's barrier on a failed run too.
  }

  const actual = reports
    .map(({ tools, costUnits, end }) => ({ tools, costUnits, end }))
    .sort((a, b) => a.tools[0]!.localeCompare(b.tools[0]!));
  const expected = [
    { tools: ['alpha.lookup'], costUnits: 2, end: 'completed' },
    { tools: ['beta.lookup'], costUnits: 7, end: 'completed' },
  ];
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    new Set(reports.map((report) => report.entry.runId)).size !== 1 ||
    new Set(reports.map((report) => report.entry.ordinal)).size !== 2
  ) {
    throw new Error('Expected two isolated, joined fixture reports');
  }
  console.log(actual);
}

void example();
