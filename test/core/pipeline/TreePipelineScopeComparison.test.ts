/**
 * Parametric TreePipeline test: run once with legacy BaseState class,
 * and once with a branded Zod schema (consumer-style).
 *
 * Option A (resolver path): mirror how consumers pass a branded schema.
 * We convert that schema to a ScopeFactory via toScopeFactory, after
 * registering the Zod resolver once (side-effect import below).
 */

// ⬅️ If your lib auto-registers the Zod resolver on import, delete this line.
// ⬇️ If not, this side-effect import calls registerScopeResolver(ZodScopeResolver) once.
import '../../../src/scope/state/installResolvers';

import { z } from 'zod';

import { BaseState } from '../../../src';
import { StageContext } from '../../../src/core/context/StageContext';

import { TreePipeline, StageNode } from '../../../src/core/pipeline';
import type { PipelineStageFunction } from '../../../src/core/pipeline';


import  { ScopeFactory } from '../../../src/core/context/types';

// Resolver helper to turn a branded Zod schema into a ScopeFactory
import { defineScopeSchema } from '../../../src/scope/state/zod';
import { toScopeFactory } from '../../../src/scope/core/resolve';

enum PipelineStages {
    INIT = 'init',
    IDENTIFY_CATEGORY = 'identifyCategory',
    IDENTIFY_INTENT = 'identifyIntent',
    INTENT_POST_PROCESS = 'intentPostProcess',
    TOOL_IDENTIFIER = 'toolIdentifier',
    INVOKE_TOOL = 'invokeTool',
    RETRIEVER = 'retriever',
    BUILD_PROMPT = 'buildPrompt',
    ASK_LLM = 'askLlm',
    DETECT_BEDROCK_GUARDRAILS = 'bedrockGuardrails',
}

// Legacy scope
class PipelineScope extends BaseState {}

// ─── Pipelines (unchanged) ──────────────────────────────────────────────────
const childrenAndNextPipeline: StageNode = {
    name: PipelineStages.INIT,
    children: [
        { id: 'conversation', name: PipelineStages.RETRIEVER },
        { id: 'externalSource', name: PipelineStages.RETRIEVER },
    ],
    next: { name: PipelineStages.BUILD_PROMPT, next: { name: PipelineStages.ASK_LLM } },
};

const pipelineStructure: StageNode = {
    name: PipelineStages.INIT,
    children: [
        {
            id: 'conversation',
            name: PipelineStages.RETRIEVER,
            children: [
                {
                    id: 'intentNode',
                    name: PipelineStages.IDENTIFY_INTENT,
                    next: {
                        name: PipelineStages.INTENT_POST_PROCESS,
                        next: {
                            name: PipelineStages.TOOL_IDENTIFIER,
                            next: {
                                name: PipelineStages.INVOKE_TOOL,
                                next: {
                                    name: PipelineStages.BUILD_PROMPT,
                                    next: { name: PipelineStages.ASK_LLM },
                                },
                            },
                        },
                    },
                },
                { id: 'alternativeNode', name: PipelineStages.ASK_LLM },
            ],
            nextNodeDecider: (input) => (input.useAlternativeNode ? 'alternativeNode' : 'intentNode'),
        },
        {
            id: 'externalSource',
            name: PipelineStages.RETRIEVER,
            next: { name: PipelineStages.BUILD_PROMPT, next: { name: PipelineStages.ASK_LLM } },
        },
        { id: 'llmKnowledge', name: PipelineStages.BUILD_PROMPT, next: { name: PipelineStages.ASK_LLM } },
        { id: 'relatedQuestion', name: PipelineStages.BUILD_PROMPT, next: { name: PipelineStages.ASK_LLM } },
    ],
};

// ─── Mocks (fresh per test) ─────────────────────────────────────────────────
function createStageMap(): Map<string, PipelineStageFunction<any, any>> {
    return new Map(
        Object.values(PipelineStages).map((stage) => [stage, jest.fn((input) => input)]),
    );
}

// ─── Consumer-style schema (branded by builder) ──────────────────────────────
const AppScopeSchema = defineScopeSchema({
    inputs: z.object({
        conversationHistory: z.array(z.string()).optional(),
        userAlias: z.string().optional(),
    }).default({}),
    monitor: z.object({
        isThrottled: z.boolean().optional(),
    }).default({}),
});

// Build scope factories for each variant (TreePipeline expects a ScopeFactory)
const legacyFactory: ScopeFactory<BaseState> = (ctx: StageContext, stage: string, ro?: unknown) =>
    new PipelineScope(ctx as any, stage, ro);

// Convert the branded Zod schema into a ScopeFactory using the resolver
const zodFactory = toScopeFactory<any>(AppScopeSchema, { zod: { strict: 'warn' } });

// Two ways a consumer would provide scope input (now *factories*)
const variants: Array<{ label: 'legacy' | 'zod'; scopeFactory: ScopeFactory<any> }> = [
    { label: 'legacy', scopeFactory: legacyFactory },
    { label: 'zod', scopeFactory: zodFactory },
];

