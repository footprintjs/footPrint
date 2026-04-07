/**
 * StageRunner — Executes individual stage functions.
 *
 * Responsibilities:
 * - Create scope via ScopeFactory for each stage
 * - Apply scope protection (createProtectedScope) to intercept direct assignments
 * - Handle streaming stages (onStart, onToken, onEnd lifecycle)
 * - Sync+async safety: only await real Promises (instanceof check)
 */
import type { StageContext } from '../../memory/StageContext.js';
import type { StageNode } from '../graph/StageNode.js';
import type { HandlerDeps, StageFunction } from '../types.js';
export declare class StageRunner<TOut = any, TScope = any> {
    private readonly deps;
    constructor(deps: HandlerDeps<TOut, TScope>);
    run(node: StageNode<TOut, TScope>, stageFunc: StageFunction<TOut, TScope>, context: StageContext, breakFn: () => void): Promise<TOut>;
}
