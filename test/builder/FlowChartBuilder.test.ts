import {
    FlowChartBuilder,
    DeciderList,
    type BuiltFlow,
    type FlowChartSpec,
    specToStageNode,
} from '../../src/builder/FlowChartBuilder';
import type { StageNode } from '../../src/core/pipeline/TreePipeline';

/* ----------------------------------------------------------------------------
 * Helpers: prune functions/deciders for JSON compare + name collector
 * -------------------------------------------------------------------------- */

function prune(node: StageNode<any, any> | undefined): any {
    if (!node) return undefined;
    const out: any = { name: node.name };
    if (node.id) out.id = node.id;
    if (node.children?.length) out.children = node.children.map(prune);
    if (node.next) out.next = prune(node.next);
    return out;
}

function names(node?: StageNode<any, any>, acc: string[] = []): string[] {
    if (!node) return acc;
    acc.push(node.name);
    if (node.children) for (const c of node.children) names(c, acc);
    if (node.next) names(node.next, acc);
    return acc;
}

/* ----------------------------------------------------------------------------
 * Mock TreePipeline to test execute() sugar without running the engine
 * -------------------------------------------------------------------------- */

const TPctor = jest.fn();
const TPexec = jest.fn(async () => 'EXEC_RESULT');

jest.mock('../../src/core/pipeline/TreePipeline', () => {
    return {
        TreePipeline: class {
            constructor(...args: any[]) { TPctor(...args); }
            async execute() { return await TPexec(); }
        }
    };
});

/* ----------------------------------------------------------------------------
 * Linear / Fork / Decider / Composition
 * -------------------------------------------------------------------------- */

describe('FlowChartBuilder — build shapes', () => {
    test('linear: start → addFunction → addFunction', () => {
        const fb = new FlowChartBuilder()
            .start('A')
            .addFunction('B')
            .addFunction('C');

        const { root } = fb.build();
        expect(prune(root)).toEqual({
            name: 'A',
            next: { name: 'B', next: { name: 'C' } },
        });
    });

    test('fork-only: (stage?) → children (parallel) → return bundle (at runtime)', () => {
        const fb = new FlowChartBuilder()
            .start('gather')
            .addListOfFunction([
                { id:'x', name:'X' },
                { id:'y', name:'Y' },
            ]);

        const { root } = fb.build();
        expect(prune(root)).toEqual({
            name: 'gather',
            children: [{ id:'x', name:'X' }, { id:'y', name:'Y' }],
        });
    });

    test('fork + next: stage → children → next (aggregator as first addFunction after fork)', () => {
        const fb = new FlowChartBuilder()
            .start('seed')
            .addListOfFunction([
                { id:'a', name:'A' },
                { id:'b', name:'B' },
            ])
            .addFunction('aggregate')
            .addFunction('tail');

        const { root } = fb.build();
        expect(prune(root)).toEqual({
            name: 'seed',
            children: [{ id:'a', name:'A' }, { id:'b', name:'B' }],
            next: { name:'aggregate', next: { name:'tail' } },
        });
    });

    test('decider: addDecider().addFunctionBranch().end() creates branches + decider fn', () => {
        const fb = new FlowChartBuilder()
            .start('chooser')
            .addDecider(() => 'B')
            .addFunctionBranch('A', 'A')
            .addFunctionBranch('B', 'B')
            .end();

        const { root } = fb.build();
        expect(prune(root)).toEqual({
            name: 'chooser',
            children: [{ id:'A', name:'A' }, { id:'B', name:'B' }],
        });
        // decider exists
        expect(typeof (root as any).nextNodeDecider).toBe('function');
        // wrapper honors default if set; verify wrapper shape via invocation
        const dec = (root as any).nextNodeDecider as (x?: any) => any;
        return expect(dec({})).resolves.toBe('B');
    });

    test('decider .setDefault routes unknown id to default instead of engine throw', async () => {
        const fb = new FlowChartBuilder()
            .start('dec')
            .addDecider(() => 'UNKNOWN')
            .addFunctionBranch('left', 'LEFT')
            .addFunctionBranch('right','RIGHT')
            .setDefault('left')
            .end();
        const { root } = fb.build();
        const dec = (root as any).nextNodeDecider as (x?: any) => any;
        await expect(dec({})).resolves.toBe('left');
    });

    test('composition (decider branches): addSubtreeBranch mounts subflows', () => {
        const smalltalk = new FlowChartBuilder()
            .start('Smalltalk_Start')
            .addFunction('Smalltalk_Answer')
            .build();

        const rag = new FlowChartBuilder()
            .start('RAG_Start')
            .addFunction('RAG_Answer')
            .build();

        const chatbot = new FlowChartBuilder()
            .start('Entry')
            .addDecider(() => 'qa')
            .addSubtreeBranch('smalltalk', smalltalk, 'Smalltalk')
            .addSubtreeBranch('qa', rag, 'QA')
            .end()
            .addFunction('Tail');

        const { root } = chatbot.build();
        expect(names(root)).toEqual(expect.arrayContaining([
            'Entry','Smalltalk','Smalltalk_Answer','QA','RAG_Answer','Tail'
        ]));
        expect(prune(root)).toEqual({
            name:'Entry',
            children:[
                { id:'smalltalk', name:'Smalltalk', next:{ name:'Smalltalk_Answer' } },
                { id:'qa',        name:'QA',        next:{ name:'RAG_Answer' } }
            ],
            next:{ name:'Tail' }
        });
    });

    test('composition (fork children): addSubtreeChild mounts subflows as parallel children', () => {
        const faq = new FlowChartBuilder().start('FAQ_Start').addFunction('FAQ_Answer').build();
        const help = new FlowChartBuilder().start('Help_Start').addFunction('Help_Answer').build();

        const main = new FlowChartBuilder()
            .start('Prep')
            .addSubtreeChild('faq', faq, 'FAQ')
            .addSubtreeChild('help', help, 'Help')
            .addFunction('Aggregate')
            .addFunction('Tail');

        const { root } = main.build();
        expect(names(root)).toEqual(expect.arrayContaining([
            'Prep','FAQ','FAQ_Answer','Help','Help_Answer','Aggregate','Tail'
        ]));
        expect(prune(root)).toEqual({
            name:'Prep',
            children: [
                { id:'faq',  name:'FAQ',  next:{ name:'FAQ_Answer' } },
                { id:'help', name:'Help', next:{ name:'Help_Answer' } },
            ],
            next: { name:'Aggregate', next:{ name:'Tail' } }
        });
    });
});

