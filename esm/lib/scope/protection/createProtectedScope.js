/**
 * Scope Protection — Proxy-based protection layer
 *
 * Intercepts direct property assignments on scope objects and provides
 * clear error messages guiding developers to use setValue() instead.
 */
export function createErrorMessage(propertyName, stageName) {
    return `[Scope Access Error] Direct property assignment detected in stage "${stageName}".

Incorrect: scope.${propertyName} = value

Correct: scope.setValue('${propertyName}', value)

Why this matters:
Each stage receives a NEW scope instance from ScopeFactory. Direct property
assignments are lost when the next stage executes. Use setValue()
to persist data to the shared GlobalStore.`;
}
export function createProtectedScope(scope, options = {}) {
    const { mode = 'error', stageName = 'unknown', logger = console.warn, allowedInternalProperties = [
        'writeBuffer',
        'next',
        'children',
        'parent',
        'executionHistory',
        'branchId',
        'isDecider',
        'isFork',
        'debug',
        'stageName',
        'pipelineId',
        'globalStore',
    ], } = options;
    if (mode === 'off') {
        return scope;
    }
    const allowedInternals = new Set(allowedInternalProperties);
    return new Proxy(scope, {
        get(target, prop, receiver) {
            return Reflect.get(target, prop, receiver);
        },
        set(target, prop, value, receiver) {
            if (allowedInternals.has(prop)) {
                return Reflect.set(target, prop, value, receiver);
            }
            const propName = String(prop);
            const message = createErrorMessage(propName, stageName);
            if (mode === 'error') {
                throw new Error(message);
            }
            else if (mode === 'warn') {
                logger(message);
                return Reflect.set(target, prop, value, receiver);
            }
            return Reflect.set(target, prop, value, receiver);
        },
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3JlYXRlUHJvdGVjdGVkU2NvcGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL3Njb3BlL3Byb3RlY3Rpb24vY3JlYXRlUHJvdGVjdGVkU2NvcGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7O0dBS0c7QUFJSCxNQUFNLFVBQVUsa0JBQWtCLENBQUMsWUFBb0IsRUFBRSxTQUFpQjtJQUN4RSxPQUFPLHNFQUFzRSxTQUFTOzttQkFFckUsWUFBWTs7MkJBRUosWUFBWTs7Ozs7MkNBS0ksQ0FBQztBQUM1QyxDQUFDO0FBRUQsTUFBTSxVQUFVLG9CQUFvQixDQUFtQixLQUFRLEVBQUUsVUFBa0MsRUFBRTtJQUNuRyxNQUFNLEVBQ0osSUFBSSxHQUFHLE9BQU8sRUFDZCxTQUFTLEdBQUcsU0FBUyxFQUNyQixNQUFNLEdBQUcsT0FBTyxDQUFDLElBQUksRUFDckIseUJBQXlCLEdBQUc7UUFDMUIsYUFBYTtRQUNiLE1BQU07UUFDTixVQUFVO1FBQ1YsUUFBUTtRQUNSLGtCQUFrQjtRQUNsQixVQUFVO1FBQ1YsV0FBVztRQUNYLFFBQVE7UUFDUixPQUFPO1FBQ1AsV0FBVztRQUNYLFlBQVk7UUFDWixhQUFhO0tBQ2QsR0FDRixHQUFHLE9BQU8sQ0FBQztJQUVaLElBQUksSUFBSSxLQUFLLEtBQUssRUFBRSxDQUFDO1FBQ25CLE9BQU8sS0FBSyxDQUFDO0lBQ2YsQ0FBQztJQUVELE1BQU0sZ0JBQWdCLEdBQUcsSUFBSSxHQUFHLENBQWtCLHlCQUF5QixDQUFDLENBQUM7SUFFN0UsT0FBTyxJQUFJLEtBQUssQ0FBQyxLQUFLLEVBQUU7UUFDdEIsR0FBRyxDQUFDLE1BQU0sRUFBRSxJQUFJLEVBQUUsUUFBUTtZQUN4QixPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsQ0FBQztRQUM3QyxDQUFDO1FBRUQsR0FBRyxDQUFDLE1BQU0sRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLFFBQVE7WUFDL0IsSUFBSSxnQkFBZ0IsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztnQkFDL0IsT0FBTyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLFFBQVEsQ0FBQyxDQUFDO1lBQ3BELENBQUM7WUFFRCxNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDOUIsTUFBTSxPQUFPLEdBQUcsa0JBQWtCLENBQUMsUUFBUSxFQUFFLFNBQVMsQ0FBQyxDQUFDO1lBRXhELElBQUksSUFBSSxLQUFLLE9BQU8sRUFBRSxDQUFDO2dCQUNyQixNQUFNLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQzNCLENBQUM7aUJBQU0sSUFBSSxJQUFJLEtBQUssTUFBTSxFQUFFLENBQUM7Z0JBQzNCLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztnQkFDaEIsT0FBTyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLFFBQVEsQ0FBQyxDQUFDO1lBQ3BELENBQUM7WUFFRCxPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsUUFBUSxDQUFDLENBQUM7UUFDcEQsQ0FBQztLQUNGLENBQUMsQ0FBQztBQUNMLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFNjb3BlIFByb3RlY3Rpb24g4oCUIFByb3h5LWJhc2VkIHByb3RlY3Rpb24gbGF5ZXJcbiAqXG4gKiBJbnRlcmNlcHRzIGRpcmVjdCBwcm9wZXJ0eSBhc3NpZ25tZW50cyBvbiBzY29wZSBvYmplY3RzIGFuZCBwcm92aWRlc1xuICogY2xlYXIgZXJyb3IgbWVzc2FnZXMgZ3VpZGluZyBkZXZlbG9wZXJzIHRvIHVzZSBzZXRWYWx1ZSgpIGluc3RlYWQuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTY29wZVByb3RlY3Rpb25PcHRpb25zIH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVFcnJvck1lc3NhZ2UocHJvcGVydHlOYW1lOiBzdHJpbmcsIHN0YWdlTmFtZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGBbU2NvcGUgQWNjZXNzIEVycm9yXSBEaXJlY3QgcHJvcGVydHkgYXNzaWdubWVudCBkZXRlY3RlZCBpbiBzdGFnZSBcIiR7c3RhZ2VOYW1lfVwiLlxuXG5JbmNvcnJlY3Q6IHNjb3BlLiR7cHJvcGVydHlOYW1lfSA9IHZhbHVlXG5cbkNvcnJlY3Q6IHNjb3BlLnNldFZhbHVlKCcke3Byb3BlcnR5TmFtZX0nLCB2YWx1ZSlcblxuV2h5IHRoaXMgbWF0dGVyczpcbkVhY2ggc3RhZ2UgcmVjZWl2ZXMgYSBORVcgc2NvcGUgaW5zdGFuY2UgZnJvbSBTY29wZUZhY3RvcnkuIERpcmVjdCBwcm9wZXJ0eVxuYXNzaWdubWVudHMgYXJlIGxvc3Qgd2hlbiB0aGUgbmV4dCBzdGFnZSBleGVjdXRlcy4gVXNlIHNldFZhbHVlKClcbnRvIHBlcnNpc3QgZGF0YSB0byB0aGUgc2hhcmVkIEdsb2JhbFN0b3JlLmA7XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBjcmVhdGVQcm90ZWN0ZWRTY29wZTxUIGV4dGVuZHMgb2JqZWN0PihzY29wZTogVCwgb3B0aW9uczogU2NvcGVQcm90ZWN0aW9uT3B0aW9ucyA9IHt9KTogVCB7XG4gIGNvbnN0IHtcbiAgICBtb2RlID0gJ2Vycm9yJyxcbiAgICBzdGFnZU5hbWUgPSAndW5rbm93bicsXG4gICAgbG9nZ2VyID0gY29uc29sZS53YXJuLFxuICAgIGFsbG93ZWRJbnRlcm5hbFByb3BlcnRpZXMgPSBbXG4gICAgICAnd3JpdGVCdWZmZXInLFxuICAgICAgJ25leHQnLFxuICAgICAgJ2NoaWxkcmVuJyxcbiAgICAgICdwYXJlbnQnLFxuICAgICAgJ2V4ZWN1dGlvbkhpc3RvcnknLFxuICAgICAgJ2JyYW5jaElkJyxcbiAgICAgICdpc0RlY2lkZXInLFxuICAgICAgJ2lzRm9yaycsXG4gICAgICAnZGVidWcnLFxuICAgICAgJ3N0YWdlTmFtZScsXG4gICAgICAncGlwZWxpbmVJZCcsXG4gICAgICAnZ2xvYmFsU3RvcmUnLFxuICAgIF0sXG4gIH0gPSBvcHRpb25zO1xuXG4gIGlmIChtb2RlID09PSAnb2ZmJykge1xuICAgIHJldHVybiBzY29wZTtcbiAgfVxuXG4gIGNvbnN0IGFsbG93ZWRJbnRlcm5hbHMgPSBuZXcgU2V0PHN0cmluZyB8IHN5bWJvbD4oYWxsb3dlZEludGVybmFsUHJvcGVydGllcyk7XG5cbiAgcmV0dXJuIG5ldyBQcm94eShzY29wZSwge1xuICAgIGdldCh0YXJnZXQsIHByb3AsIHJlY2VpdmVyKSB7XG4gICAgICByZXR1cm4gUmVmbGVjdC5nZXQodGFyZ2V0LCBwcm9wLCByZWNlaXZlcik7XG4gICAgfSxcblxuICAgIHNldCh0YXJnZXQsIHByb3AsIHZhbHVlLCByZWNlaXZlcikge1xuICAgICAgaWYgKGFsbG93ZWRJbnRlcm5hbHMuaGFzKHByb3ApKSB7XG4gICAgICAgIHJldHVybiBSZWZsZWN0LnNldCh0YXJnZXQsIHByb3AsIHZhbHVlLCByZWNlaXZlcik7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHByb3BOYW1lID0gU3RyaW5nKHByb3ApO1xuICAgICAgY29uc3QgbWVzc2FnZSA9IGNyZWF0ZUVycm9yTWVzc2FnZShwcm9wTmFtZSwgc3RhZ2VOYW1lKTtcblxuICAgICAgaWYgKG1vZGUgPT09ICdlcnJvcicpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgfSBlbHNlIGlmIChtb2RlID09PSAnd2FybicpIHtcbiAgICAgICAgbG9nZ2VyKG1lc3NhZ2UpO1xuICAgICAgICByZXR1cm4gUmVmbGVjdC5zZXQodGFyZ2V0LCBwcm9wLCB2YWx1ZSwgcmVjZWl2ZXIpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gUmVmbGVjdC5zZXQodGFyZ2V0LCBwcm9wLCB2YWx1ZSwgcmVjZWl2ZXIpO1xuICAgIH0sXG4gIH0pO1xufVxuIl19