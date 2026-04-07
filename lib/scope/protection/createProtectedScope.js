"use strict";
/**
 * Scope Protection — Proxy-based protection layer
 *
 * Intercepts direct property assignments on scope objects and provides
 * clear error messages guiding developers to use setValue() instead.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProtectedScope = exports.createErrorMessage = void 0;
function createErrorMessage(propertyName, stageName) {
    return `[Scope Access Error] Direct property assignment detected in stage "${stageName}".

Incorrect: scope.${propertyName} = value

Correct: scope.setValue('${propertyName}', value)

Why this matters:
Each stage receives a NEW scope instance from ScopeFactory. Direct property
assignments are lost when the next stage executes. Use setValue()
to persist data to the shared GlobalStore.`;
}
exports.createErrorMessage = createErrorMessage;
function createProtectedScope(scope, options = {}) {
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
exports.createProtectedScope = createProtectedScope;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY3JlYXRlUHJvdGVjdGVkU2NvcGUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3Njb3BlL3Byb3RlY3Rpb24vY3JlYXRlUHJvdGVjdGVkU2NvcGUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IjtBQUFBOzs7OztHQUtHOzs7QUFJSCxTQUFnQixrQkFBa0IsQ0FBQyxZQUFvQixFQUFFLFNBQWlCO0lBQ3hFLE9BQU8sc0VBQXNFLFNBQVM7O21CQUVyRSxZQUFZOzsyQkFFSixZQUFZOzs7OzsyQ0FLSSxDQUFDO0FBQzVDLENBQUM7QUFYRCxnREFXQztBQUVELFNBQWdCLG9CQUFvQixDQUFtQixLQUFRLEVBQUUsVUFBa0MsRUFBRTtJQUNuRyxNQUFNLEVBQ0osSUFBSSxHQUFHLE9BQU8sRUFDZCxTQUFTLEdBQUcsU0FBUyxFQUNyQixNQUFNLEdBQUcsT0FBTyxDQUFDLElBQUksRUFDckIseUJBQXlCLEdBQUc7UUFDMUIsYUFBYTtRQUNiLE1BQU07UUFDTixVQUFVO1FBQ1YsUUFBUTtRQUNSLGtCQUFrQjtRQUNsQixVQUFVO1FBQ1YsV0FBVztRQUNYLFFBQVE7UUFDUixPQUFPO1FBQ1AsV0FBVztRQUNYLFlBQVk7UUFDWixhQUFhO0tBQ2QsR0FDRixHQUFHLE9BQU8sQ0FBQztJQUVaLElBQUksSUFBSSxLQUFLLEtBQUssRUFBRSxDQUFDO1FBQ25CLE9BQU8sS0FBSyxDQUFDO0lBQ2YsQ0FBQztJQUVELE1BQU0sZ0JBQWdCLEdBQUcsSUFBSSxHQUFHLENBQWtCLHlCQUF5QixDQUFDLENBQUM7SUFFN0UsT0FBTyxJQUFJLEtBQUssQ0FBQyxLQUFLLEVBQUU7UUFDdEIsR0FBRyxDQUFDLE1BQU0sRUFBRSxJQUFJLEVBQUUsUUFBUTtZQUN4QixPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLElBQUksRUFBRSxRQUFRLENBQUMsQ0FBQztRQUM3QyxDQUFDO1FBRUQsR0FBRyxDQUFDLE1BQU0sRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLFFBQVE7WUFDL0IsSUFBSSxnQkFBZ0IsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztnQkFDL0IsT0FBTyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLFFBQVEsQ0FBQyxDQUFDO1lBQ3BELENBQUM7WUFFRCxNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLENBQUM7WUFDOUIsTUFBTSxPQUFPLEdBQUcsa0JBQWtCLENBQUMsUUFBUSxFQUFFLFNBQVMsQ0FBQyxDQUFDO1lBRXhELElBQUksSUFBSSxLQUFLLE9BQU8sRUFBRSxDQUFDO2dCQUNyQixNQUFNLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDO1lBQzNCLENBQUM7aUJBQU0sSUFBSSxJQUFJLEtBQUssTUFBTSxFQUFFLENBQUM7Z0JBQzNCLE1BQU0sQ0FBQyxPQUFPLENBQUMsQ0FBQztnQkFDaEIsT0FBTyxPQUFPLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxJQUFJLEVBQUUsS0FBSyxFQUFFLFFBQVEsQ0FBQyxDQUFDO1lBQ3BELENBQUM7WUFFRCxPQUFPLE9BQU8sQ0FBQyxHQUFHLENBQUMsTUFBTSxFQUFFLElBQUksRUFBRSxLQUFLLEVBQUUsUUFBUSxDQUFDLENBQUM7UUFDcEQsQ0FBQztLQUNGLENBQUMsQ0FBQztBQUNMLENBQUM7QUFsREQsb0RBa0RDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTY29wZSBQcm90ZWN0aW9uIOKAlCBQcm94eS1iYXNlZCBwcm90ZWN0aW9uIGxheWVyXG4gKlxuICogSW50ZXJjZXB0cyBkaXJlY3QgcHJvcGVydHkgYXNzaWdubWVudHMgb24gc2NvcGUgb2JqZWN0cyBhbmQgcHJvdmlkZXNcbiAqIGNsZWFyIGVycm9yIG1lc3NhZ2VzIGd1aWRpbmcgZGV2ZWxvcGVycyB0byB1c2Ugc2V0VmFsdWUoKSBpbnN0ZWFkLlxuICovXG5cbmltcG9ydCB0eXBlIHsgU2NvcGVQcm90ZWN0aW9uT3B0aW9ucyB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlRXJyb3JNZXNzYWdlKHByb3BlcnR5TmFtZTogc3RyaW5nLCBzdGFnZU5hbWU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBgW1Njb3BlIEFjY2VzcyBFcnJvcl0gRGlyZWN0IHByb3BlcnR5IGFzc2lnbm1lbnQgZGV0ZWN0ZWQgaW4gc3RhZ2UgXCIke3N0YWdlTmFtZX1cIi5cblxuSW5jb3JyZWN0OiBzY29wZS4ke3Byb3BlcnR5TmFtZX0gPSB2YWx1ZVxuXG5Db3JyZWN0OiBzY29wZS5zZXRWYWx1ZSgnJHtwcm9wZXJ0eU5hbWV9JywgdmFsdWUpXG5cbldoeSB0aGlzIG1hdHRlcnM6XG5FYWNoIHN0YWdlIHJlY2VpdmVzIGEgTkVXIHNjb3BlIGluc3RhbmNlIGZyb20gU2NvcGVGYWN0b3J5LiBEaXJlY3QgcHJvcGVydHlcbmFzc2lnbm1lbnRzIGFyZSBsb3N0IHdoZW4gdGhlIG5leHQgc3RhZ2UgZXhlY3V0ZXMuIFVzZSBzZXRWYWx1ZSgpXG50byBwZXJzaXN0IGRhdGEgdG8gdGhlIHNoYXJlZCBHbG9iYWxTdG9yZS5gO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gY3JlYXRlUHJvdGVjdGVkU2NvcGU8VCBleHRlbmRzIG9iamVjdD4oc2NvcGU6IFQsIG9wdGlvbnM6IFNjb3BlUHJvdGVjdGlvbk9wdGlvbnMgPSB7fSk6IFQge1xuICBjb25zdCB7XG4gICAgbW9kZSA9ICdlcnJvcicsXG4gICAgc3RhZ2VOYW1lID0gJ3Vua25vd24nLFxuICAgIGxvZ2dlciA9IGNvbnNvbGUud2FybixcbiAgICBhbGxvd2VkSW50ZXJuYWxQcm9wZXJ0aWVzID0gW1xuICAgICAgJ3dyaXRlQnVmZmVyJyxcbiAgICAgICduZXh0JyxcbiAgICAgICdjaGlsZHJlbicsXG4gICAgICAncGFyZW50JyxcbiAgICAgICdleGVjdXRpb25IaXN0b3J5JyxcbiAgICAgICdicmFuY2hJZCcsXG4gICAgICAnaXNEZWNpZGVyJyxcbiAgICAgICdpc0ZvcmsnLFxuICAgICAgJ2RlYnVnJyxcbiAgICAgICdzdGFnZU5hbWUnLFxuICAgICAgJ3BpcGVsaW5lSWQnLFxuICAgICAgJ2dsb2JhbFN0b3JlJyxcbiAgICBdLFxuICB9ID0gb3B0aW9ucztcblxuICBpZiAobW9kZSA9PT0gJ29mZicpIHtcbiAgICByZXR1cm4gc2NvcGU7XG4gIH1cblxuICBjb25zdCBhbGxvd2VkSW50ZXJuYWxzID0gbmV3IFNldDxzdHJpbmcgfCBzeW1ib2w+KGFsbG93ZWRJbnRlcm5hbFByb3BlcnRpZXMpO1xuXG4gIHJldHVybiBuZXcgUHJveHkoc2NvcGUsIHtcbiAgICBnZXQodGFyZ2V0LCBwcm9wLCByZWNlaXZlcikge1xuICAgICAgcmV0dXJuIFJlZmxlY3QuZ2V0KHRhcmdldCwgcHJvcCwgcmVjZWl2ZXIpO1xuICAgIH0sXG5cbiAgICBzZXQodGFyZ2V0LCBwcm9wLCB2YWx1ZSwgcmVjZWl2ZXIpIHtcbiAgICAgIGlmIChhbGxvd2VkSW50ZXJuYWxzLmhhcyhwcm9wKSkge1xuICAgICAgICByZXR1cm4gUmVmbGVjdC5zZXQodGFyZ2V0LCBwcm9wLCB2YWx1ZSwgcmVjZWl2ZXIpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBwcm9wTmFtZSA9IFN0cmluZyhwcm9wKTtcbiAgICAgIGNvbnN0IG1lc3NhZ2UgPSBjcmVhdGVFcnJvck1lc3NhZ2UocHJvcE5hbWUsIHN0YWdlTmFtZSk7XG5cbiAgICAgIGlmIChtb2RlID09PSAnZXJyb3InKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbiAgICAgIH0gZWxzZSBpZiAobW9kZSA9PT0gJ3dhcm4nKSB7XG4gICAgICAgIGxvZ2dlcihtZXNzYWdlKTtcbiAgICAgICAgcmV0dXJuIFJlZmxlY3Quc2V0KHRhcmdldCwgcHJvcCwgdmFsdWUsIHJlY2VpdmVyKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIFJlZmxlY3Quc2V0KHRhcmdldCwgcHJvcCwgdmFsdWUsIHJlY2VpdmVyKTtcbiAgICB9LFxuICB9KTtcbn1cbiJdfQ==