/* ----------------------------------------------------------------------------
 * Validations
 * -------------------------------------------------------------------------- */

describe('FlowChartBuilder — validations & errors', () => {
    test('duplicate child ids under parent throws', () => {
        const fb = new FlowChartBuilder().start('parent');
        expect(() =>
            fb.addListOfFunction([
                { id:'x', name:'X' },
                { id:'x', name:'X2' },
            ])
        ).toThrow(/duplicate child id 'x' under 'parent'/i);
    });

    test('decider requires at least one branch', () => {
        const fb = new FlowChartBuilder().start('dec');
        expect(() => fb.addDecider(() => 'x').end()).toThrow(/requires at least one branch/i);
    });

    test('stageMap collision when mounting subtree throws', () => {
        const subA = new FlowChartBuilder().start('shared', (() => {}) as any).build();
        const subB = new FlowChartBuilder().start('shared', ((() => 'other') as any)).build();
        const main = new FlowChartBuilder().start('root');

        expect(() =>
            main.addSubtreeChild('a', subA, 'A').addSubtreeChild('b', subB, 'B')
        ).toThrow(/stageMap collision/i);
    });

    test('stageMap collision within single builder when embedding fn with same name throws', () => {
        const fb = new FlowChartBuilder()
            .start('clash', ((() => 'one') as any))
            // attempt to add a child with same stage name but different fn:
            .addListOfFunction([{ id: 'c', name: 'clash', fn: ((() => 'two') as any) }]);
        // The collision is actually detected at the time of adding; so wrap in new builder:
        const fb2 = new FlowChartBuilder().start('root', ((() => {}) as any));
        fb2._addToMap('dup', ((() => 'a') as any)); // set first
        expect(() => fb2._addToMap('dup', ((() => 'b') as any))).toThrow(/stageMap collision/i);
    });

    test('into() unknown child throws', () => {
        const fb = new FlowChartBuilder().start('A');
        expect(() => fb.into('nope')).toThrow(/child 'nope' not found under 'A'/i);
    });

    test('end() at root throws', () => {
        const fb = new FlowChartBuilder().start('A');
        expect(() => fb.end()).toThrow(/'end\(\)' at root is invalid/i);
    });

    test('calling addFunction before start throws (cursor undefined)', () => {
        const fb = new FlowChartBuilder();
        expect(() => fb.addFunction('B')).toThrow(/cursor undefined; call start\(\) first/i);
    });
});

