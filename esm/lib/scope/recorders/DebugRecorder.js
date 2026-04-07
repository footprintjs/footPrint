/**
 * DebugRecorder — Development-focused recorder for detailed debugging
 *
 * Captures errors (always), mutations and reads (in verbose mode),
 * and stage lifecycle events for troubleshooting.
 */
/**
 * Each instance gets a unique auto-increment ID (`debug-1`, `debug-2`, ...),
 * so multiple recorders with different verbosity coexist.
 *
 * @example
 * ```typescript
 * // Verbose debug for development
 * executor.attachRecorder(new DebugRecorder({ verbosity: 'verbose' }));
 *
 * // Minimal debug for production (errors only)
 * executor.attachRecorder(new DebugRecorder({ verbosity: 'minimal' }));
 *
 * // Both coexist — different auto IDs
 * ```
 */
export class DebugRecorder {
    constructor(options) {
        var _a, _b;
        this.entries = [];
        this.id = (_a = options === null || options === void 0 ? void 0 : options.id) !== null && _a !== void 0 ? _a : `debug-${++DebugRecorder._counter}`;
        this.verbosity = (_b = options === null || options === void 0 ? void 0 : options.verbosity) !== null && _b !== void 0 ? _b : 'verbose';
    }
    onRead(event) {
        if (this.verbosity !== 'verbose')
            return;
        this.entries.push({
            type: 'read',
            stageName: event.stageName,
            timestamp: event.timestamp,
            data: { key: event.key, value: event.value, pipelineId: event.pipelineId },
        });
    }
    onWrite(event) {
        if (this.verbosity !== 'verbose')
            return;
        this.entries.push({
            type: 'write',
            stageName: event.stageName,
            timestamp: event.timestamp,
            data: { key: event.key, value: event.value, operation: event.operation, pipelineId: event.pipelineId },
        });
    }
    onError(event) {
        this.entries.push({
            type: 'error',
            stageName: event.stageName,
            timestamp: event.timestamp,
            data: { error: event.error, operation: event.operation, key: event.key, pipelineId: event.pipelineId },
        });
    }
    onStageStart(event) {
        if (this.verbosity !== 'verbose')
            return;
        this.entries.push({
            type: 'stageStart',
            stageName: event.stageName,
            timestamp: event.timestamp,
            data: { pipelineId: event.pipelineId },
        });
    }
    onStageEnd(event) {
        if (this.verbosity !== 'verbose')
            return;
        this.entries.push({
            type: 'stageEnd',
            stageName: event.stageName,
            timestamp: event.timestamp,
            data: { pipelineId: event.pipelineId, duration: event.duration },
        });
    }
    onPause(event) {
        // Always log pauses (even in minimal mode — pauses are significant events)
        this.entries.push({
            type: 'pause',
            stageName: event.stageName,
            timestamp: event.timestamp,
            data: { stageId: event.stageId, pauseData: event.pauseData, pipelineId: event.pipelineId },
        });
    }
    onResume(event) {
        // Always log resumes (even in minimal mode)
        this.entries.push({
            type: 'resume',
            stageName: event.stageName,
            timestamp: event.timestamp,
            data: { stageId: event.stageId, hasInput: event.hasInput, pipelineId: event.pipelineId },
        });
    }
    getEntries() {
        return [...this.entries];
    }
    getErrors() {
        return this.entries.filter((e) => e.type === 'error');
    }
    getEntriesForStage(stageName) {
        return this.entries.filter((e) => e.stageName === stageName);
    }
    setVerbosity(level) {
        this.verbosity = level;
    }
    getVerbosity() {
        return this.verbosity;
    }
    clear() {
        this.entries = [];
    }
}
DebugRecorder._counter = 0;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRGVidWdSZWNvcmRlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3NyYy9saWIvc2NvcGUvcmVjb3JkZXJzL0RlYnVnUmVjb3JkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7O0dBS0c7QUFrQkg7Ozs7Ozs7Ozs7Ozs7O0dBY0c7QUFDSCxNQUFNLE9BQU8sYUFBYTtJQU94QixZQUFZLE9BQThCOztRQUhsQyxZQUFPLEdBQWlCLEVBQUUsQ0FBQztRQUlqQyxJQUFJLENBQUMsRUFBRSxHQUFHLE1BQUEsT0FBTyxhQUFQLE9BQU8sdUJBQVAsT0FBTyxDQUFFLEVBQUUsbUNBQUksU0FBUyxFQUFFLGFBQWEsQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUM3RCxJQUFJLENBQUMsU0FBUyxHQUFHLE1BQUEsT0FBTyxhQUFQLE9BQU8sdUJBQVAsT0FBTyxDQUFFLFNBQVMsbUNBQUksU0FBUyxDQUFDO0lBQ25ELENBQUM7SUFFRCxNQUFNLENBQUMsS0FBZ0I7UUFDckIsSUFBSSxJQUFJLENBQUMsU0FBUyxLQUFLLFNBQVM7WUFBRSxPQUFPO1FBQ3pDLElBQUksQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDO1lBQ2hCLElBQUksRUFBRSxNQUFNO1lBQ1osU0FBUyxFQUFFLEtBQUssQ0FBQyxTQUFTO1lBQzFCLFNBQVMsRUFBRSxLQUFLLENBQUMsU0FBUztZQUMxQixJQUFJLEVBQUUsRUFBRSxHQUFHLEVBQUUsS0FBSyxDQUFDLEdBQUcsRUFBRSxLQUFLLEVBQUUsS0FBSyxDQUFDLEtBQUssRUFBRSxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVUsRUFBRTtTQUMzRSxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQsT0FBTyxDQUFDLEtBQWlCO1FBQ3ZCLElBQUksSUFBSSxDQUFDLFNBQVMsS0FBSyxTQUFTO1lBQUUsT0FBTztRQUN6QyxJQUFJLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQztZQUNoQixJQUFJLEVBQUUsT0FBTztZ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QUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLE9BQU8sQ0FBQyxDQUFDO0lBQ3hELENBQUM7SUFFRCxrQkFBa0IsQ0FBQyxTQUFpQjtRQUNsQyxPQUFPLElBQUksQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLEVBQUUsQ0FBQyxDQUFDLENBQUMsU0FBUyxLQUFLLFNBQVMsQ0FBQyxDQUFDO0lBQy9ELENBQUM7SUFFRCxZQUFZLENBQUMsS0FBcUI7UUFDaEMsSUFBSSxDQUFDLFNBQVMsR0FBRyxLQUFLLENBQUM7SUFDekIsQ0FBQztJQUVELFlBQVk7UUFDVixPQUFPLElBQUksQ0FBQyxTQUFTLENBQUM7SUFDeEIsQ0FBQztJQUVELEtBQUs7UUFDSCxJQUFJLENBQUMsT0FBTyxHQUFHLEVBQUUsQ0FBQztJQUNwQixDQUFDOztBQXRHYyxzQkFBUSxHQUFHLENBQUMsQUFBSixDQUFLIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBEZWJ1Z1JlY29yZGVyIOKAlCBEZXZlbG9wbWVudC1mb2N1c2VkIHJlY29yZGVyIGZvciBkZXRhaWxlZCBkZWJ1Z2dpbmdcbiAqXG4gKiBDYXB0dXJlcyBlcnJvcnMgKGFsd2F5cyksIG11dGF0aW9ucyBhbmQgcmVhZHMgKGluIHZlcmJvc2UgbW9kZSksXG4gKiBhbmQgc3RhZ2UgbGlmZWN5Y2xlIGV2ZW50cyBmb3IgdHJvdWJsZXNob290aW5nLlxuICovXG5cbmltcG9ydCB0eXBlIHsgRXJyb3JFdmVudCwgUGF1c2VFdmVudCwgUmVhZEV2ZW50LCBSZWNvcmRlciwgUmVzdW1lRXZlbnQsIFN0YWdlRXZlbnQsIFdyaXRlRXZlbnQgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5cbmV4cG9ydCB0eXBlIERlYnVnVmVyYm9zaXR5ID0gJ21pbmltYWwnIHwgJ3ZlcmJvc2UnO1xuXG5leHBvcnQgaW50ZXJmYWNlIERlYnVnRW50cnkge1xuICB0eXBlOiAncmVhZCcgfCAnd3JpdGUnIHwgJ2Vycm9yJyB8ICdzdGFnZVN0YXJ0JyB8ICdzdGFnZUVuZCcgfCAncGF1c2UnIHwgJ3Jlc3VtZSc7XG4gIHN0YWdlTmFtZTogc3RyaW5nO1xuICB0aW1lc3RhbXA6IG51bWJlcjtcbiAgZGF0YTogdW5rbm93bjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBEZWJ1Z1JlY29yZGVyT3B0aW9ucyB7XG4gIGlkPzogc3RyaW5nO1xuICB2ZXJib3NpdHk/OiBEZWJ1Z1ZlcmJvc2l0eTtcbn1cblxuLyoqXG4gKiBFYWNoIGluc3RhbmNlIGdldHMgYSB1bmlxdWUgYXV0by1pbmNyZW1lbnQgSUQgKGBkZWJ1Zy0xYCwgYGRlYnVnLTJgLCAuLi4pLFxuICogc28gbXVsdGlwbGUgcmVjb3JkZXJzIHdpdGggZGlmZmVyZW50IHZlcmJvc2l0eSBjb2V4aXN0LlxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiAvLyBWZXJib3NlIGRlYnVnIGZvciBkZXZlbG9wbWVudFxuICogZXhlY3V0b3IuYXR0YWNoUmVjb3JkZXIobmV3IERlYnVnUmVjb3JkZXIoeyB2ZXJib3NpdHk6ICd2ZXJib3NlJyB9KSk7XG4gKlxuICogLy8gTWluaW1hbCBkZWJ1ZyBmb3IgcHJvZHVjdGlvbiAoZXJyb3JzIG9ubHkpXG4gKiBleGVjdXRvci5hdHRhY2hSZWNvcmRlcihuZXcgRGVidWdSZWNvcmRlcih7IHZlcmJvc2l0eTogJ21pbmltYWwnIH0pKTtcbiAqXG4gKiAvLyBCb3RoIGNvZXhpc3Qg4oCUIGRpZmZlcmVudCBhdXRvIElEc1xuICogYGBgXG4gKi9cbmV4cG9ydCBjbGFzcyBEZWJ1Z1JlY29yZGVyIGltcGxlbWVudHMgUmVjb3JkZXIge1xuICBwcml2YXRlIHN0YXRpYyBfY291bnRlciA9IDA7XG5cbiAgcmVhZG9ubHkgaWQ6IHN0cmluZztcbiAgcHJpdmF0ZSBlbnRyaWVzOiBEZWJ1Z0VudHJ5W10gPSBbXTtcbiAgcHJpdmF0ZSB2ZXJib3NpdHk6IERlYnVnVmVyYm9zaXR5O1xuXG4gIGNvbnN0cnVjdG9yKG9wdGlvbnM/OiBEZWJ1Z1JlY29yZGVyT3B0aW9ucykge1xuICAgIHRoaXMuaWQgPSBvcHRpb25zPy5pZCA/PyBgZGVidWctJHsrK0RlYnVnUmVjb3JkZXIuX2NvdW50ZXJ9YDtcbiAgICB0aGlzLnZlcmJvc2l0eSA9IG9wdGlvbnM/LnZlcmJvc2l0eSA/PyAndmVyYm9zZSc7XG4gIH1cblxuICBvblJlYWQoZXZlbnQ6IFJlYWRFdmVudCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnZlcmJvc2l0eSAhPT0gJ3ZlcmJvc2UnKSByZXR1cm47XG4gICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgdHlwZTogJ3JlYWQnLFxuICAgICAgc3RhZ2VOYW1lOiBldmVudC5zdGFnZU5hbWUsXG4gICAgICB0aW1lc3RhbXA6IGV2ZW50LnRpbWVzdGFtcCxcbiAgICAgIGRhdGE6IHsga2V5OiBldmVudC5rZXksIHZhbHVlOiBldmVudC52YWx1ZSwgcGlwZWxpbmVJZDogZXZlbnQucGlwZWxpbmVJZCB9LFxuICAgIH0pO1xuICB9XG5cbiAgb25Xcml0ZShldmVudDogV3JpdGVFdmVudCk6IHZvaWQge1xuICAgIGlmICh0aGlzLnZlcmJvc2l0eSAhPT0gJ3ZlcmJvc2UnKSByZXR1cm47XG4gICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgdHlwZTogJ3dyaXRlJyxcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuc3RhZ2VOYW1lLFxuICAgICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgICBkYXRhOiB7IGtleTogZXZlbnQua2V5LCB2YWx1ZTogZXZlbnQudmFsdWUsIG9wZXJhdGlvbjogZXZlbnQub3BlcmF0aW9uLCBwaXBlbGluZUlkOiBldmVudC5waXBlbGluZUlkIH0sXG4gICAgfSk7XG4gIH1cblxuICBvbkVycm9yKGV2ZW50OiBFcnJvckV2ZW50KTogdm9pZCB7XG4gICAgdGhpcy5lbnRyaWVzLnB1c2goe1xuICAgICAgdHlwZTogJ2Vycm9yJyxcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuc3RhZ2VOYW1lLFxuICAgICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgICBkYXRhOiB7IGVycm9yOiBldmVudC5lcnJvciwgb3BlcmF0aW9uOiBldmVudC5vcGVyYXRpb24sIGtleTogZXZlbnQua2V5LCBwaXBlbGluZUlkOiBldmVudC5waXBlbGluZUlkIH0sXG4gICAgfSk7XG4gIH1cblxuICBvblN0YWdlU3RhcnQoZXZlbnQ6IFN0YWdlRXZlbnQpOiB2b2lkIHtcbiAgICBpZiAodGhpcy52ZXJib3NpdHkgIT09ICd2ZXJib3NlJykgcmV0dXJuO1xuICAgIHRoaXMuZW50cmllcy5wdXNoKHtcbiAgICAgIHR5cGU6ICdzdGFnZVN0YXJ0JyxcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuc3RhZ2VOYW1lLFxuICAgICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgICBkYXRhOiB7IHBpcGVsaW5lSWQ6IGV2ZW50LnBpcGVsaW5lSWQgfSxcbiAgICB9KTtcbiAgfVxuXG4gIG9uU3RhZ2VFbmQoZXZlbnQ6IFN0YWdlRXZlbnQpOiB2b2lkIHtcbiAgICBpZiAodGhpcy52ZXJib3NpdHkgIT09ICd2ZXJib3NlJykgcmV0dXJuO1xuICAgIHRoaXMuZW50cmllcy5wdXNoKHtcbiAgICAgIHR5cGU6ICdzdGFnZUVuZCcsXG4gICAgICBzdGFnZU5hbWU6IGV2ZW50LnN0YWdlTmFtZSxcbiAgICAgIHRpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wLFxuICAgICAgZGF0YTogeyBwaXBlbGluZUlkOiBldmVudC5waXBlbGluZUlkLCBkdXJhdGlvbjogZXZlbnQuZHVyYXRpb24gfSxcbiAgICB9KTtcbiAgfVxuXG4gIG9uUGF1c2UoZXZlbnQ6IFBhdXNlRXZlbnQpOiB2b2lkIHtcbiAgICAvLyBBbHdheXMgbG9nIHBhdXNlcyAoZXZlbiBpbiBtaW5pbWFsIG1vZGUg4oCUIHBhdXNlcyBhcmUgc2lnbmlmaWNhbnQgZXZlbnRzKVxuICAgIHRoaXMuZW50cmllcy5wdXNoKHtcbiAgICAgIHR5cGU6ICdwYXVzZScsXG4gICAgICBzdGFnZU5hbWU6IGV2ZW50LnN0YWdlTmFtZSxcbiAgICAgIHRpbWVzdGFtcDogZXZlbnQudGltZXN0YW1wLFxuICAgICAgZGF0YTogeyBzdGFnZUlkOiBldmVudC5zdGFnZUlkLCBwYXVzZURhdGE6IGV2ZW50LnBhdXNlRGF0YSwgcGlwZWxpbmVJZDogZXZlbnQucGlwZWxpbmVJZCB9LFxuICAgIH0pO1xuICB9XG5cbiAgb25SZXN1bWUoZXZlbnQ6IFJlc3VtZUV2ZW50KTogdm9pZCB7XG4gICAgLy8gQWx3YXlzIGxvZyByZXN1bWVzIChldmVuIGluIG1pbmltYWwgbW9kZSlcbiAgICB0aGlzLmVudHJpZXMucHVzaCh7XG4gICAgICB0eXBlOiAncmVzdW1lJyxcbiAgICAgIHN0YWdlTmFtZTogZXZlbnQuc3RhZ2VOYW1lLFxuICAgICAgdGltZXN0YW1wOiBldmVudC50aW1lc3RhbXAsXG4gICAgICBkYXRhOiB7IHN0YWdlSWQ6IGV2ZW50LnN0YWdlSWQsIGhhc0lucHV0OiBldmVudC5oYXNJbnB1dCwgcGlwZWxpbmVJZDogZXZlbnQucGlwZWxpbmVJZCB9LFxuICAgIH0pO1xuICB9XG5cbiAgZ2V0RW50cmllcygpOiBEZWJ1Z0VudHJ5W10ge1xuICAgIHJldHVybiBbLi4udGhpcy5lbnRyaWVzXTtcbiAgfVxuXG4gIGdldEVycm9ycygpOiBEZWJ1Z0VudHJ5W10ge1xuICAgIHJldHVybiB0aGlzLmVudHJpZXMuZmlsdGVyKChlKSA9PiBlLnR5cGUgPT09ICdlcnJvcicpO1xuICB9XG5cbiAgZ2V0RW50cmllc0ZvclN0YWdlKHN0YWdlTmFtZTogc3RyaW5nKTogRGVidWdFbnRyeVtdIHtcbiAgICByZXR1cm4gdGhpcy5lbnRyaWVzLmZpbHRlcigoZSkgPT4gZS5zdGFnZU5hbWUgPT09IHN0YWdlTmFtZSk7XG4gIH1cblxuICBzZXRWZXJib3NpdHkobGV2ZWw6IERlYnVnVmVyYm9zaXR5KTogdm9pZCB7XG4gICAgdGhpcy52ZXJib3NpdHkgPSBsZXZlbDtcbiAgfVxuXG4gIGdldFZlcmJvc2l0eSgpOiBEZWJ1Z1ZlcmJvc2l0eSB7XG4gICAgcmV0dXJuIHRoaXMudmVyYm9zaXR5O1xuICB9XG5cbiAgY2xlYXIoKTogdm9pZCB7XG4gICAgdGhpcy5lbnRyaWVzID0gW107XG4gIH1cbn1cbiJdfQ==