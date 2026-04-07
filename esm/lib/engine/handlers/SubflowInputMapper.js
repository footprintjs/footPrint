/**
 * SubflowInputMapper — Pure functions for subflow data contracts.
 *
 * Mental model: Subflow = Pure Function
 * - Isolated scope (own GlobalStore)
 * - Explicit inputs via inputMapper
 * - Explicit outputs via outputMapper
 *
 * | Scenario        | Behavior                                  |
 * |-----------------|-------------------------------------------|
 * | No inputMapper  | Subflow starts with empty scope           |
 * | No outputMapper | Subflow scope changes discarded           |
 * | Both present    | Full data contract (args in, results out) |
 * | Neither present | Complete isolation (side effects only)    |
 */
/** Extract values from parent scope using inputMapper. */
export function extractParentScopeValues(parentScope, options) {
    if (!(options === null || options === void 0 ? void 0 : options.inputMapper)) {
        return {};
    }
    const result = options.inputMapper(parentScope);
    if (result === null || result === undefined) {
        return {};
    }
    return result;
}
/**
 * Get the initial scope values for a subflow.
 * Always isolated — only inputMapper values are included.
 */
export function getInitialScopeValues(parentScope, options) {
    return extractParentScopeValues(parentScope, options);
}
/**
 * Create a new HandlerDeps for subflow execution.
 * Key: sets readOnlyContext to mapped input so StageRunner passes it to ScopeFactory.
 */
export function createSubflowHandlerDeps(parentDeps, subflowRuntime, mappedInput) {
    return {
        stageMap: parentDeps.stageMap,
        root: parentDeps.root,
        scopeFactory: parentDeps.scopeFactory,
        subflows: parentDeps.subflows,
        throttlingErrorChecker: parentDeps.throttlingErrorChecker,
        streamHandlers: parentDeps.streamHandlers,
        scopeProtectionMode: parentDeps.scopeProtectionMode,
        executionRuntime: subflowRuntime,
        readOnlyContext: mappedInput,
        executionEnv: parentDeps.executionEnv, // inherited — like process.env
        narrativeGenerator: parentDeps.narrativeGenerator,
        logger: parentDeps.logger,
    };
}
/**
 * Seed the subflow's GlobalStore with initial values.
 * Called before subflow execution to make inputMapper values available.
 */
export function seedSubflowGlobalStore(subflowRuntime, initialValues) {
    const rootContext = subflowRuntime.rootStageContext;
    for (const [key, value] of Object.entries(initialValues)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            for (const [nestedKey, nestedValue] of Object.entries(value)) {
                rootContext.setObject([key], nestedKey, nestedValue);
            }
        }
        else {
            rootContext.setGlobal(key, value);
        }
    }
    rootContext.commit();
}
/**
 * Apply output mapping after subflow completion.
 * Writes mapped values back to parent scope using merge semantics:
 * arrays are appended, objects are shallow-merged, scalars are replaced.
 */
