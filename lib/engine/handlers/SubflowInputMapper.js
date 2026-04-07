"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyOutputMapping = exports.seedSubflowGlobalStore = exports.createSubflowHandlerDeps = exports.getInitialScopeValues = exports.extractParentScopeValues = void 0;
/** Extract values from parent scope using inputMapper. */
function extractParentScopeValues(parentScope, options) {
    if (!(options === null || options === void 0 ? void 0 : options.inputMapper)) {
        return {};
    }
    const result = options.inputMapper(parentScope);
    if (result === null || result === undefined) {
        return {};
    }
    return result;
}
exports.extractParentScopeValues = extractParentScopeValues;
/**
 * Get the initial scope values for a subflow.
 * Always isolated — only inputMapper values are included.
 */
function getInitialScopeValues(parentScope, options) {
    return extractParentScopeValues(parentScope, options);
}
exports.getInitialScopeValues = getInitialScopeValues;
/**
 * Create a new HandlerDeps for subflow execution.
 * Key: sets readOnlyContext to mapped input so StageRunner passes it to ScopeFactory.
 */
function createSubflowHandlerDeps(parentDeps, subflowRuntime, mappedInput) {
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
exports.createSubflowHandlerDeps = createSubflowHandlerDeps;
/**
 * Seed the subflow's GlobalStore with initial values.
 * Called before subflow execution to make inputMapper values available.
 */
function seedSubflowGlobalStore(subflowRuntime, initialValues) {
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
exports.seedSubflowGlobalStore = seedSubflowGlobalStore;
/**
 * Apply output mapping after subflow completion.
 * Writes mapped values back to parent scope using merge semantics:
 * arrays are appended, objects are shallow-merged, scalars are replaced.
 */
function applyOutputMapping(subflowOutput, parentScope, parentContext, options) {
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
exports.applyOutputMapping = applyOutputMapping;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU3ViZmxvd0lucHV0TWFwcGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvaGFuZGxlcnMvU3ViZmxvd0lucHV0TWFwcGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7R0FjRzs7O0FBS0gsMERBQTBEO0FBQzFELFNBQWdCLHdCQUF3QixDQUN0QyxXQUF5QixFQUN6QixPQUEwRDtJQUUxRCxJQUFJLENBQUMsQ0FBQSxPQUFPLGFBQVAsT0FBTyx1QkFBUCxPQUFPLENBQUUsV0FBVyxDQUFBLEVBQUUsQ0FBQztRQUMxQixPQUFPLEVBQUUsQ0FBQztJQUNaLENBQUM7SUFFRCxNQUFNLE1BQU0sR0FBRyxPQUFPLENBQUMsV0FBVyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0lBQ2hELElBQUksTUFBTSxLQUFLLElBQUksSUFBSSxNQUFNLEtBQUssU0FBUyxFQUFFLENBQUM7UUFDNUMsT0FBTyxFQUFFLENBQUM7SUFDWixDQUFDO0lBRUQsT0FBTyxNQUFNLENBQUM7QUFDaEIsQ0FBQztBQWRELDREQWNDO0FBRUQ7OztHQUdHO0FBQ0gsU0FBZ0IscUJBQXFCLENBQ25DLFdBQXlCLEVBQ3pCLE9BQTBEO0lBRTFELE9BQU8sd0JBQXdCLENBQUMsV0FBVyxFQUFFLE9BQU8sQ0FBNEIsQ0FBQztBQUNuRixDQUFDO0FBTEQsc0RBS0M7QUFFRDs7O0dBR0c7QUFDSCxTQUFnQix3QkFBd0IsQ0FDdEMsVUFBcUMsRUFDckMsY0FBaUMsRUFDakMsV0FBb0M7SUFFcEMsT0FBTztRQUNMLFFBQVEsRUFBRSxVQUFVLENBQUMsUUFBUTtRQUM3QixJQUFJLEVBQUUsVUFBVSxDQUFDLElBQUk7UUFDckIsWUFBWSxFQUFFLFVBQVUsQ0FBQyxZQUFZO1FBQ3JDLFFBQVEsRUFBRSxVQUFVLENBQUMsUUFBUTtRQUM3QixzQkFBc0IsRUFBRSxVQUFVLENBQUMsc0JBQXNCO1FBQ3pELGNBQWMsRUFBRSxV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QUMsQ0FBQztnQkFDekQsQ0FBQztZQUNILENBQUM7UUFDSCxDQUFDO2FBQU0sSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7WUFDaEMsSUFBSSxDQUFBLE9BQU8sYUFBUCxPQUFPLHVCQUFQLE9BQU8sQ0FBRSxVQUFVLE1BQUssU0FBUyxFQUFFLENBQUM7Z0JBQ3RDLGFBQWEsQ0FBQyxTQUFTLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxDQUFDO1lBQ3RDLENBQUM7aUJBQU0sQ0FBQztnQkFDTixNQUFNLFFBQVEsR0FBRyxhQUFhLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDO2dCQUM5QyxJQUFJLEtBQUssQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQztvQkFDNUIsYUFBYSxDQUFDLFNBQVMsQ0FBQyxHQUFHLEVBQUUsQ0FBQyxHQUFHLFFBQVEsRUFBRSxHQUFHLEtBQUssQ0FBQyxDQUFDLENBQUM7Z0JBQ3hELENBQUM7cUJBQU0sQ0FBQztvQkFDTixhQUFhLENBQUMsU0FBUyxDQUFDLEdBQUcsRUFBRSxLQUFLLENBQUMsQ0FBQztnQkFDdEMsQ0FBQztZQUNILENBQUM7UUFDSCxDQUFDO2FBQU0sQ0FBQztZQUNOLGFBQWEsQ0FBQyxTQUFTLENBQUMsR0FBRyxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBQ3RDLENBQUM7SUFDSCxDQUFDO0lBRUQsT0FBTyxZQUFZLENBQUM7QUFDdEIsQ0FBQztBQTVDRCxnREE0Q0MiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFN1YmZsb3dJbnB1dE1hcHBlciDigJQgUHVyZSBmdW5jdGlvbnMgZm9yIHN1YmZsb3cgZGF0YSBjb250cmFjdHMuXG4gKlxuICogTWVudGFsIG1vZGVsOiBTdWJmbG93ID0gUHVyZSBGdW5jdGlvblxuICogLSBJc29sYXRlZCBzY29wZSAob3duIEdsb2JhbFN0b3JlKVxuICogLSBFeHBsaWNpdCBpbnB1dHMgdmlhIGlucHV0TWFwcGVyXG4gKiAtIEV4cGxpY2l0IG91dHB1dHMgdmlhIG91dHB1dE1hcHBlclxuICpcbiAqIHwgU2NlbmFyaW8gICAgICAgIHwgQmVoYXZpb3IgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfFxuICogfC0tLS0tLS0tLS0tLS0tLS0tfC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS18XG4gKiB8IE5vIGlucHV0TWFwcGVyICB8IFN1YmZsb3cgc3RhcnRzIHdpdGggZW1wdHkgc2NvcGUgICAgICAgICAgIHxcbiAqIHwgTm8gb3V0cHV0TWFwcGVyIHwgU3ViZmxvdyBzY29wZSBjaGFuZ2VzIGRpc2NhcmRlZCAgICAgICAgICAgfFxuICogfCBCb3RoIHByZXNlbnQgICAgfCBGdWxsIGRhdGEgY29udHJhY3QgKGFyZ3MgaW4sIHJlc3VsdHMgb3V0KSB8XG4gKiB8IE5laXRoZXIgcHJlc2VudCB8IENvbXBsZXRlIGlzb2xhdGlvbiAoc2lkZSBlZmZlY3RzIG9ubHkpICAgIHxcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFN0YWdlQ29udGV4dCB9IGZyb20gJy4uLy4uL21lbW9yeS9TdGFnZUNvbnRleHQuanMnO1xuaW1wb3J0IHR5cGUgeyBIYW5kbGVyRGVwcywgSUV4ZWN1dGlvblJ1bnRpbWUsIFN1YmZsb3dNb3VudE9wdGlvbnMgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5cbi8qKiBFeHRyYWN0IHZhbHVlcyBmcm9tIHBhcmVudCBzY29wZSB1c2luZyBpbnB1dE1hcHBlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0UGFyZW50U2NvcGVWYWx1ZXM8VFBhcmVudFNjb3BlLCBUU3ViZmxvd0lucHV0PihcbiAgcGFyZW50U2NvcGU6IFRQYXJlbnRTY29wZSxcbiAgb3B0aW9ucz86IFN1YmZsb3dNb3VudE9wdGlvbnM8VFBhcmVudFNjb3BlLCBUU3ViZmxvd0lucHV0Pixcbik6IFRTdWJmbG93SW5wdXQgfCBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIGlmICghb3B0aW9ucz8uaW5wdXRNYXBwZXIpIHtcbiAgICByZXR1cm4ge307XG4gIH1cblxuICBjb25zdCByZXN1bHQgPSBvcHRpb25zLmlucHV0TWFwcGVyKHBhcmVudFNjb3BlKTtcbiAgaWYgKHJlc3VsdCA9PT0gbnVsbCB8fCByZXN1bHQgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7fTtcbiAgfVxuXG4gIHJldHVybiByZXN1bHQ7XG59XG5cbi8qKlxuICogR2V0IHRoZSBpbml0aWFsIHNjb3BlIHZhbHVlcyBmb3IgYSBzdWJmbG93LlxuICogQWx3YXlzIGlzb2xhdGVkIOKAlCBvbmx5IGlucHV0TWFwcGVyIHZhbHVlcyBhcmUgaW5jbHVkZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRJbml0aWFsU2NvcGVWYWx1ZXM8VFBhcmVudFNjb3BlLCBUU3ViZmxvd0lucHV0PihcbiAgcGFyZW50U2NvcGU6IFRQYXJlbnRTY29wZSxcbiAgb3B0aW9ucz86IFN1YmZsb3dNb3VudE9wdGlvbnM8VFBhcmVudFNjb3BlLCBUU3ViZmxvd0lucHV0Pixcbik6IFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIGV4dHJhY3RQYXJlbnRTY29wZVZhbHVlcyhwYXJlbnRTY29wZSwgb3B0aW9ucykgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG59XG5cbi8qKlxuICogQ3JlYXRlIGEgbmV3IEhhbmRsZXJEZXBzIGZvciBzdWJmbG93IGV4ZWN1dGlvbi5cbiAqIEtleTogc2V0cyByZWFkT25seUNvbnRleHQgdG8gbWFwcGVkIGlucHV0IHNvIFN0YWdlUnVubmVyIHBhc3NlcyBpdCB0byBTY29wZUZhY3RvcnkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVTdWJmbG93SGFuZGxlckRlcHM8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PihcbiAgcGFyZW50RGVwczogSGFuZGxlckRlcHM8VE91dCwgVFNjb3BlPixcbiAgc3ViZmxvd1J1bnRpbWU6IElFeGVjdXRpb25SdW50aW1lLFxuICBtYXBwZWRJbnB1dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4pOiBIYW5kbGVyRGVwczxUT3V0LCBUU2NvcGU+IHtcbiAgcmV0dXJuIHtcbiAgICBzdGFnZU1hcDogcGFyZW50RGVwcy5zdGFnZU1hcCxcbiAgICByb290OiBwYXJlbnREZXBzLnJvb3QsXG4gICAgc2NvcGVGYWN0b3J5OiBwYXJlbnREZXBzLnNjb3BlRmFjdG9yeSxcbiAgICBzdWJmbG93czogcGFyZW50RGVwcy5zdWJmbG93cyxcbiAgICB0aHJvdHRsaW5nRXJyb3JDaGVja2VyOiBwYXJlbnREZXBzLnRocm90dGxpbmdFcnJvckNoZWNrZXIsXG4gICAgc3RyZWFtSGFuZGxlcnM6IHBhcmVudERlcHMuc3RyZWFtSGFuZGxlcnMsXG4gICAgc2NvcGVQcm90ZWN0aW9uTW9kZTogcGFyZW50RGVwcy5zY29wZVByb3RlY3Rpb25Nb2RlLFxuICAgIGV4ZWN1dGlvblJ1bnRpbWU6IHN1YmZsb3dSdW50aW1lLFxuICAgIHJlYWRPbmx5Q29udGV4dDogbWFwcGVkSW5wdXQsXG4gICAgZXhlY3V0aW9uRW52OiBwYXJlbnREZXBzLmV4ZWN1dGlvbkVudiwgLy8gaW5oZXJpdGVkIOKAlCBsaWtlIHByb2Nlc3MuZW52XG4gICAgbmFycmF0aXZlR2VuZXJhdG9yOiBwYXJlbnREZXBzLm5hcnJhdGl2ZUdlbmVyYXRvcixcbiAgICBsb2dnZXI6IHBhcmVudERlcHMubG9nZ2VyLFxuICB9O1xufVxuXG4vKipcbiAqIFNlZWQgdGhlIHN1YmZsb3cncyBHbG9iYWxTdG9yZSB3aXRoIGluaXRpYWwgdmFsdWVzLlxuICogQ2FsbGVkIGJlZm9yZSBzdWJmbG93IGV4ZWN1dGlvbiB0byBtYWtlIGlucHV0TWFwcGVyIHZhbHVlcyBhdmFpbGFibGUuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZWVkU3ViZmxvd0dsb2JhbFN0b3JlKFxuICBzdWJmbG93UnVudGltZTogSUV4ZWN1dGlvblJ1bnRpbWUsXG4gIGluaXRpYWxWYWx1ZXM6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuKTogdm9pZCB7XG4gIGNvbnN0IHJvb3RDb250ZXh0ID0gc3ViZmxvd1J1bnRpbWUucm9vdFN0YWdlQ29udGV4dDtcblxuICBmb3IgKGNvbnN0IFtrZXksIHZhbHVlXSBvZiBPYmplY3QuZW50cmllcyhpbml0aWFsVmFsdWVzKSkge1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdvYmplY3QnICYmIHZhbHVlICE9PSBudWxsICYmICFBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgZm9yIChjb25zdCBbbmVzdGVkS2V5LCBuZXN0ZWRWYWx1ZV0gb2YgT2JqZWN0LmVudHJpZXModmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pKSB7XG4gICAgICAgIHJvb3RDb250ZXh0LnNldE9iamVjdChba2V5XSwgbmVzdGVkS2V5LCBuZXN0ZWRWYWx1ZSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHJvb3RDb250ZXh0LnNldEdsb2JhbChrZXksIHZhbHVlKTtcbiAgICB9XG4gIH1cblxuICByb290Q29udGV4dC5jb21taXQoKTtcbn1cblxuLyoqXG4gKiBBcHBseSBvdXRwdXQgbWFwcGluZyBhZnRlciBzdWJmbG93IGNvbXBsZXRpb24uXG4gKiBXcml0ZXMgbWFwcGVkIHZhbHVlcyBiYWNrIHRvIHBhcmVudCBzY29wZSB1c2luZyBtZXJnZSBzZW1hbnRpY3M6XG4gKiBhcnJheXMgYXJlIGFwcGVuZGVkLCBvYmplY3RzIGFyZSBzaGFsbG93LW1lcmdlZCwgc2NhbGFycyBhcmUgcmVwbGFjZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhcHBseU91dHB1dE1hcHBpbmc8VFBhcmVudFNjb3BlLCBUU3ViZmxvd091dHB1dD4oXG4gIHN1YmZsb3dPdXRwdXQ6IFRTdWJmbG93T3V0cHV0LFxuICBwYXJlbnRTY29wZTogVFBhcmVudFNjb3BlLFxuICBwYXJlbnRDb250ZXh0OiBTdGFnZUNvbnRleHQsXG4gIG9wdGlvbnM/OiBTdWJmbG93TW91bnRPcHRpb25zPFRQYXJlbnRTY29wZSwgYW55LCBUU3ViZmxvd091dHB1dD4sXG4pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZCB7XG4gIGlmICghb3B0aW9ucz8ub3V0cHV0TWFwcGVyKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIGNvbnN0IG1hcHBlZE91dHB1dCA9IG9wdGlvbnMub3V0cHV0TWFwcGVyKHN1YmZsb3dPdXRwdXQsIHBhcmVudFNjb3BlKTtcblxuICBpZiAobWFwcGVkT3V0cHV0ID09PSBudWxsIHx8IG1hcHBlZE91dHB1dCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuXG4gIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKG1hcHBlZE91dHB1dCkpIHtcbiAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnb2JqZWN0JyAmJiB2YWx1ZSAhPT0gbnVsbCAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgIGZvciAoY29uc3QgW25lc3RlZEtleSwgbmVzdGVkVmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKHZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KSkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShuZXN0ZWRWYWx1ZSkpIHtcbiAgICAgICAgICBwYXJlbnRDb250ZXh0LmFwcGVuZFRvQXJyYXkoW2tleV0sIG5lc3RlZEtleSwgbmVzdGVkVmFsdWUpO1xuICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBuZXN0ZWRWYWx1ZSA9PT0gJ29iamVjdCcgJiYgbmVzdGVkVmFsdWUgIT09IG51bGwpIHtcbiAgICAgICAgICBwYXJlbnRDb250ZXh0Lm1lcmdlT2JqZWN0KFtrZXldLCBuZXN0ZWRLZXksIG5lc3RlZFZhbHVlIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBwYXJlbnRDb250ZXh0LnNldE9iamVjdChba2V5XSwgbmVzdGVkS2V5LCBuZXN0ZWRWYWx1ZSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9IGVsc2UgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICBpZiAob3B0aW9ucz8uYXJyYXlNZXJnZSA9PT0gJ3JlcGxhY2UnKSB7XG4gICAgICAgIHBhcmVudENvbnRleHQuc2V0R2xvYmFsKGtleSwgdmFsdWUpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc3QgZXhpc3RpbmcgPSBwYXJlbnRDb250ZXh0LmdldEdsb2JhbChrZXkpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShleGlzdGluZykpIHtcbiAgICAgICAgICBwYXJlbnRDb250ZXh0LnNldEdsb2JhbChrZXksIFsuLi5leGlzdGluZywgLi4udmFsdWVdKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBwYXJlbnRDb250ZXh0LnNldEdsb2JhbChrZXksIHZhbHVlKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICBwYXJlbnRDb250ZXh0LnNldEdsb2JhbChrZXksIHZhbHVlKTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gbWFwcGVkT3V0cHV0O1xufVxuIl19