/* ----------------------------------------------------------------------------
 * JSON spec + BE reconstruction
 * -------------------------------------------------------------------------- */

describe('FlowChartBuilder — toSpec() & specToStageNode()', () => {
    test('toSpec emits pure JSON with hasDecider/branchIds; specToStageNode reconstructs shape', () => {
        const fb = new FlowChartBuilder()
            .start('init')
            .addListOfFunction([
                {
                    id:'conversation', name:'retriever',
                    build: b => b
                        .addDecider(() => 'intent')
                        .addFunctionBranch('intent', 'identifyIntent', undefined, bb => bb
                            .addFunction('buildPrompt')
                            .addFunction('askLlm'))
                        .addFunctionBranch('alt', 'askLlm')
                        .end()
                },
                { id:'kb', name:'buildPrompt', build: b => b.addFunction('askLlm') },
            ]);

        const spec = fb.toSpec();
        // basic JSON sanity (no functions)
        expect(spec).toEqual({
            name:'init',
            children:[
                {
                    id:'conversation', name:'retriever',
                    hasDecider:true, branchIds:['intent','alt'],
                    children:[
                        { id:'intent', name:'identifyIntent', next:{ name:'buildPrompt', next:{ name:'askLlm' } } },
                        { id:'alt',    name:'askLlm' }
                    ]
                },
                { id:'kb', name:'buildPrompt', next:{ name:'askLlm' } }
            ]
        });

        const stageNode = specToStageNode(spec);
        expect(prune(stageNode)).toEqual({
            name:'init',
            children:[
                {
                    id:'conversation', name:'retriever',
                    children:[
                        { id:'intent', name:'identifyIntent', next:{ name:'buildPrompt', next:{ name:'askLlm' } } },
                        { id:'alt',    name:'askLlm' }
                    ]
                },
                { id:'kb', name:'buildPrompt', next:{ name:'askLlm' } }
            ]
        });
    });
});

/* ----------------------------------------------------------------------------
 * toMermaid
 * -------------------------------------------------------------------------- */

describe('FlowChartBuilder — toMermaid() contains nodes', () => {
    test('toMermaid lists node names', () => {
        const fb = new FlowChartBuilder()
            .start('A')
            .addFunction('B')
            .addListOfFunction([{ id:'x', name:'X' }, { id:'y', name:'Y' }])
            .addFunction('C');

        const mermaid = fb.toMermaid();
        expect(mermaid).toMatch(/A/);
        expect(mermaid).toMatch(/B/);
        expect(mermaid).toMatch(/X/);
        expect(mermaid).toMatch(/Y/);
        expect(mermaid).toMatch(/C/);
    });
});

/* ----------------------------------------------------------------------------
 * execute() sugar (TreePipeline mocked)
 * -------------------------------------------------------------------------- */

describe('FlowChartBuilder — execute() sugar builds & calls TreePipeline', () => {
    beforeEach(() => { TPctor.mockClear(); TPexec.mockClear(); });

    test('execute passes {root, stageMap} and options to TreePipeline ctor', async () => {
        const fb = new FlowChartBuilder()
            .start('prep')
            .addFunction('tail');

        // fake scopeFactory to satisfy types & constructor
        const scopeFactory = ((_ctx: any, _stage: string, _ro?: unknown) => ({})) as any;

        const result = await fb.execute(scopeFactory, {
            defaults: { d:1 },
            initial:  { i:2 },
            readOnly: { r:3 },
            throttlingErrorChecker: (e) => (e as any)?.code === 'THROTTLE',
        });

        expect(TPctor).toHaveBeenCalledTimes(1);
        const args = TPctor.mock.calls[0];
        // [root, stageMap, scopeFactory, defaults, initial, readOnly, checker]
        expect(args[0]).toMatchObject({ name: 'prep', next: { name: 'tail' } });
        expect(args[2]).toBe(scopeFactory);
        expect(args[3]).toEqual({ d:1 });
        expect(args[4]).toEqual({ i:2 });
        expect(args[5]).toEqual({ r:3 });
        expect(typeof args[6]).toBe('function');

        expect(TPexec).toHaveBeenCalledTimes(1);
        expect(result).toBe('EXEC_RESULT');
    });
});