export function applyOutputMapping(subflowOutput, parentScope, parentContext, options) {
    if (!(options === null || options === void 0 ? void 0 : options.outputMapper)) {
        return undefined;
    }
    const mappedOutput = options.outputMapper(subflowOutput, parentScope);
    if (mappedOutput === null || mappedOutput === undefined) {
        return undefined;
    }
    for (const [key, value] of Object.entries(mappedOutput)) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            for (const [nestedKey, nestedValue] of Object.entries(value)) {
                if (Array.isArray(nestedValue)) {
                    parentContext.appendToArray([key], nestedKey, nestedValue);
                }
                else if (typeof nestedValue === 'object' && nestedValue !== null) {
                    parentContext.mergeObject([key], nestedKey, nestedValue);
                }
                else {
                    parentContext.setObject([key], nestedKey, nestedValue);
                }
            }
        }
        else if (Array.isArray(value)) {
            if ((options === null || options === void 0 ? void 0 : options.arrayMerge) === 'replace') {
                parentContext.setGlobal(key, value);
            }
            else {
                const existing = parentContext.getGlobal(key);
                if (Array.isArray(existing)) {
                    parentContext.setGlobal(key, [...existing, ...value]);
                }
                else {
                    parentContext.setGlobal(key, value);
                }
            }
        }
        else {
            parentContext.setGlobal(key, value);
        }
    }
    return mappedOutput;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU3ViZmxvd0lucHV0TWFwcGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvaGFuZGxlcnMvU3ViZmxvd0lucHV0TWFwcGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7OztHQWNHO0FBS0gsMERBQTBEO0FBQzFELE1BQU0sVUFBVSx3QkFBd0IsQ0FDdEMsV0FBeUIsRUFDekIsT0FBMEQ7SUFFMUQsSUFBSSxDQUFDLENBQUEsT0FBTyxhQUFQLE9BQU8sdUJBQVAsT0FBTyxDQUFFLFdBQVcsQ0FBQSxFQUFFLENBQUM7UUFDMUIsT0FBTyxFQUFFLENBQUM7SUFDWixDQUFDO0lBRUQsTUFBTSxNQUFNLEdBQUcsT0FBTyxDQUFDLFdBQVcsQ0FBQyxXQUFXLENBQUMsQ0FBQztJQUNoRCxJQUFJLE1BQU0sS0FBSyxJQUFJLElBQUksTUFBTSxLQUFLLFNBQVMsRUFBRSxDQUFDO1FBQzVDLE9BQU8sRUFBRSxDQUFDO0lBQ1osQ0FBQztJQUVELE9BQU8sTUFBTSxDQUFDO0FBQ2hCLENBQUM7QUFFRDs7O0dBR0c7QUFDSCxNQUFNLFVBQVUscUJBQXFCLENBQ25DLFdBQXlCLEVBQ3pCLE9BQTBEO0lBRTFELE9BQU8sd0JBQXdCLENBQUMsV0FBVyxFQUFFLE9BQU8sQ0FBNEIsQ0FBQztBQUNuRixDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsTUFBTSxVQUFVLHdCQUF3QixDQUN0QyxVQUFxQyxFQUNyQyxjQUFpQyxFQUNqQyxXQUFvQztJQUVwQyxPQUFPO1FBQ0wsUUFBUSxFQUFFLFVBQVUsQ0FBQyxRQUFRO1FBQzdCLElBQUksRUFBRSxVQUFVLENBQUMsSUFBSTtRQUNyQixZQUFZLEVBQUUsVUFBVSxDQUFDLFlBQVk7UUFDckMsUUFBUSxFQUFFLFVBQVUsQ0FBQyxRQUFRO1FBQzdCLHNCQUFzQixFQUFFLFVBQVUsQ0FBQyxzQkFBc0I7UUFDekQsY0FBYyxFQUFFLFVBQVUsQ0FBQyxj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QztRQUNILENBQUM7YUFBTSxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztZQUNoQyxJQUFJLENBQUEsT0FBTyxhQUFQLE9BQU8sdUJBQVAsT0FBTyxDQUFFLFVBQVUsTUFBSyxTQUFTLEVBQUUsQ0FBQztnQkFDdEMsYUFBYSxDQUFDLFNBQVMsQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUM7WUFDdEMsQ0FBQztpQkFBTSxDQUFDO2dCQUNOLE1BQU0sUUFBUSxHQUFHLGFBQWEsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUM7Z0JBQzlDLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDO29CQUM1QixhQUFhLENBQUMsU0FBUyxDQUFDLEdBQUcsRUFBRSxDQUFDLEdBQUcsUUFBUSxFQUFFLEdBQUcsS0FBSyxDQUFDLENBQUMsQ0FBQztnQkFDeEQsQ0FBQztxQkFBTSxDQUFDO29CQUNOLGFBQWEsQ0FBQyxTQUFTLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxDQUFDO2dCQUN0QyxDQUFDO1lBQ0gsQ0FBQztRQUNILENBQUM7YUFBTSxDQUFDO1lBQ04sYUFBYSxDQUFDLFNBQVMsQ0FBQyxHQUFHLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFDdEMsQ0FBQztJQUNILENBQUM7SUFFRCxPQUFPLFlBQVksQ0FBQztBQUN0QixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTdWJmbG93SW5wdXRNYXBwZXIg4oCUIFB1cmUgZnVuY3Rpb25zIGZvciBzdWJmbG93IGRhdGEgY29udHJhY3RzLlxuICpcbiAqIE1lbnRhbCBtb2RlbDogU3ViZmxvdyA9IFB1cmUgRnVuY3Rpb25cbiAqIC0gSXNvbGF0ZWQgc2NvcGUgKG93biBHbG9iYWxTdG9yZSlcbiAqIC0gRXhwbGljaXQgaW5wdXRzIHZpYSBpbnB1dE1hcHBlclxuICogLSBFeHBsaWNpdCBvdXRwdXRzIHZpYSBvdXRwdXRNYXBwZXJcbiAqXG4gKiB8IFNjZW5hcmlvICAgICAgICB8IEJlaGF2aW9yICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHxcbiAqIHwtLS0tLS0tLS0tLS0tLS0tLXwtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tfFxuICogfCBObyBpbnB1dE1hcHBlciAgfCBTdWJmbG93IHN0YXJ0cyB3aXRoIGVtcHR5IHNjb3BlICAgICAgICAgICB8XG4gKiB8IE5vIG91dHB1dE1hcHBlciB8IFN1YmZsb3cgc2NvcGUgY2hhbmdlcyBkaXNjYXJkZWQgICAgICAgICAgIHxcbiAqIHwgQm90aCBwcmVzZW50ICAgIHwgRnVsbCBkYXRhIGNvbnRyYWN0IChhcmdzIGluLCByZXN1bHRzIG91dCkgfFxuICogfCBOZWl0aGVyIHByZXNlbnQgfCBDb21wbGV0ZSBpc29sYXRpb24gKHNpZGUgZWZmZWN0cyBvbmx5KSAgICB8XG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTdGFnZUNvbnRleHQgfSBmcm9tICcuLi8uLi9tZW1vcnkvU3RhZ2VDb250ZXh0LmpzJztcbmltcG9ydCB0eXBlIHsgSGFuZGxlckRlcHMsIElFeGVjdXRpb25SdW50aW1lLCBTdWJmbG93TW91bnRPcHRpb25zIH0gZnJvbSAnLi4vdHlwZXMuanMnO1xuXG4vKiogRXh0cmFjdCB2YWx1ZXMgZnJvbSBwYXJlbnQgc2NvcGUgdXNpbmcgaW5wdXRNYXBwZXIuICovXG5leHBvcnQgZnVuY3Rpb24gZXh0cmFjdFBhcmVudFNjb3BlVmFsdWVzPFRQYXJlbnRTY29wZSwgVFN1YmZsb3dJbnB1dD4oXG4gIHBhcmVudFNjb3BlOiBUUGFyZW50U2NvcGUsXG4gIG9wdGlvbnM/OiBTdWJmbG93TW91bnRPcHRpb25zPFRQYXJlbnRTY29wZSwgVFN1YmZsb3dJbnB1dD4sXG4pOiBUU3ViZmxvd0lucHV0IHwgUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBpZiAoIW9wdGlvbnM/LmlucHV0TWFwcGVyKSB7XG4gICAgcmV0dXJuIHt9O1xuICB9XG5cbiAgY29uc3QgcmVzdWx0ID0gb3B0aW9ucy5pbnB1dE1hcHBlcihwYXJlbnRTY29wZSk7XG4gIGlmIChyZXN1bHQgPT09IG51bGwgfHwgcmVzdWx0ID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4ge307XG4gIH1cblxuICByZXR1cm4gcmVzdWx0O1xufVxuXG4vKipcbiAqIEdldCB0aGUgaW5pdGlhbCBzY29wZSB2YWx1ZXMgZm9yIGEgc3ViZmxvdy5cbiAqIEFsd2F5cyBpc29sYXRlZCDigJQgb25seSBpbnB1dE1hcHBlciB2YWx1ZXMgYXJlIGluY2x1ZGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2V0SW5pdGlhbFNjb3BlVmFsdWVzPFRQYXJlbnRTY29wZSwgVFN1YmZsb3dJbnB1dD4oXG4gIHBhcmVudFNjb3BlOiBUUGFyZW50U2NvcGUsXG4gIG9wdGlvbnM/OiBTdWJmbG93TW91bnRPcHRpb25zPFRQYXJlbnRTY29wZSwgVFN1YmZsb3dJbnB1dD4sXG4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIHJldHVybiBleHRyYWN0UGFyZW50U2NvcGVWYWx1ZXMocGFyZW50U2NvcGUsIG9wdGlvbnMpIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xufVxuXG4vKipcbiAqIENyZWF0ZSBhIG5ldyBIYW5kbGVyRGVwcyBmb3Igc3ViZmxvdyBleGVjdXRpb24uXG4gKiBLZXk6IHNldHMgcmVhZE9ubHlDb250ZXh0IHRvIG1hcHBlZCBpbnB1dCBzbyBTdGFnZVJ1bm5lciBwYXNzZXMgaXQgdG8gU2NvcGVGYWN0b3J5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlU3ViZmxvd0hhbmRsZXJEZXBzPFRPdXQgPSBhbnksIFRTY29wZSA9IGFueT4oXG4gIHBhcmVudERlcHM6IEhhbmRsZXJEZXBzPFRPdXQsIFRTY29wZT4sXG4gIHN1YmZsb3dSdW50aW1lOiBJRXhlY3V0aW9uUnVudGltZSxcbiAgbWFwcGVkSW5wdXQ6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuKTogSGFuZGxlckRlcHM8VE91dCwgVFNjb3BlPiB7XG4gIHJldHVybiB7XG4gICAgc3RhZ2VNYXA6IHBhcmVudERlcHMuc3RhZ2VNYXAsXG4gICAgcm9vdDogcGFyZW50RGVwcy5yb290LFxuICAgIHNjb3BlRmFjdG9yeTogcGFyZW50RGVwcy5zY29wZUZhY3RvcnksXG4gICAgc3ViZmxvd3M6IHBhcmVudERlcHMuc3ViZmxvd3MsXG4gICAgdGhyb3R0bGluZ0Vycm9yQ2hlY2tlcjogcGFyZW50RGVwcy50aHJvdHRsaW5nRXJyb3JDaGVja2VyLFxuICAgIHN0cmVhbUhhbmRsZXJzOiBwYXJlbnREZXBzLnN0cmVhbUhhbmRsZXJzLFxuICAgIHNjb3BlUHJvdGVjdGlvbk1vZGU6IHBhcmVudERlcHMuc2NvcGVQcm90ZWN0aW9uTW9kZSxcbiAgICBleGVjdXRpb25SdW50aW1lOiBzdWJmbG93UnVudGltZSxcbiAgICByZWFkT25seUNvbnRleHQ6IG1hcHBlZElucHV0LFxuICAgIGV4ZWN1dGlvbkVudjogcGFyZW50RGVwcy5leGVjdXRpb25FbnYsIC8vIGluaGVyaXRlZCDigJQgbGlrZSBwcm9jZXNzLmVudlxuICAgIG5hcnJhdGl2ZUdlbmVyYXRvcjogcGFyZW50RGVwcy5uYXJyYXRpdmVHZW5lcmF0b3IsXG4gICAgbG9nZ2VyOiBwYXJlbnREZXBzLmxvZ2dlcixcbiAgfTtcbn1cblxuLyoqXG4gKiBTZWVkIHRoZSBzdWJmbG93J3MgR2xvYmFsU3RvcmUgd2l0aCBpbml0aWFsIHZhbHVlcy5cbiAqIENhbGxlZCBiZWZvcmUgc3ViZmxvdyBleGVjdXRpb24gdG8gbWFrZSBpbnB1dE1hcHBlciB2YWx1ZXMgYXZhaWxhYmxlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2VlZFN1YmZsb3dHbG9iYWxTdG9yZShcbiAgc3ViZmxvd1J1bnRpbWU6IElFeGVjdXRpb25SdW50aW1lLFxuICBpbml0aWFsVmFsdWVzOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbik6IHZvaWQge1xuICBjb25zdCByb290Q29udGV4dCA9IHN1YmZsb3dSdW50aW1lLnJvb3RTdGFnZUNvbnRleHQ7XG5cbiAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMoaW5pdGlhbFZhbHVlcykpIHtcbiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiB2YWx1ZSAhPT0gbnVsbCAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgIGZvciAoY29uc3QgW25lc3RlZEtleSwgbmVzdGVkVmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgICAgICByb290Q29udGV4dC5zZXRPYmplY3QoW2tleV0sIG5lc3RlZEtleSwgbmVzdGVkVmFsdWUpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICByb290Q29udGV4dC5zZXRHbG9iYWwoa2V5LCB2YWx1ZSk7XG4gICAgfVxuICB9XG5cbiAgcm9vdENvbnRleHQuY29tbWl0KCk7XG59XG5cbi8qKlxuICogQXBwbHkgb3V0cHV0IG1hcHBpbmcgYWZ0ZXIgc3ViZmxvdyBjb21wbGV0aW9uLlxuICogV3JpdGVzIG1hcHBlZCB2YWx1ZXMgYmFjayB0byBwYXJlbnQgc2NvcGUgdXNpbmcgbWVyZ2Ugc2VtYW50aWNzOlxuICogYXJyYXlzIGFyZSBhcHBlbmRlZCwgb2JqZWN0cyBhcmUgc2hhbGxvdy1tZXJnZWQsIHNjYWxhcnMgYXJlIHJlcGxhY2VkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXBwbHlPdXRwdXRNYXBwaW5nPFRQYXJlbnRTY29wZSwgVFN1YmZsb3dPdXRwdXQ+KFxuICBzdWJmbG93T3V0cHV0OiBUU3ViZmxvd091dHB1dCxcbiAgcGFyZW50U2NvcGU6IFRQYXJlbnRTY29wZSxcbiAgcGFyZW50Q29udGV4dDogU3RhZ2VDb250ZXh0LFxuICBvcHRpb25zPzogU3ViZmxvd01vdW50T3B0aW9uczxUUGFyZW50U2NvcGUsIGFueSwgVFN1YmZsb3dPdXRwdXQ+LFxuKTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQge1xuICBpZiAoIW9wdGlvbnM/Lm91dHB1dE1hcHBlcikge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICBjb25zdCBtYXBwZWRPdXRwdXQgPSBvcHRpb25zLm91dHB1dE1hcHBlcihzdWJmbG93T3V0cHV0LCBwYXJlbnRTY29wZSk7XG5cbiAgaWYgKG1hcHBlZE91dHB1dCA9PT0gbnVsbCB8fCBtYXBwZWRPdXRwdXQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB1bmRlZmluZWQ7XG4gIH1cblxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhtYXBwZWRPdXRwdXQpKSB7XG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiYgdmFsdWUgIT09IG51bGwgJiYgIUFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICBmb3IgKGNvbnN0IFtuZXN0ZWRLZXksIG5lc3RlZFZhbHVlXSBvZiBPYmplY3QuZW50cmllcyh2YWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobmVzdGVkVmFsdWUpKSB7XG4gICAgICAgICAgcGFyZW50Q29udGV4dC5hcHBlbmRUb0FycmF5KFtrZXldLCBuZXN0ZWRLZXksIG5lc3RlZFZhbHVlKTtcbiAgICAgICAgfSBlbHNlIGlmICh0eXBlb2YgbmVzdGVkVmFsdWUgPT09ICdvYmplY3QnICYmIG5lc3RlZFZhbHVlICE9PSBudWxsKSB7XG4gICAgICAgICAgcGFyZW50Q29udGV4dC5tZXJnZU9iamVjdChba2V5XSwgbmVzdGVkS2V5LCBuZXN0ZWRWYWx1ZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcGFyZW50Q29udGV4dC5zZXRPYmplY3QoW2tleV0sIG5lc3RlZEtleSwgbmVzdGVkVmFsdWUpO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgaWYgKG9wdGlvbnM/LmFycmF5TWVyZ2UgPT09ICdyZXBsYWNlJykge1xuICAgICAgICBwYXJlbnRDb250ZXh0LnNldEdsb2JhbChrZXksIHZhbHVlKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGNvbnN0IGV4aXN0aW5nID0gcGFyZW50Q29udGV4dC5nZXRHbG9iYWwoa2V5KTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZXhpc3RpbmcpKSB7XG4gICAgICAgICAgcGFyZW50Q29udGV4dC5zZXRHbG9iYWwoa2V5LCBbLi4uZXhpc3RpbmcsIC4uLnZhbHVlXSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgcGFyZW50Q29udGV4dC5zZXRHbG9iYWwoa2V5LCB2YWx1ZSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgcGFyZW50Q29udGV4dC5zZXRHbG9iYWwoa2V5LCB2YWx1ZSk7XG4gICAgfVxuICB9XG5cbiAgcmV0dXJuIG1hcHBlZE91dHB1dDtcbn1cbiJdfQ==