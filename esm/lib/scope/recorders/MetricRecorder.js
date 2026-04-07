/**
 * MetricRecorder — Production-focused recorder for timing and execution counts.
 *
 * Tracks read/write/commit counts per stage and measures stage execution duration.
 *
 * Each instance gets a unique auto-increment ID (`metrics-1`, `metrics-2`, ...),
 * so multiple recorders with different configs coexist. Pass an explicit ID to
 * override a specific instance (e.g., a framework-attached recorder).
 *
 * @example
 * ```typescript
 * // Track all stages (default)
 * executor.attachRecorder(new MetricRecorder());
 *
 * // Track only LLM-related stages
 * executor.attachRecorder(new MetricRecorder({
 *   stageFilter: (name) => ['CallLLM', 'ParseResponse'].includes(name),
 * }));
 *
 * // Two recorders: one for LLM timing, one for everything else
 * executor.attachRecorder(new MetricRecorder({
 *   stageFilter: (name) => name === 'CallLLM',
 * }));
 * executor.attachRecorder(new MetricRecorder({
 *   stageFilter: (name) => name !== 'CallLLM',
 * }));
 *
 * // Override a framework-attached recorder by passing its well-known ID
 * executor.attachRecorder(new MetricRecorder({ id: 'metrics' }));
 * ```
 */