// NOTE: with object tables you can use the "$label" placeholder to render row names
describe.each(variants)('TreePipeline – $label scope', ({ scopeFactory }) => {
    let stageMap: Map<string, PipelineStageFunction<any, any>>;
    let pipeline: TreePipeline<any, any>;
    let pipelineNextAndChildren: TreePipeline<any, any>;

    beforeEach(() => {
        jest.clearAllMocks();
        stageMap = createStageMap();

        // Make RETRIEVER return a result object used by the decider
        stageMap.set(
            PipelineStages.RETRIEVER,
            jest.fn(() => ({ useAlternativeNode: false })),
        );

        pipeline = new TreePipeline<any, any>(pipelineStructure, stageMap, scopeFactory, {});
        pipelineNextAndChildren = new TreePipeline<any, any>(
            childrenAndNextPipeline, stageMap, scopeFactory, {},
        );
    });

    it('executes the pipeline with the initial input', async () => {
        const result = await pipeline.execute();
        expect(result).toBeDefined();
        expect(stageMap.get(PipelineStages.INIT)).toHaveBeenCalled();
    });

    it('handles linear progression', async () => {
        await pipeline.execute();
        expect(stageMap.get(PipelineStages.RETRIEVER)).toHaveBeenCalled();
        expect(stageMap.get(PipelineStages.IDENTIFY_INTENT)).toHaveBeenCalled();
        expect(stageMap.get(PipelineStages.INTENT_POST_PROCESS)).toHaveBeenCalled();
    });

    it('handles branching and parallel execution', async () => {
        await pipeline.execute();
        expect(stageMap.get(PipelineStages.RETRIEVER)).toHaveBeenCalledTimes(2);
        expect(stageMap.get(PipelineStages.BUILD_PROMPT)).toHaveBeenCalledTimes(4);
    });

    it('stops execution when break function is invoked', async () => {
        stageMap.set(
            PipelineStages.IDENTIFY_INTENT,
            jest.fn((_scope, breakFn) => breakFn()),
        );
        await pipeline.execute();
        expect(stageMap.get(PipelineStages.INTENT_POST_PROCESS)).not.toHaveBeenCalled();
    });

    it('returns context tree', () => {
        const contextTree = pipeline.getContextTree();
        expect(contextTree).toHaveProperty('globalContext');
        expect(contextTree).toHaveProperty('stageContexts');
    });

    it('handles dynamic decider function', async () => {
        await pipeline.execute();
        expect(stageMap.get(PipelineStages.IDENTIFY_INTENT)).toHaveBeenCalled();
        expect(
            stageMap.get(PipelineStages.ASK_LLM),
        ).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ handler: 'alternativeClaude' }));
    });
});

// Scope-agnostic throttling checker (single run; legacy scope is fine)
describe('TreePipeline – throttlingErrorChecker', () => {
    let updateObjectSpy: jest.SpyInstance;
    let stageMap: Map<string, PipelineStageFunction<any, any>>;

    beforeEach(() => {
        jest.clearAllMocks();
        stageMap = createStageMap();
        updateObjectSpy = jest.spyOn(StageContext.prototype as any, 'updateObject');
    });

    afterEach(() => {
        updateObjectSpy.mockRestore();
    });

    function buildPipeline(
        childStages: Record<string, () => unknown | Promise<unknown>>,
        checker?: (e: unknown) => boolean,
    ) {
        Object.entries(childStages).forEach(([name, fn]) =>
            stageMap.set(name as any, jest.fn(fn)),
        );
        const root: StageNode = {
            name: PipelineStages.INIT,
            children: Object.keys(childStages).map((id) => ({ id, name: id as any })),
        };
        const legacyFactory: ScopeFactory<BaseState> =
            (ctx, stage, ro?: unknown) => new PipelineScope(ctx as any, stage, ro);
        return new TreePipeline<any, BaseState>(
            root, stageMap, legacyFactory, {}, undefined, undefined, checker,
        );
    }

    it('flags a child context when checker returns true', async () => {
        const pipe = buildPipeline(
            { THROTTLED_STAGE: () => { throw new Error('RATE_LIMIT'); } },
            (e) => (e as Error).message === 'RATE_LIMIT',
        );
        await pipe.execute();
        expect(updateObjectSpy).toHaveBeenCalledTimes(1);
        expect(updateObjectSpy).toHaveBeenCalledWith(['monitor'], 'isThrottled', true);
    });

    it('does NOT flag when checker returns false', async () => {
        const pipe = buildPipeline(
            { ERR_STAGE: () => { throw new Error('SOME_OTHER_ERROR'); } },
            () => false,
        );
        await pipe.execute();
        expect(updateObjectSpy).not.toHaveBeenCalled();
    });

    it('does NOT flag when checker is undefined', async () => {
        const pipe = buildPipeline({ ERR_STAGE: () => { throw new Error('WHATEVER'); } });
        await pipe.execute();
        expect(updateObjectSpy).not.toHaveBeenCalled();
    });

    it('flags only throttled children in a mixed fork', async () => {
        const pipe = buildPipeline(
            {
                OK_STAGE: () => 'ok',
                BAD_STAGE: () => { throw new Error('RATE_LIMIT'); },
                OTHER_BAD: () => { throw new Error('AUTH_FAIL'); },
            },
            (e) => (e as Error).message === 'RATE_LIMIT',
        );
        await pipe.execute();
        expect(updateObjectSpy).toHaveBeenCalledTimes(1); // only RATE_LIMIT path flagged
    });
});
