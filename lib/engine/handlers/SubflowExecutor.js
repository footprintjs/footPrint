"use strict";
/**
 * SubflowExecutor — Isolation boundary for subflow execution.
 *
 * Responsibilities:
 * - Create isolated ExecutionRuntime for each subflow
 * - Apply input/output mapping via SubflowInputMapper
 * - Delegate traversal to a factory-created FlowchartTraverser
 * - Track subflow results for debugging/visualization
 *
 * Each subflow gets its own GlobalStore for isolation.
 * Traversal uses the SAME 7-phase algorithm as the top-level traverser
 * (via SubflowTraverserFactory), so deciders, selectors, loops, lazy subflows,
 * and abort signals all work inside subflows automatically.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubflowExecutor = void 0;
const types_js_1 = require("../../pause/types.js");
const SubflowInputMapper_js_1 = require("./SubflowInputMapper.js");
class SubflowExecutor {
    constructor(deps, traverserFactory) {
        this.deps = deps;
        this.traverserFactory = traverserFactory;
    }
    /**
     * Execute a subflow with isolated context.
     *
     * 1. Creates a fresh ExecutionRuntime for the subflow
     * 2. Applies input mapping to seed the subflow's GlobalStore
     * 3. Delegates traversal to a factory-created FlowchartTraverser
     * 4. Applies output mapping to write results back to parent scope
     * 5. Stores execution data for debugging/visualization
     */
    async executeSubflow(node, parentContext, breakFlag, branchPath, subflowResultsMap, parentTraversalContext) {
        var _a, _b;
        const subflowId = node.subflowId;
        const subflowName = (_a = node.subflowName) !== null && _a !== void 0 ? _a : node.name;
        parentContext.addFlowDebugMessage('subflow', `Entering ${subflowName} subflow`, {
            targetStage: subflowId,
        });
        this.deps.narrativeGenerator.onSubflowEntry(subflowName, subflowId, node.description, parentTraversalContext);
        // ─── Input Mapping ───
        const mountOptions = node.subflowMountOptions;
        let mappedInput = {};
        if (mountOptions) {
            try {
                const parentScope = parentContext.getScope();
                mappedInput = (0, SubflowInputMapper_js_1.getInitialScopeValues)(parentScope, mountOptions);
                if (Object.keys(mappedInput).length > 0) {
                    // mappedInput is captured in SubflowResult.treeContext for debugging
                }
            }
            catch (error) {
                parentContext.addError('inputMapperError', error.toString());
                this.deps.logger.error(`Error in inputMapper for subflow (${subflowId}):`, { error });
                throw error;
            }
        }
        // Create isolated runtime via dynamic construction (avoids circular import)
        const ExecutionRuntimeClass = this.deps.executionRuntime.constructor;
        const nestedRuntime = new ExecutionRuntimeClass(node.name, node.id);
        let nestedRootContext = nestedRuntime.rootStageContext;
        // Seed GlobalStore with input
        if (Object.keys(mappedInput).length > 0) {
            (0, SubflowInputMapper_js_1.seedSubflowGlobalStore)(nestedRuntime, mappedInput);
            // Refresh rootStageContext so WriteBuffer sees committed data
            const StageContextClass = nestedRootContext.constructor;
            nestedRootContext = new StageContextClass('', nestedRootContext.stageName, nestedRootContext.stageId, nestedRuntime.globalStore, '', nestedRuntime.executionHistory);
            nestedRuntime.rootStageContext = nestedRootContext;
        }
        // Prepare subflow root node — strip isSubflowRoot to prevent re-delegation
        const hasChildren = Boolean(node.children && node.children.length > 0);
        const subflowNode = {
            ...node,
            isSubflowRoot: false,
            next: hasChildren ? undefined : node.next,
        };
        // ─── Execute via factory traverser ───
        // The factory creates a full FlowchartTraverser with the same 7-phase algorithm,
        // sharing the parent's stageMap, subflows dict, and narrative generator.
        let subflowOutput;
        let subflowError;
        let traverserHandle;
        try {
            traverserHandle = this.traverserFactory({
                root: subflowNode,
                executionRuntime: nestedRuntime,
                readOnlyContext: mappedInput,
                subflowId,
            });
            subflowOutput = await traverserHandle.execute();
        }
        catch (error) {
            // PauseSignal is not an error — prepend subflow ID and re-throw immediately.
            // No error logging, no subflowResult recording — the pause is control flow.
            if ((0, types_js_1.isPauseSignal)(error)) {
                error.prependSubflow(subflowId);
                throw error;
            }
            subflowError = error;
            parentContext.addError('subflowError', error.toString());
            this.deps.logger.error(`Error in subflow (${subflowId}):`, { error });
        }
        // Always merge nested subflow results (even on error — partial results aid debugging)
        if (traverserHandle) {
            for (const [key, value] of traverserHandle.getSubflowResults()) {
                subflowResultsMap.set(key, value);
            }
        }
        const subflowTreeContext = nestedRuntime.getSnapshot();
        // ─── Output Mapping ───
        if (!subflowError && (mountOptions === null || mountOptions === void 0 ? void 0 : mountOptions.outputMapper)) {
            try {
                let outputContext = parentContext;
                if (parentContext.branchId && parentContext.branchId !== '' && parentContext.parent) {
                    outputContext = parentContext.parent;
                }
                const parentScope = outputContext.getScope();
                // For TypedScope subflows, stage functions return void — fall back to a shallow clone
                // of the subflow's shared state so outputMapper can access all scope values written
                // during the subflow. We shallow-clone to avoid aliasing the live SharedMemory context.
                // NOTE: the full scope is passed (not just declared outputs) — outputMapper must
                // explicitly select what to propagate to the parent.
                // Redaction: the subflow shares the parent's _redactedKeys Set (via the same ScopeFactory),
                // so any key marked redacted in the subflow is already visible in the parent's scope.
                // ScopeFacade.setValue checks _redactedKeys.has(key), so writes via outputMapper
                // automatically inherit the subflow's dynamic redaction state.
                const effectiveOutput = subflowOutput !== null && subflowOutput !== void 0 ? subflowOutput : { ...subflowTreeContext.sharedState };
                const mappedOutput = (0, SubflowInputMapper_js_1.applyOutputMapping)(effectiveOutput, parentScope, outputContext, mountOptions);
                outputContext.commit();
            }
            catch (error) {
                parentContext.addError('outputMapperError', error.toString());
                this.deps.logger.error(`Error in outputMapper for subflow (${subflowId}):`, { error });
            }
        }
        const subflowResult = {
            subflowId,
            subflowName,
            treeContext: {
                globalContext: subflowTreeContext.sharedState,
                stageContexts: subflowTreeContext.executionTree,
                history: subflowTreeContext.commitLog,
            },
            parentStageId: parentContext.getStageId(),
        };
        const subflowDef = (_b = this.deps.subflows) === null || _b === void 0 ? void 0 : _b[subflowId];
        if (subflowDef && subflowDef.buildTimeStructure) {
            subflowResult.pipelineStructure = subflowDef.buildTimeStructure;
        }
        subflowResultsMap.set(subflowId, subflowResult);
        parentContext.addFlowDebugMessage('subflow', `Exiting ${subflowName} subflow`, {
            targetStage: subflowId,
        });
        this.deps.narrativeGenerator.onSubflowExit(subflowName, subflowId, parentTraversalContext);
        parentContext.commit();
        if (subflowError) {
            throw subflowError;
        }
        return subflowOutput;
    }
}
exports.SubflowExecutor = SubflowExecutor;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU3ViZmxvd0V4ZWN1dG9yLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvaGFuZGxlcnMvU3ViZmxvd0V4ZWN1dG9yLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7OztHQWFHOzs7QUFHSCxtREFBcUQ7QUFVckQsbUVBQTRHO0FBRTVHLE1BQWEsZUFBZTtJQUMxQixZQUNVLElBQStCLEVBQy9CLGdCQUF1RDtRQUR2RCxTQUFJLEdBQUosSUFBSSxDQUEyQjtRQUMvQixxQkFBZ0IsR0FBaEIsZ0JBQWdCLENBQXVDO0lBQzlELENBQUM7SUFFSjs7Ozs7Ozs7T0FRRztJQUNILEtBQUssQ0FBQyxjQUFjLENBQ2xCLElBQTZCLEVBQzdCLGFBQTJCLEVBQzNCLFNBQW1DLEVBQ25DLFVBQThCLEVBQzlCLGlCQUE2QyxFQUM3QyxzQkFBeUM7O1FBRXpDLE1BQU0sU0FBUyxHQUFHLElBQUksQ0FBQyxTQUFVLENBQUM7UUFDbEMsTUFBTSxXQUFXLEdBQUcsTUFBQSxJQUFJLENBQUMsV0FBVyxtQ0FBSSxJQUFJLENBQUMsSUFBSSxDQUFDO1FBRWxELGFBQWEsQ0FBQyxtQkFBbUIsQ0FBQyxTQUFTLEVBQUUsWUFBWSxXQUFXLFVBQVUsRUFBRTtZQUM5RSxXQUFXLEVBQUUsU0FBUztTQUN2QixDQUFDLENBQUM7UUFDSCxJQUFJLENBQUMsSUFBSSxDQUFDLGtCQUFrQixDQUFDLGNBQWMsQ0FBQyxXQUFXLEVBQUUsU0FBUyxFQUFFLElBQUksQ0FBQyxXQUFXLEVBQUUsc0JBQXNCLENBQUMsQ0FBQztRQUU5Ryx3QkFBd0I7UUFDeEIsTUFBTSxZQUFZLEdBQUcsSUFBSSxDQUFDLG1CQUFtQixDQUFDO1FBQzlDLElBQUksV0FBVyxHQUE0QixFQUFFLENBQUM7UUFFOUMsSUFBSSxZQUFZLEVBQUUsQ0FBQztZQUNqQixJQUFJLENBQUM7Z0JBQ0gsTUFBTSxXQUFXLEdBQUcsYUFBYSxDQUFDLFFBQVEs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LGtCQUFrQixDQUFDLGFBQWEsQ0FBQyxXQUFXLEVBQUUsU0FBUyxFQUFFLHNCQUFzQixDQUFDLENBQUM7UUFFM0YsYUFBYSxDQUFDLE1BQU0sRUFBRSxDQUFDO1FBRXZCLElBQUksWUFBWSxFQUFFLENBQUM7WUFDakIsTUFBTSxZQUFZLENBQUM7UUFDckIsQ0FBQztRQUVELE9BQU8sYUFBYSxDQUFDO0lBQ3ZCLENBQUM7Q0FDRjtBQWpMRCwwQ0FpTEMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFN1YmZsb3dFeGVjdXRvciDigJQgSXNvbGF0aW9uIGJvdW5kYXJ5IGZvciBzdWJmbG93IGV4ZWN1dGlvbi5cbiAqXG4gKiBSZXNwb25zaWJpbGl0aWVzOlxuICogLSBDcmVhdGUgaXNvbGF0ZWQgRXhlY3V0aW9uUnVudGltZSBmb3IgZWFjaCBzdWJmbG93XG4gKiAtIEFwcGx5IGlucHV0L291dHB1dCBtYXBwaW5nIHZpYSBTdWJmbG93SW5wdXRNYXBwZXJcbiAqIC0gRGVsZWdhdGUgdHJhdmVyc2FsIHRvIGEgZmFjdG9yeS1jcmVhdGVkIEZsb3djaGFydFRyYXZlcnNlclxuICogLSBUcmFjayBzdWJmbG93IHJlc3VsdHMgZm9yIGRlYnVnZ2luZy92aXN1YWxpemF0aW9uXG4gKlxuICogRWFjaCBzdWJmbG93IGdldHMgaXRzIG93biBHbG9iYWxTdG9yZSBmb3IgaXNvbGF0aW9uLlxuICogVHJhdmVyc2FsIHVzZXMgdGhlIFNBTUUgNy1waGFzZSBhbGdvcml0aG0gYXMgdGhlIHRvcC1sZXZlbCB0cmF2ZXJzZXJcbiAqICh2aWEgU3ViZmxvd1RyYXZlcnNlckZhY3RvcnkpLCBzbyBkZWNpZGVycywgc2VsZWN0b3JzLCBsb29wcywgbGF6eSBzdWJmbG93cyxcbiAqIGFuZCBhYm9ydCBzaWduYWxzIGFsbCB3b3JrIGluc2lkZSBzdWJmbG93cyBhdXRvbWF0aWNhbGx5LlxuICovXG5cbmltcG9ydCB0eXBlIHsgU3RhZ2VDb250ZXh0IH0gZnJvbSAnLi4vLi4vbWVtb3J5L1N0YWdlQ29udGV4dC5qcyc7XG5pbXBvcnQgeyBpc1BhdXNlU2lnbmFsIH0gZnJvbSAnLi4vLi4vcGF1c2UvdHlwZXMuanMnO1xuaW1wb3J0IHR5cGUgeyBTdGFnZU5vZGUgfSBmcm9tICcuLi9ncmFwaC9TdGFnZU5vZGUuanMnO1xuaW1wb3J0IHR5cGUgeyBUcmF2ZXJzYWxDb250ZXh0IH0gZnJvbSAnLi4vbmFycmF0aXZlL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHtcbiAgSGFuZGxlckRlcHMsXG4gIElFeGVjdXRpb25SdW50aW1lLFxuICBTdWJmbG93UmVzdWx0LFxuICBTdWJmbG93VHJhdmVyc2VyRmFjdG9yeSxcbiAgU3ViZmxvd1RyYXZlcnNlckhhbmRsZSxcbn0gZnJvbSAnLi4vdHlwZXMuanMnO1xuaW1wb3J0IHsgYXBwbHlPdXRwdXRNYXBwaW5nLCBnZXRJbml0aWFsU2NvcGVWYWx1ZXMsIHNlZWRTdWJmbG93R2xvYmFsU3RvcmUgfSBmcm9tICcuL1N1YmZsb3dJbnB1dE1hcHBlci5qcyc7XG5cbmV4cG9ydCBjbGFzcyBTdWJmbG93RXhlY3V0b3I8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiB7XG4gIGNvbnN0cnVjdG9yKFxuICAgIHByaXZhdGUgZGVwczogSGFuZGxlckRlcHM8VE91dCwgVFNjb3BlPixcbiAgICBwcml2YXRlIHRyYXZlcnNlckZhY3Rvcnk6IFN1YmZsb3dUcmF2ZXJzZXJGYWN0b3J5PFRPdXQsIFRTY29wZT4sXG4gICkge31cblxuICAvKipcbiAgICogRXhlY3V0ZSBhIHN1YmZsb3cgd2l0aCBpc29sYXRlZCBjb250ZXh0LlxuICAgKlxuICAgKiAxLiBDcmVhdGVzIGEgZnJlc2ggRXhlY3V0aW9uUnVudGltZSBmb3IgdGhlIHN1YmZsb3dcbiAgICogMi4gQXBwbGllcyBpbnB1dCBtYXBwaW5nIHRvIHNlZWQgdGhlIHN1YmZsb3cncyBHbG9iYWxTdG9yZVxuICAgKiAzLiBEZWxlZ2F0ZXMgdHJhdmVyc2FsIHRvIGEgZmFjdG9yeS1jcmVhdGVkIEZsb3djaGFydFRyYXZlcnNlclxuICAgKiA0LiBBcHBsaWVzIG91dHB1dCBtYXBwaW5nIHRvIHdyaXRlIHJlc3VsdHMgYmFjayB0byBwYXJlbnQgc2NvcGVcbiAgICogNS4gU3RvcmVzIGV4ZWN1dGlvbiBkYXRhIGZvciBkZWJ1Z2dpbmcvdmlzdWFsaXphdGlvblxuICAgKi9cbiAgYXN5bmMgZXhlY3V0ZVN1YmZsb3coXG4gICAgbm9kZTogU3RhZ2VOb2RlPFRPdXQsIFRTY29wZT4sXG4gICAgcGFyZW50Q29udGV4dDogU3RhZ2VDb250ZXh0LFxuICAgIGJyZWFrRmxhZzogeyBzaG91bGRCcmVhazogYm9vbGVhbiB9LFxuICAgIGJyYW5jaFBhdGg6IHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICBzdWJmbG93UmVzdWx0c01hcDogTWFwPHN0cmluZywgU3ViZmxvd1Jlc3VsdD4sXG4gICAgcGFyZW50VHJhdmVyc2FsQ29udGV4dD86IFRyYXZlcnNhbENvbnRleHQsXG4gICk6IFByb21pc2U8YW55PiB7XG4gICAgY29uc3Qgc3ViZmxvd0lkID0gbm9kZS5zdWJmbG93SWQhO1xuICAgIGNvbnN0IHN1YmZsb3dOYW1lID0gbm9kZS5zdWJmbG93TmFtZSA/PyBub2RlLm5hbWU7XG5cbiAgICBwYXJlbnRDb250ZXh0LmFkZEZsb3dEZWJ1Z01lc3NhZ2UoJ3N1YmZsb3cnLCBgRW50ZXJpbmcgJHtzdWJmbG93TmFtZX0gc3ViZmxvd2AsIHtcbiAgICAgIHRhcmdldFN0YWdlOiBzdWJmbG93SWQsXG4gICAgfSk7XG4gICAgdGhpcy5kZXBzLm5hcnJhdGl2ZUdlbmVyYXRvci5vblN1YmZsb3dFbnRyeShzdWJmbG93TmFtZSwgc3ViZmxvd0lkLCBub2RlLmRlc2NyaXB0aW9uLCBwYXJlbnRUcmF2ZXJzYWxDb250ZXh0KTtcblxuICAgIC8vIOKUgOKUgOKUgCBJbnB1dCBNYXBwaW5nIOKUgOKUgOKUgFxuICAgIGNvbnN0IG1vdW50T3B0aW9ucyA9IG5vZGUuc3ViZmxvd01vdW50T3B0aW9ucztcbiAgICBsZXQgbWFwcGVkSW5wdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+ID0ge307XG5cbiAgICBpZiAobW91bnRPcHRpb25zKSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBwYXJlbnRTY29wZSA9IHBhcmVudENvbnRleHQuZ2V0U2NvcGUoKTtcbiAgICAgICAgbWFwcGVkSW5wdXQgPSBnZXRJbml0aWFsU2NvcGVWYWx1ZXMocGFyZW50U2NvcGUsIG1vdW50T3B0aW9ucyk7XG4gICAgICAgIGlmIChPYmplY3Qua2V5cyhtYXBwZWRJbnB1dCkubGVuZ3RoID4gMCkge1xuICAgICAgICAgIC8vIG1hcHBlZElucHV0IGlzIGNhcHR1cmVkIGluIFN1YmZsb3dSZXN1bHQudHJlZUNvbnRleHQgZm9yIGRlYnVnZ2luZ1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICAgIHBhcmVudENvbnRleHQuYWRkRXJyb3IoJ2lucHV0TWFwcGVyRXJyb3InLCBlcnJvci50b1N0cmluZygpKTtcbiAgICAgICAgdGhpcy5kZXBzLmxvZ2dlci5lcnJvcihgRXJyb3IgaW4gaW5wdXRNYXBwZXIgZm9yIHN1YmZsb3cgKCR7c3ViZmxvd0lkfSk6YCwgeyBlcnJvciB9KTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gQ3JlYXRlIGlzb2xhdGVkIHJ1bnRpbWUgdmlhIGR5bmFtaWMgY29uc3RydWN0aW9uIChhdm9pZHMgY2lyY3VsYXIgaW1wb3J0KVxuICAgIGNvbnN0IEV4ZWN1dGlvblJ1bnRpbWVDbGFzcyA9IHRoaXMuZGVwcy5leGVjdXRpb25SdW50aW1lLmNvbnN0cnVjdG9yIGFzIG5ldyAoXG4gICAgICBuYW1lOiBzdHJpbmcsXG4gICAgICBpZDogc3RyaW5nLFxuICAgICkgPT4gSUV4ZWN1dGlvblJ1bnRpbWU7XG4gICAgY29uc3QgbmVzdGVkUnVudGltZSA9IG5ldyBFeGVjdXRpb25SdW50aW1lQ2xhc3Mobm9kZS5uYW1lLCBub2RlLmlkKTtcbiAgICBsZXQgbmVzdGVkUm9vdENvbnRleHQgPSBuZXN0ZWRSdW50aW1lLnJvb3RTdGFnZUNvbnRleHQ7XG5cbiAgICAvLyBTZWVkIEdsb2JhbFN0b3JlIHdpdGggaW5wdXRcbiAgICBpZiAoT2JqZWN0LmtleXMobWFwcGVkSW5wdXQpLmxlbmd0aCA+IDApIHtcbiAgICAgIHNlZWRTdWJmbG93R2xvYmFsU3RvcmUobmVzdGVkUnVudGltZSwgbWFwcGVkSW5wdXQpO1xuICAgICAgLy8gUmVmcmVzaCByb290U3RhZ2VDb250ZXh0IHNvIFdyaXRlQnVmZmVyIHNlZXMgY29tbWl0dGVkIGRhdGFcbiAgICAgIGNvbnN0IFN0YWdlQ29udGV4dENsYXNzID0gbmVzdGVkUm9vdENvbnRleHQuY29uc3RydWN0b3IgYXMgbmV3ICguLi5hcmdzOiBhbnlbXSkgPT4gU3RhZ2VDb250ZXh0O1xuICAgICAgbmVzdGVkUm9vdENvbnRleHQgPSBuZXcgU3RhZ2VDb250ZXh0Q2xhc3MoXG4gICAgICAgICcnLFxuICAgICAgICBuZXN0ZWRSb290Q29udGV4dC5zdGFnZU5hbWUsXG4gICAgICAgIG5lc3RlZFJvb3RDb250ZXh0LnN0YWdlSWQsXG4gICAgICAgIG5lc3RlZFJ1bnRpbWUuZ2xvYmFsU3RvcmUsXG4gICAgICAgICcnLFxuICAgICAgICBuZXN0ZWRSdW50aW1lLmV4ZWN1dGlvbkhpc3RvcnksXG4gICAgICApO1xuICAgICAgbmVzdGVkUnVudGltZS5yb290U3RhZ2VDb250ZXh0ID0gbmVzdGVkUm9vdENvbnRleHQ7XG4gICAgfVxuXG4gICAgLy8gUHJlcGFyZSBzdWJmbG93IHJvb3Qgbm9kZSDigJQgc3RyaXAgaXNTdWJmbG93Um9vdCB0byBwcmV2ZW50IHJlLWRlbGVnYXRpb25cbiAgICBjb25zdCBoYXNDaGlsZHJlbiA9IEJvb2xlYW4obm9kZS5jaGlsZHJlbiAmJiBub2RlLmNoaWxkcmVuLmxlbmd0aCA+IDApO1xuICAgIGNvbnN0IHN1YmZsb3dOb2RlOiBTdGFnZU5vZGU8VE91dCwgVFNjb3BlPiA9IHtcbiAgICAgIC4uLm5vZGUsXG4gICAgICBpc1N1YmZsb3dSb290OiBmYWxzZSxcbiAgICAgIG5leHQ6IGhhc0NoaWxkcmVuID8gdW5kZWZpbmVkIDogbm9kZS5uZXh0LFxuICAgIH07XG5cbiAgICAvLyDilIDilIDilIAgRXhlY3V0ZSB2aWEgZmFjdG9yeSB0cmF2ZXJzZXIg4pSA4pSA4pSAXG4gICAgLy8gVGhlIGZhY3RvcnkgY3JlYXRlcyBhIGZ1bGwgRmxvd2NoYXJ0VHJhdmVyc2VyIHdpdGggdGhlIHNhbWUgNy1waGFzZSBhbGdvcml0aG0sXG4gICAgLy8gc2hhcmluZyB0aGUgcGFyZW50J3Mgc3RhZ2VNYXAsIHN1YmZsb3dzIGRpY3QsIGFuZCBuYXJyYXRpdmUgZ2VuZXJhdG9yLlxuICAgIGxldCBzdWJmbG93T3V0cHV0OiBhbnk7XG4gICAgbGV0IHN1YmZsb3dFcnJvcjogRXJyb3IgfCB1bmRlZmluZWQ7XG4gICAgbGV0IHRyYXZlcnNlckhhbmRsZTogU3ViZmxvd1RyYXZlcnNlckhhbmRsZTxUT3V0LCBUU2NvcGU+IHwgdW5kZWZpbmVkO1xuXG4gICAgdHJ5IHtcbiAgICAgIHRyYXZlcnNlckhhbmRsZSA9IHRoaXMudHJhdmVyc2VyRmFjdG9yeSh7XG4gICAgICAgIHJvb3Q6IHN1YmZsb3dOb2RlLFxuICAgICAgICBleGVjdXRpb25SdW50aW1lOiBuZXN0ZWRSdW50aW1lLFxuICAgICAgICByZWFkT25seUNvbnRleHQ6IG1hcHBlZElucHV0LFxuICAgICAgICBzdWJmbG93SWQsXG4gICAgICB9KTtcblxuICAgICAgc3ViZmxvd091dHB1dCA9IGF3YWl0IHRyYXZlcnNlckhhbmRsZS5leGVjdXRlKCk7XG4gICAgfSBjYXRjaCAoZXJyb3I6IGFueSkge1xuICAgICAgLy8gUGF1c2VTaWduYWwgaXMgbm90IGFuIGVycm9yIOKAlCBwcmVwZW5kIHN1YmZsb3cgSUQgYW5kIHJlLXRocm93IGltbWVkaWF0ZWx5LlxuICAgICAgLy8gTm8gZXJyb3IgbG9nZ2luZywgbm8gc3ViZmxvd1Jlc3VsdCByZWNvcmRpbmcg4oCUIHRoZSBwYXVzZSBpcyBjb250cm9sIGZsb3cuXG4gICAgICBpZiAoaXNQYXVzZVNpZ25hbChlcnJvcikpIHtcbiAgICAgICAgZXJyb3IucHJlcGVuZFN1YmZsb3coc3ViZmxvd0lkKTtcbiAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICB9XG4gICAgICBzdWJmbG93RXJyb3IgPSBlcnJvcjtcbiAgICAgIHBhcmVudENvbnRleHQuYWRkRXJyb3IoJ3N1YmZsb3dFcnJvcicsIGVycm9yLnRvU3RyaW5nKCkpO1xuICAgICAgdGhpcy5kZXBzLmxvZ2dlci5lcnJvcihgRXJyb3IgaW4gc3ViZmxvdyAoJHtzdWJmbG93SWR9KTpgLCB7IGVycm9yIH0pO1xuICAgIH1cblxuICAgIC8vIEFsd2F5cyBtZXJnZSBuZXN0ZWQgc3ViZmxvdyByZXN1bHRzIChldmVuIG9uIGVycm9yIOKAlCBwYXJ0aWFsIHJlc3VsdHMgYWlkIGRlYnVnZ2luZylcbiAgICBpZiAodHJhdmVyc2VySGFuZGxlKSB7XG4gICAgICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiB0cmF2ZXJzZXJIYW5kbGUuZ2V0U3ViZmxvd1Jlc3VsdHMoKSkge1xuICAgICAgICBzdWJmbG93UmVzdWx0c01hcC5zZXQoa2V5LCB2YWx1ZSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3Qgc3ViZmxvd1RyZWVDb250ZXh0ID0gbmVzdGVkUnVudGltZS5nZXRTbmFwc2hvdCgpO1xuXG4gICAgLy8g4pSA4pSA4pSAIE91dHB1dCBNYXBwaW5nIOKUgOKUgOKUgFxuICAgIGlmICghc3ViZmxvd0Vycm9yICYmIG1vdW50T3B0aW9ucz8ub3V0cHV0TWFwcGVyKSB7XG4gICAgICB0cnkge1xuICAgICAgICBsZXQgb3V0cHV0Q29udGV4dCA9IHBhcmVudENvbnRleHQ7XG4gICAgICAgIGlmIChwYXJlbnRDb250ZXh0LmJyYW5jaElkICYmIHBhcmVudENvbnRleHQuYnJhbmNoSWQgIT09ICcnICYmIHBhcmVudENvbnRleHQucGFyZW50KSB7XG4gICAgICAgICAgb3V0cHV0Q29udGV4dCA9IHBhcmVudENvbnRleHQucGFyZW50O1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcGFyZW50U2NvcGUgPSBvdXRwdXRDb250ZXh0LmdldFNjb3BlKCk7XG4gICAgICAgIC8vIEZvciBUeXBlZFNjb3BlIHN1YmZsb3dzLCBzdGFnZSBmdW5jdGlvbnMgcmV0dXJuIHZvaWQg4oCUIGZhbGwgYmFjayB0byBhIHNoYWxsb3cgY2xvbmVcbiAgICAgICAgLy8gb2YgdGhlIHN1YmZsb3cncyBzaGFyZWQgc3RhdGUgc28gb3V0cHV0TWFwcGVyIGNhbiBhY2Nlc3MgYWxsIHNjb3BlIHZhbHVlcyB3cml0dGVuXG4gICAgICAgIC8vIGR1cmluZyB0aGUgc3ViZmxvdy4gV2Ugc2hhbGxvdy1jbG9uZSB0byBhdm9pZCBhbGlhc2luZyB0aGUgbGl2ZSBTaGFyZWRNZW1vcnkgY29udGV4dC5cbiAgICAgICAgLy8gTk9URTogdGhlIGZ1bGwgc2NvcGUgaXMgcGFzc2VkIChub3QganVzdCBkZWNsYXJlZCBvdXRwdXRzKSDigJQgb3V0cHV0TWFwcGVyIG11c3RcbiAgICAgICAgLy8gZXhwbGljaXRseSBzZWxlY3Qgd2hhdCB0byBwcm9wYWdhdGUgdG8gdGhlIHBhcmVudC5cbiAgICAgICAgLy8gUmVkYWN0aW9uOiB0aGUgc3ViZmxvdyBzaGFyZXMgdGhlIHBhcmVudCdzIF9yZWRhY3RlZEtleXMgU2V0ICh2aWEgdGhlIHNhbWUgU2NvcGVGYWN0b3J5KSxcbiAgICAgICAgLy8gc28gYW55IGtleSBtYXJrZWQgcmVkYWN0ZWQgaW4gdGhlIHN1YmZsb3cgaXMgYWxyZWFkeSB2aXNpYmxlIGluIHRoZSBwYXJlbnQncyBzY29wZS5cbiAgICAgICAgLy8gU2NvcGVGYWNhZGUuc2V0VmFsdWUgY2hlY2tzIF9yZWRhY3RlZEtleXMuaGFzKGtleSksIHNvIHdyaXRlcyB2aWEgb3V0cHV0TWFwcGVyXG4gICAgICAgIC8vIGF1dG9tYXRpY2FsbHkgaW5oZXJpdCB0aGUgc3ViZmxvdydzIGR5bmFtaWMgcmVkYWN0aW9uIHN0YXRlLlxuICAgICAgICBjb25zdCBlZmZlY3RpdmVPdXRwdXQgPSBzdWJmbG93T3V0cHV0ID8/IHsgLi4uc3ViZmxvd1RyZWVDb250ZXh0LnNoYXJlZFN0YXRlIH07XG4gICAgICAgIGNvbnN0IG1hcHBlZE91dHB1dCA9IGFwcGx5T3V0cHV0TWFwcGluZyhlZmZlY3RpdmVPdXRwdXQsIHBhcmVudFNjb3BlLCBvdXRwdXRDb250ZXh0LCBtb3VudE9wdGlvbnMpO1xuXG4gICAgICAgIG91dHB1dENvbnRleHQuY29tbWl0KCk7XG4gICAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICAgIHBhcmVudENvbnRleHQuYWRkRXJyb3IoJ291dHB1dE1hcHBlckVycm9yJywgZXJyb3IudG9TdHJpbmcoKSk7XG4gICAgICAgIHRoaXMuZGVwcy5sb2dnZXIuZXJyb3IoYEVycm9yIGluIG91dHB1dE1hcHBlciBmb3Igc3ViZmxvdyAoJHtzdWJmbG93SWR9KTpgLCB7IGVycm9yIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIGNvbnN0IHN1YmZsb3dSZXN1bHQ6IFN1YmZsb3dSZXN1bHQgPSB7XG4gICAgICBzdWJmbG93SWQsXG4gICAgICBzdWJmbG93TmFtZSxcbiAgICAgIHRyZWVDb250ZXh0OiB7XG4gICAgICAgIGdsb2JhbENvbnRleHQ6IHN1YmZsb3dUcmVlQ29udGV4dC5zaGFyZWRTdGF0ZSxcbiAgICAgICAgc3RhZ2VDb250ZXh0czogc3ViZmxvd1RyZWVDb250ZXh0LmV4ZWN1dGlvblRyZWUgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgICAgICAgaGlzdG9yeTogc3ViZmxvd1RyZWVDb250ZXh0LmNvbW1pdExvZyxcbiAgICAgIH0sXG4gICAgICBwYXJlbnRTdGFnZUlkOiBwYXJlbnRDb250ZXh0LmdldFN0YWdlSWQoKSxcbiAgICB9O1xuXG4gICAgY29uc3Qgc3ViZmxvd0RlZiA9IHRoaXMuZGVwcy5zdWJmbG93cz8uW3N1YmZsb3dJZF07XG4gICAgaWYgKHN1YmZsb3dEZWYgJiYgKHN1YmZsb3dEZWYgYXMgYW55KS5idWlsZFRpbWVTdHJ1Y3R1cmUpIHtcbiAgICAgIHN1YmZsb3dSZXN1bHQucGlwZWxpbmVTdHJ1Y3R1cmUgPSAoc3ViZmxvd0RlZiBhcyBhbnkpLmJ1aWxkVGltZVN0cnVjdHVyZTtcbiAgICB9XG5cbiAgICBzdWJmbG93UmVzdWx0c01hcC5zZXQoc3ViZmxvd0lkLCBzdWJmbG93UmVzdWx0KTtcblxuICAgIHBhcmVudENvbnRleHQuYWRkRmxvd0RlYnVnTWVzc2FnZSgnc3ViZmxvdycsIGBFeGl0aW5nICR7c3ViZmxvd05hbWV9IHN1YmZsb3dgLCB7XG4gICAgICB0YXJnZXRTdGFnZTogc3ViZmxvd0lkLFxuICAgIH0pO1xuICAgIHRoaXMuZGVwcy5uYXJyYXRpdmVHZW5lcmF0b3Iub25TdWJmbG93RXhpdChzdWJmbG93TmFtZSwgc3ViZmxvd0lkLCBwYXJlbnRUcmF2ZXJzYWxDb250ZXh0KTtcblxuICAgIHBhcmVudENvbnRleHQuY29tbWl0KCk7XG5cbiAgICBpZiAoc3ViZmxvd0Vycm9yKSB7XG4gICAgICB0aHJvdyBzdWJmbG93RXJyb3I7XG4gICAgfVxuXG4gICAgcmV0dXJuIHN1YmZsb3dPdXRwdXQ7XG4gIH1cbn1cbiJdfQ==