export class MetricRecorder {
    constructor(idOrOptions) {
        var _a;
        this.metrics = new Map();
        this.stageStartTimes = new Map();
        if (typeof idOrOptions === 'string') {
            this.id = idOrOptions;
        }
        else {
            this.id = (_a = idOrOptions === null || idOrOptions === void 0 ? void 0 : idOrOptions.id) !== null && _a !== void 0 ? _a : `metrics-${++MetricRecorder._counter}`;
            this.stageFilter = idOrOptions === null || idOrOptions === void 0 ? void 0 : idOrOptions.stageFilter;
        }
    }
    shouldRecord(stageName) {
        return !this.stageFilter || this.stageFilter(stageName);
    }
    onRead(event) {
        if (!this.shouldRecord(event.stageName))
            return;
        this.getOrCreateStageMetrics(event.stageName).readCount++;
    }
    onWrite(event) {
        if (!this.shouldRecord(event.stageName))
            return;
        this.getOrCreateStageMetrics(event.stageName).writeCount++;
    }
    onCommit(event) {
        if (!this.shouldRecord(event.stageName))
            return;
        this.getOrCreateStageMetrics(event.stageName).commitCount++;
    }
    onPause(event) {
        if (!this.shouldRecord(event.stageName))
            return;
        this.getOrCreateStageMetrics(event.stageName).pauseCount++;
    }
    onStageStart(event) {
        if (!this.shouldRecord(event.stageName))
            return;
        this.stageStartTimes.set(event.stageName, event.timestamp);
        this.getOrCreateStageMetrics(event.stageName).invocationCount++;
    }
    onStageEnd(event) {
        if (!this.shouldRecord(event.stageName))
            return;
        const stageMetrics = this.getOrCreateStageMetrics(event.stageName);
        let duration;
        if (event.duration !== undefined) {
            duration = event.duration;
        }
        else {
            const startTime = this.stageStartTimes.get(event.stageName);
            duration = startTime !== undefined ? event.timestamp - startTime : 0;
        }
        stageMetrics.totalDuration += duration;
        this.stageStartTimes.delete(event.stageName);
    }
    getMetrics() {
        let totalDuration = 0;
        let totalReads = 0;
        let totalWrites = 0;
        let totalCommits = 0;
        let totalPauses = 0;
        for (const stageMetrics of this.metrics.values()) {
            totalDuration += stageMetrics.totalDuration;
            totalReads += stageMetrics.readCount;
            totalWrites += stageMetrics.writeCount;
            totalCommits += stageMetrics.commitCount;
            totalPauses += stageMetrics.pauseCount;
        }
        return {
            totalDuration,
            totalReads,
            totalWrites,
            totalCommits,
            totalPauses,
            stageMetrics: new Map(this.metrics),
        };
    }
    getStageMetrics(stageName) {
        const metrics = this.metrics.get(stageName);
        return metrics ? { ...metrics } : undefined;
    }
    toSnapshot() {
        const metrics = this.getMetrics();
        return {
            name: 'Metrics',
            data: {
                totalDuration: metrics.totalDuration,
                totalReads: metrics.totalReads,
                totalWrites: metrics.totalWrites,
                totalCommits: metrics.totalCommits,
                stages: Object.fromEntries(metrics.stageMetrics),
            },
        };
    }
    reset() {
        this.metrics.clear();
        this.stageStartTimes.clear();
    }
    clear() {
        this.reset();
    }
    getOrCreateStageMetrics(stageName) {
        let stageMetrics = this.metrics.get(stageName);
        if (!stageMetrics) {
            stageMetrics = {
                stageName,
                readCount: 0,
                writeCount: 0,
                commitCount: 0,
                pauseCount: 0,
                totalDuration: 0,
                invocationCount: 0,
            };
            this.metrics.set(stageName, stageMetrics);
        }
        return stageMetrics;
    }
}
MetricRecorder._counter = 0;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTWV0cmljUmVjb3JkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL3Njb3BlL3JlY29yZGVycy9NZXRyaWNSZWNvcmRlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBOEJHO0FBd0NILE1BQU0sT0FBTyxjQUFjO0lBUXpCLFlBQVksV0FBNEM7O1FBSmhELFlBQU8sR0FBOEIsSUFBSSxHQUFHLEVBQUUsQ0FBQztRQUMvQyxvQkFBZSxHQUF3QixJQUFJLEdBQUcsRUFBRSxDQUFDO1FBSXZELElBQUksT0FBTyxXQUFXLEtBQUssUUFBUSxFQUFFLENBQUM7WUFDcEMsSUFBSSxDQUFDLEVBQUUsR0FBRyxXQUFXLENBQUM7UUFDeEIsQ0FBQzthQUFNLENBQUM7WUFDTixJQUFJLENBQUMsRUFBRSxHQUFHLE1BQUEsV0FBVyxhQUFYLFdBQVcsdUJBQVgsV0FBVyxDQUFFLEVBQUUsbUNBQUksV0FBVyxFQUFFLGNBQWMsQ0FBQyxRQUFRLEVBQUUsQ0FBQztZQUNwRSxJQUFJLENBQUMsV0FBVyxHQUFHLFdBQVcsYUFBWCxXQUFXLHVCQUFYLFdBQVcsQ0FBRSxXQUFXLENBQUM7UUFDOUMsQ0FBQztJQUNILENBQUM7SUFFTyxZQUFZLENBQUMsU0FBaUI7UUFDcEMsT0FBTyxDQUFDLElBQUksQ0FBQyxXQUFXLElBQUksSUFBSSxDQUFDLFdBQVcsQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUMxRCxDQUFDO0lBRUQsTUFBTSxDQUFDLEtBQWdCO1FBQ3JCLElBQUksQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUM7WUFBRSxPQUFPO1FBQ2hELElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUMsU0FBUyxFQUFFLENBQUM7SUFDNUQsQ0FBQztJQUVELE9BQU8sQ0FBQyxLQUFpQjtRQUN2QixJQUFJLENB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Z0JBQ2IsYUFBYSxFQUFFLENBQUM7Z0JBQ2hCLGVBQWUsRUFBRSxDQUFDO2FBQ25CLENBQUM7WUFDRixJQUFJLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxTQUFTLEVBQUUsWUFBWSxDQUFDLENBQUM7UUFDNUMsQ0FBQztRQUNELE9BQU8sWUFBWSxDQUFDO0lBQ3RCLENBQUM7O0FBaEljLHVCQUFRLEdBQUcsQ0FBQyxBQUFKLENBQUsiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIE1ldHJpY1JlY29yZGVyIOKAlCBQcm9kdWN0aW9uLWZvY3VzZWQgcmVjb3JkZXIgZm9yIHRpbWluZyBhbmQgZXhlY3V0aW9uIGNvdW50cy5cbiAqXG4gKiBUcmFja3MgcmVhZC93cml0ZS9jb21taXQgY291bnRzIHBlciBzdGFnZSBhbmQgbWVhc3VyZXMgc3RhZ2UgZXhlY3V0aW9uIGR1cmF0aW9uLlxuICpcbiAqIEVhY2ggaW5zdGFuY2UgZ2V0cyBhIHVuaXF1ZSBhdXRvLWluY3JlbWVudCBJRCAoYG1ldHJpY3MtMWAsIGBtZXRyaWNzLTJgLCAuLi4pLFxuICogc28gbXVsdGlwbGUgcmVjb3JkZXJzIHdpdGggZGlmZmVyZW50IGNvbmZpZ3MgY29leGlzdC4gUGFzcyBhbiBleHBsaWNpdCBJRCB0b1xuICogb3ZlcnJpZGUgYSBzcGVjaWZpYyBpbnN0YW5jZSAoZS5nLiwgYSBmcmFtZXdvcmstYXR0YWNoZWQgcmVjb3JkZXIpLlxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiAvLyBUcmFjayBhbGwgc3RhZ2VzIChkZWZhdWx0KVxuICogZXhlY3V0b3IuYXR0YWNoUmVjb3JkZXIobmV3IE1ldHJpY1JlY29yZGVyKCkpO1xuICpcbiAqIC8vIFRyYWNrIG9ubHkgTExNLXJlbGF0ZWQgc3RhZ2VzXG4gKiBleGVjdXRvci5hdHRhY2hSZWNvcmRlcihuZXcgTWV0cmljUmVjb3JkZXIoe1xuICogICBzdGFnZUZpbHRlcjogKG5hbWUpID0+IFsnQ2FsbExMTScsICdQYXJzZVJlc3BvbnNlJ10uaW5jbHVkZXMobmFtZSksXG4gKiB9KSk7XG4gKlxuICogLy8gVHdvIHJlY29yZGVyczogb25lIGZvciBMTE0gdGltaW5nLCBvbmUgZm9yIGV2ZXJ5dGhpbmcgZWxzZVxuICogZXhlY3V0b3IuYXR0YWNoUmVjb3JkZXIobmV3IE1ldHJpY1JlY29yZGVyKHtcbiAqICAgc3RhZ2VGaWx0ZXI6IChuYW1lKSA9PiBuYW1lID09PSAnQ2FsbExMTScsXG4gKiB9KSk7XG4gKiBleGVjdXRvci5hdHRhY2hSZWNvcmRlcihuZXcgTWV0cmljUmVjb3JkZXIoe1xuICogICBzdGFnZUZpbHRlcjogKG5hbWUpID0+IG5hbWUgIT09ICdDYWxsTExNJyxcbiAqIH0pKTtcbiAqXG4gKiAvLyBPdmVycmlkZSBhIGZyYW1ld29yay1hdHRhY2hlZCByZWNvcmRlciBieSBwYXNzaW5nIGl0cyB3ZWxsLWtub3duIElEXG4gKiBleGVjdXRvci5hdHRhY2hSZWNvcmRlcihuZXcgTWV0cmljUmVjb3JkZXIoeyBpZDogJ21ldHJpY3MnIH0pKTtcbiAqIGBgYFxuICovXG5cbmltcG9ydCB0eXBlIHsgQ29tbWl0RXZlbnQsIFBhdXNlRXZlbnQsIFJlYWRFdmVudCwgUmVjb3JkZXIsIFN0YWdlRXZlbnQsIFdyaXRlRXZlbnQgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgU3RhZ2VNZXRyaWNzIHtcbiAgc3RhZ2VOYW1lOiBzdHJpbmc7XG4gIHJlYWRDb3VudDogbnVtYmVyO1xuICB3cml0ZUNvdW50OiBudW1iZXI7XG4gIGNvbW1pdENvdW50OiBudW1iZXI7XG4gIHBhdXNlQ291bnQ6IG51bWJlcjtcbiAgdG90YWxEdXJhdGlvbjogbnVtYmVyO1xuICBpbnZvY2F0aW9uQ291bnQ6IG51bWJlcjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBBZ2dyZWdhdGVkTWV0cmljcyB7XG4gIHRvdGFsRHVyYXRpb246IG51bWJlcjtcbiAgdG90YWxSZWFkczogbnVtYmVyO1xuICB0b3RhbFdyaXRlczogbnVtYmVyO1xuICB0b3RhbENvbW1pdHM6IG51bWJlcjtcbiAgdG90YWxQYXVzZXM6IG51bWJlcjtcbiAgc3RhZ2VNZXRyaWNzOiBNYXA8c3RyaW5nLCBTdGFnZU1ldHJpY3M+O1xufVxuXG4vKiogT3B0aW9ucyBmb3IgTWV0cmljUmVjb3JkZXIuIEFsbCBmaWVsZHMgYXJlIG9wdGlvbmFsLiAqL1xuZXhwb3J0IGludGVyZmFjZSBNZXRyaWNSZWNvcmRlck9wdGlvbnMge1xuICAvKiogUmVjb3JkZXIgSUQuIERlZmF1bHRzIHRvIGF1dG8taW5jcmVtZW50IChgbWV0cmljcy0xYCwgYG1ldHJpY3MtMmAsIC4uLikuICovXG4gIGlkPzogc3RyaW5nO1xuICAvKipcbiAgICogRmlsdGVyIHdoaWNoIHN0YWdlcyBhcmUgcmVjb3JkZWQuIFJldHVybiBgdHJ1ZWAgdG8gcmVjb3JkLCBgZmFsc2VgIHRvIHNraXAuXG4gICAqIFdoZW4gb21pdHRlZCwgYWxsIHN0YWdlcyBhcmUgcmVjb3JkZWQuXG4gICAqXG4gICAqIEBleGFtcGxlXG4gICAqIGBgYHR5cGVzY3JpcHRcbiAgICogLy8gT25seSB0cmFjayBzdGFnZXMgdGhhdCBzdGFydCB3aXRoIFwiQ2FsbFwiXG4gICAqIHN0YWdlRmlsdGVyOiAobmFtZSkgPT4gbmFtZS5zdGFydHNXaXRoKCdDYWxsJylcbiAgICogYGBgXG4gICAqL1xuICBzdGFnZUZpbHRlcj86IChzdGFnZU5hbWU6IHN0cmluZykgPT4gYm9vbGVhbjtcbn1cblxuZXhwb3J0IGNsYXNzIE1ldHJpY1JlY29yZGVyIGltcGxlbWVudHMgUmVjb3JkZXIge1xuICBwcml2YXRlIHN0YXRpYyBfY291bnRlciA9IDA7XG5cbiAgcmVhZG9ubHkgaWQ6IHN0cmluZztcbiAgcHJpdmF0ZSBtZXRyaWNzOiBNYXA8c3RyaW5nLCBTdGFnZU1ldHJpY3M+ID0gbmV3IE1hcCgpO1xuICBwcml2YXRlIHN0YWdlU3RhcnRUaW1lczogTWFwPHN0cmluZywgbnVtYmVyPiA9IG5ldyBNYXAoKTtcbiAgcHJpdmF0ZSBzdGFnZUZpbHRlcj86IChzdGFnZU5hbWU6IHN0cmluZykgPT4gYm9vbGVhbjtcblxuICBjb25zdHJ1Y3RvcihpZE9yT3B0aW9ucz86IHN0cmluZyB8IE1ldHJpY1JlY29yZGVyT3B0aW9ucykge1xuICAgIGlmICh0eXBlb2YgaWRPck9wdGlvbnMgPT09ICdzdHJpbmcnKSB7XG4gICAgICB0aGlzLmlkID0gaWRPck9wdGlvbnM7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuaWQgPSBpZE9yT3B0aW9ucz8uaWQgPz8gYG1ldHJpY3MtJHsrK01ldHJpY1JlY29yZGVyLl9jb3VudGVyfWA7XG4gICAgICB0aGlzLnN0YWdlRmlsdGVyID0gaWRPck9wdGlvbnM/LnN0YWdlRmlsdGVyO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgc2hvdWxkUmVjb3JkKHN0YWdlTmFtZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gICAgcmV0dXJuICF0aGlzLnN0YWdlRmlsdGVyIHx8IHRoaXMuc3RhZ2VGaWx0ZXIoc3RhZ2VOYW1lKTtcbiAgfVxuXG4gIG9uUmVhZChldmVudDogUmVhZEV2ZW50KTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLnNob3VsZFJlY29yZChldmVudC5zdGFnZU5hbWUpKSByZXR1cm47XG4gICAgdGhpcy5nZXRPckNyZWF0ZVN0YWdlTWV0cmljcyhldmVudC5zdGFnZU5hbWUpLnJlYWRDb3VudCsrO1xuICB9XG5cbiAgb25Xcml0ZShldmVudDogV3JpdGVFdmVudCk6IHZvaWQge1xuICAgIGlmICghdGhpcy5zaG91bGRSZWNvcmQoZXZlbnQuc3RhZ2VOYW1lKSkgcmV0dXJuO1xuICAgIHRoaXMuZ2V0T3JDcmVhdGVTdGFnZU1ldHJpY3MoZXZlbnQuc3RhZ2VOYW1lKS53cml0ZUNvdW50Kys7XG4gIH1cblxuICBvbkNvbW1pdChldmVudDogQ29tbWl0RXZlbnQpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuc2hvdWxkUmVjb3JkKGV2ZW50LnN0YWdlTmFtZSkpIHJldHVybjtcbiAgICB0aGlzLmdldE9yQ3JlYXRlU3RhZ2VNZXRyaWNzKGV2ZW50LnN0YWdlTmFtZSkuY29tbWl0Q291bnQrKztcbiAgfVxuXG4gIG9uUGF1c2UoZXZlbnQ6IFBhdXNlRXZlbnQpOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuc2hvdWxkUmVjb3JkKGV2ZW50LnN0YWdlTmFtZSkpIHJldHVybjtcbiAgICB0aGlzLmdldE9yQ3JlYXRlU3RhZ2VNZXRyaWNzKGV2ZW50LnN0YWdlTmFtZSkucGF1c2VDb3VudCsrO1xuICB9XG5cbiAgb25TdGFnZVN0YXJ0KGV2ZW50OiBTdGFnZUV2ZW50KTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLnNob3VsZFJlY29yZChldmVudC5zdGFnZU5hbWUpKSByZXR1cm47XG4gICAgdGhpcy5zdGFnZVN0YXJ0VGltZXMuc2V0KGV2ZW50LnN0YWdlTmFtZSwgZXZlbnQudGltZXN0YW1wKTtcbiAgICB0aGlzLmdldE9yQ3JlYXRlU3RhZ2VNZXRyaWNzKGV2ZW50LnN0YWdlTmFtZSkuaW52b2NhdGlvbkNvdW50Kys7XG4gIH1cblxuICBvblN0YWdlRW5kKGV2ZW50OiBTdGFnZUV2ZW50KTogdm9pZCB7XG4gICAgaWYgKCF0aGlzLnNob3VsZFJlY29yZChldmVudC5zdGFnZU5hbWUpKSByZXR1cm47XG4gICAgY29uc3Qgc3RhZ2VNZXRyaWNzID0gdGhpcy5nZXRPckNyZWF0ZVN0YWdlTWV0cmljcyhldmVudC5zdGFnZU5hbWUpO1xuICAgIGxldCBkdXJhdGlvbjogbnVtYmVyO1xuICAgIGlmIChldmVudC5kdXJhdGlvbiAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICBkdXJhdGlvbiA9IGV2ZW50LmR1cmF0aW9uO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzdGFydFRpbWUgPSB0aGlzLnN0YWdlU3RhcnRUaW1lcy5nZXQoZXZlbnQuc3RhZ2VOYW1lKTtcbiAgICAgIGR1cmF0aW9uID0gc3RhcnRUaW1lICE9PSB1bmRlZmluZWQgPyBldmVudC50aW1lc3RhbXAgLSBzdGFydFRpbWUgOiAwO1xuICAgIH1cbiAgICBzdGFnZU1ldHJpY3MudG90YWxEdXJhdGlvbiArPSBkdXJhdGlvbjtcbiAgICB0aGlzLnN0YWdlU3RhcnRUaW1lcy5kZWxldGUoZXZlbnQuc3RhZ2VOYW1lKTtcbiAgfVxuXG4gIGdldE1ldHJpY3MoKTogQWdncmVnYXRlZE1ldHJpY3Mge1xuICAgIGxldCB0b3RhbER1cmF0aW9uID0gMDtcbiAgICBsZXQgdG90YWxSZWFkcyA9IDA7XG4gICAgbGV0IHRvdGFsV3JpdGVzID0gMDtcbiAgICBsZXQgdG90YWxDb21taXRzID0gMDtcbiAgICBsZXQgdG90YWxQYXVzZXMgPSAwO1xuXG4gICAgZm9yIChjb25zdCBzdGFnZU1ldHJpY3Mgb2YgdGhpcy5tZXRyaWNzLnZhbHVlcygpKSB7XG4gICAgICB0b3RhbER1cmF0aW9uICs9IHN0YWdlTWV0cmljcy50b3RhbER1cmF0aW9uO1xuICAgICAgdG90YWxSZWFkcyArPSBzdGFnZU1ldHJpY3MucmVhZENvdW50O1xuICAgICAgdG90YWxXcml0ZXMgKz0gc3RhZ2VNZXRyaWNzLndyaXRlQ291bnQ7XG4gICAgICB0b3RhbENvbW1pdHMgKz0gc3RhZ2VNZXRyaWNzLmNvbW1pdENvdW50O1xuICAgICAgdG90YWxQYXVzZXMgKz0gc3RhZ2VNZXRyaWNzLnBhdXNlQ291bnQ7XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIHRvdGFsRHVyYXRpb24sXG4gICAgICB0b3RhbFJlYWRzLFxuICAgICAgdG90YWxXcml0ZXMsXG4gICAgICB0b3RhbENvbW1pdHMsXG4gICAgICB0b3RhbFBhdXNlcyxcbiAgICAgIHN0YWdlTWV0cmljczogbmV3IE1hcCh0aGlzLm1ldHJpY3MpLFxuICAgIH07XG4gIH1cblxuICBnZXRTdGFnZU1ldHJpY3Moc3RhZ2VOYW1lOiBzdHJpbmcpOiBTdGFnZU1ldHJpY3MgfCB1bmRlZmluZWQge1xuICAgIGNvbnN0IG1ldHJpY3MgPSB0aGlzLm1ldHJpY3MuZ2V0KHN0YWdlTmFtZSk7XG4gICAgcmV0dXJuIG1ldHJpY3MgPyB7IC4uLm1ldHJpY3MgfSA6IHVuZGVmaW5lZDtcbiAgfVxuXG4gIHRvU25hcHNob3QoKTogeyBuYW1lOiBzdHJpbmc7IGRhdGE6IHVua25vd24gfSB7XG4gICAgY29uc3QgbWV0cmljcyA9IHRoaXMuZ2V0TWV0cmljcygpO1xuICAgIHJldHVybiB7XG4gICAgICBuYW1lOiAnTWV0cmljcycsXG4gICAgICBkYXRhOiB7XG4gICAgICAgIHRvdGFsRHVyYXRpb246IG1ldHJpY3MudG90YWxEdXJhdGlvbixcbiAgICAgICAgdG90YWxSZWFkczogbWV0cmljcy50b3RhbFJlYWRzLFxuICAgICAgICB0b3RhbFdyaXRlczogbWV0cmljcy50b3RhbFdyaXRlcyxcbiAgICAgICAgdG90YWxDb21taXRzOiBtZXRyaWNzLnRvdGFsQ29tbWl0cyxcbiAgICAgICAgc3RhZ2VzOiBPYmplY3QuZnJvbUVudHJpZXMobWV0cmljcy5zdGFnZU1ldHJpY3MpLFxuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgcmVzZXQoKTogdm9pZCB7XG4gICAgdGhpcy5tZXRyaWNzLmNsZWFyKCk7XG4gICAgdGhpcy5zdGFnZVN0YXJ0VGltZXMuY2xlYXIoKTtcbiAgfVxuXG4gIGNsZWFyKCk6IHZvaWQge1xuICAgIHRoaXMucmVzZXQoKTtcbiAgfVxuXG4gIHByaXZhdGUgZ2V0T3JDcmVhdGVTdGFnZU1ldHJpY3Moc3RhZ2VOYW1lOiBzdHJpbmcpOiBTdGFnZU1ldHJpY3Mge1xuICAgIGxldCBzdGFnZU1ldHJpY3MgPSB0aGlzLm1ldHJpY3MuZ2V0KHN0YWdlTmFtZSk7XG4gICAgaWYgKCFzdGFnZU1ldHJpY3MpIHtcbiAgICAgIHN0YWdlTWV0cmljcyA9IHtcbiAgICAgICAgc3RhZ2VOYW1lLFxuICAgICAgICByZWFkQ291bnQ6IDAsXG4gICAgICAgIHdyaXRlQ291bnQ6IDAsXG4gICAgICAgIGNvbW1pdENvdW50OiAwLFxuICAgICAgICBwYXVzZUNvdW50OiAwLFxuICAgICAgICB0b3RhbER1cmF0aW9uOiAwLFxuICAgICAgICBpbnZvY2F0aW9uQ291bnQ6IDAsXG4gICAgICB9O1xuICAgICAgdGhpcy5tZXRyaWNzLnNldChzdGFnZU5hbWUsIHN0YWdlTWV0cmljcyk7XG4gICAgfVxuICAgIHJldHVybiBzdGFnZU1ldHJpY3M7XG4gIH1cbn1cbiJdfQ==