/**
 * ExtractorRunner — Per-stage snapshot extraction.
 *
 * Coordinates traversal extractor invocations: step counting,
 * snapshot enrichment, error collection, and result storage.
 */
import { computeNodeType } from './RuntimeStructureManager.js';
export class ExtractorRunner {
    constructor(extractor, enrichSnapshots, executionRuntime, logger) {
        this.extractedResults = new Map();
        this.extractorErrors = [];
        this.stepCounter = 0;
        this.extractor = extractor;
        this.enrichSnapshots = enrichSnapshots;
        this.executionRuntime = executionRuntime;
        this.logger = logger;
    }
    /**
     * Call the extractor for a stage and store the result.
     * Increments stepCounter (1-based) before creating snapshot.
     */
    callExtractor(node, context, stagePath, stageOutput, errorInfo) {
        var _a;
        if (!this.extractor)
            return;
        this.stepCounter++;
        try {
            const snapshot = {
                node,
                context,
                stepNumber: this.stepCounter,
                structureMetadata: this.buildStructureMetadata(node),
            };
            if (this.enrichSnapshots) {
                try {
                    snapshot.scopeState = { ...this.executionRuntime.globalStore.getState() };
                    snapshot.debugInfo = {
                        logs: { ...context.debug.logContext },
                        errors: { ...context.debug.errorContext },
                        metrics: { ...context.debug.metricContext },
                        evals: { ...context.debug.evalContext },
                    };
                    if (context.debug.flowMessages.length > 0) {
                        snapshot.debugInfo.flowMessages = [...context.debug.flowMessages];
                    }
                    snapshot.stageOutput = stageOutput;
                    if (errorInfo) {
                        snapshot.errorInfo = errorInfo;
                    }
                    snapshot.historyIndex = this.executionRuntime.executionHistory.list().length;
                }
                catch (enrichError) {
                    this.logger.warn(`Enrichment error at stage '${stagePath}':`, { error: enrichError });
                }
            }
            const result = this.extractor(snapshot);
            if (result !== undefined && result !== null) {
                this.extractedResults.set(stagePath, result);
            }
        }
        catch (error) {
            this.logger.error(`Extractor error at stage '${stagePath}':`, { error });
            this.extractorErrors.push({
                stagePath,
                message: (_a = error === null || error === void 0 ? void 0 : error.message) !== null && _a !== void 0 ? _a : String(error),
                error,
            });
        }
    }
    /**
     * Generate the stage path for extractor results.
     * Uses node.id combined with branchPath.
     */
    getStagePath(node, branchPath, contextStageName) {
        const baseName = node.id;
        const nodeId = contextStageName && contextStageName !== node.name ? contextStageName : baseName;
        if (!branchPath)
            return nodeId;
        return `${branchPath}.${nodeId}`;
    }
    buildStructureMetadata(node) {
        var _a;
        const metadata = {
            type: computeNodeType(node),
        };
        if (node.isSubflowRoot) {
            metadata.isSubflowRoot = true;
            metadata.subflowId = node.subflowId;
            metadata.subflowName = node.subflowName;
        }
        else if (this.currentSubflowId) {
            metadata.subflowId = this.currentSubflowId;
        }
        if (this.currentForkId) {
            metadata.isParallelChild = true;
            metadata.parallelGroupId = this.currentForkId;
        }
        if (node.isStreaming) {
            metadata.streamId = node.streamId;
        }
        const hasDynamicChildren = Boolean(((_a = node.children) === null || _a === void 0 ? void 0 : _a.length) && !node.nextNodeSelector && node.fn);
        if (hasDynamicChildren) {
            metadata.isDynamic = true;
        }
        return metadata;
    }
    /** Returns extracted results collected during execution. */
    getExtractedResults() {
        return this.extractedResults;
    }
    /** Returns errors encountered during extraction. */
    getExtractorErrors() {
        return this.extractorErrors;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiRXh0cmFjdG9yUnVubmVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvaGFuZGxlcnMvRXh0cmFjdG9yUnVubmVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7OztHQUtHO0FBWUgsT0FBTyxFQUFFLGVBQWUsRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBRS9ELE1BQU0sT0FBTyxlQUFlO0lBZ0IxQixZQUNFLFNBQXlDLEVBQ3pDLGVBQXdCLEVBQ3hCLGdCQUFtQyxFQUNuQyxNQUFlO1FBZFQscUJBQWdCLEdBQXlCLElBQUksR0FBRyxFQUFFLENBQUM7UUFDbkQsb0JBQWUsR0FBcUIsRUFBRSxDQUFDO1FBQ3ZDLGdCQUFXLEdBQUcsQ0FBQyxDQUFDO1FBY3RCLElBQUksQ0FBQyxTQUFTLEdBQUcsU0FBUyxDQUFDO1FBQzNCLElBQUksQ0FBQyxlQUFlLEdBQUcsZUFBZSxDQUFDO1FBQ3ZDLElBQUksQ0FBQyxnQkFBZ0IsR0FBRyxnQkFBZ0IsQ0FBQztRQUN6QyxJQUFJLENBQUMsTUFBTSxHQUFHLE1BQU0sQ0FBQztJQUN2QixDQUFDO0lBRUQ7OztPQUdHO0lBQ0gsYUFBYSxDQUNYLElBQWUsRUFDZixPQUFxQixFQUNyQixTQUFpQixFQUNqQixXQUFxQixFQUNyQixTQUE2Qzs7UUFFN0MsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTO1lBQUUsT0FBTztRQUU1QixJQUFJLENBQUMsV0FBVyxFQUFFLENBQUM7UUFFbkIsSUFBSSxDQUFDO1lBQ0gsTUFBTSxRQUFRLEdBQWtCO2dCQUM5QixJQUFJO2dCQUNKLE9BQU87Z0JBQ1AsVUFBVSxFQUFFLElBQUksQ0FBQyxXQUFXO2dCQUM1QixpQkFBaUIsRUFBRSxJQUFJLENBQUMsc0JBQXNCLENBQUMsSUFBSSxDQUFDO2FBQ3JELENBQUM7WUFFRixJQUFJLElBQUksQ0FBQyxlQUFlLEVBQUUsQ0FBQztnQkFDekIsSUFBSSxDQUFDO29CQUNILFFB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QUM5QixRQUFRLENBQUMsU0FBUyxHQUFHLElBQUksQ0FBQyxTQUFTLENBQUM7WUFDcEMsUUFBUSxDQUFDLFdBQVcsR0FBRyxJQUFJLENBQUMsV0FBVyxDQUFDO1FBQzFDLENBQUM7YUFBTSxJQUFJLElBQUksQ0FBQyxnQkFBZ0IsRUFBRSxDQUFDO1lBQ2pDLFFBQVEsQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDLGdCQUFnQixDQUFDO1FBQzdDLENBQUM7UUFFRCxJQUFJLElBQUksQ0FBQyxhQUFhLEVBQUUsQ0FBQztZQUN2QixRQUFRLENBQUMsZUFBZSxHQUFHLElBQUksQ0FBQztZQUNoQyxRQUFRLENBQUMsZUFBZSxHQUFHLElBQUksQ0FBQyxhQUFhLENBQUM7UUFDaEQsQ0FBQztRQUVELElBQUksSUFBSSxDQUFDLFdBQVcsRUFBRSxDQUFDO1lBQ3JCLFFBQVEsQ0FBQyxRQUFRLEdBQUcsSUFBSSxDQUFDLFFBQVEsQ0FBQztRQUNwQyxDQUFDO1FBRUQsTUFBTSxrQkFBa0IsR0FBRyxPQUFPLENBQUMsQ0FBQSxNQUFBLElBQUksQ0FBQyxRQUFRLDBDQUFFLE1BQU0sS0FBSSxDQUFDLElBQUksQ0FBQyxnQkFBZ0IsSUFBSSxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDL0YsSUFBSSxrQkFBa0IsRUFBRSxDQUFDO1lBQ3ZCLFFBQVEsQ0FBQyxTQUFTLEdBQUcsSUFBSSxDQUFDO1FBQzVCLENBQUM7UUFFRCxPQUFPLFFBQVEsQ0FBQztJQUNsQixDQUFDO0lBRUQsNERBQTREO0lBQzVELG1CQUFtQjtRQUNqQixPQUFPLElBQUksQ0FBQyxnQkFBd0MsQ0FBQztJQUN2RCxDQUFDO0lBRUQsb0RBQW9EO0lBQ3BELGtCQUFrQjtRQUNoQixPQUFPLElBQUksQ0FBQyxlQUFlLENBQUM7SUFDOUIsQ0FBQztDQUNGIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBFeHRyYWN0b3JSdW5uZXIg4oCUIFBlci1zdGFnZSBzbmFwc2hvdCBleHRyYWN0aW9uLlxuICpcbiAqIENvb3JkaW5hdGVzIHRyYXZlcnNhbCBleHRyYWN0b3IgaW52b2NhdGlvbnM6IHN0ZXAgY291bnRpbmcsXG4gKiBzbmFwc2hvdCBlbnJpY2htZW50LCBlcnJvciBjb2xsZWN0aW9uLCBhbmQgcmVzdWx0IHN0b3JhZ2UuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBTdGFnZUNvbnRleHQgfSBmcm9tICcuLi8uLi9tZW1vcnkvU3RhZ2VDb250ZXh0LmpzJztcbmltcG9ydCB0eXBlIHsgU3RhZ2VOb2RlIH0gZnJvbSAnLi4vZ3JhcGgvU3RhZ2VOb2RlLmpzJztcbmltcG9ydCB0eXBlIHtcbiAgRXh0cmFjdG9yRXJyb3IsXG4gIElFeGVjdXRpb25SdW50aW1lLFxuICBJTG9nZ2VyLFxuICBSdW50aW1lU3RydWN0dXJlTWV0YWRhdGEsXG4gIFN0YWdlU25hcHNob3QsXG4gIFRyYXZlcnNhbEV4dHJhY3Rvcixcbn0gZnJvbSAnLi4vdHlwZXMuanMnO1xuaW1wb3J0IHsgY29tcHV0ZU5vZGVUeXBlIH0gZnJvbSAnLi9SdW50aW1lU3RydWN0dXJlTWFuYWdlci5qcyc7XG5cbmV4cG9ydCBjbGFzcyBFeHRyYWN0b3JSdW5uZXI8VE91dCA9IGFueSwgVFNjb3BlID0gYW55PiB7XG4gIHByaXZhdGUgcmVhZG9ubHkgZXh0cmFjdG9yPzogVHJhdmVyc2FsRXh0cmFjdG9yO1xuICBwcml2YXRlIHJlYWRvbmx5IGVucmljaFNuYXBzaG90czogYm9vbGVhbjtcbiAgcHJpdmF0ZSByZWFkb25seSBleGVjdXRpb25SdW50aW1lOiBJRXhlY3V0aW9uUnVudGltZTtcbiAgcHJpdmF0ZSByZWFkb25seSBsb2dnZXI6IElMb2dnZXI7XG5cbiAgcHJpdmF0ZSBleHRyYWN0ZWRSZXN1bHRzOiBNYXA8c3RyaW5nLCB1bmtub3duPiA9IG5ldyBNYXAoKTtcbiAgcHJpdmF0ZSBleHRyYWN0b3JFcnJvcnM6IEV4dHJhY3RvckVycm9yW10gPSBbXTtcbiAgcHJpdmF0ZSBzdGVwQ291bnRlciA9IDA7XG5cbiAgLyoqIEN1cnJlbnQgc3ViZmxvdyBjb250ZXh0IGZvciBtZXRhZGF0YSBwcm9wYWdhdGlvbi4gU2V0L2NsZWFyZWQgZHVyaW5nIHN1YmZsb3cgZXhlY3V0aW9uLiAqL1xuICBjdXJyZW50U3ViZmxvd0lkPzogc3RyaW5nO1xuXG4gIC8qKiBDdXJyZW50IGZvcmsgY29udGV4dCBmb3IgbWV0YWRhdGEgcHJvcGFnYXRpb24uIFNldC9jbGVhcmVkIGR1cmluZyBwYXJhbGxlbCBjaGlsZHJlbiBleGVjdXRpb24uICovXG4gIGN1cnJlbnRGb3JrSWQ/OiBzdHJpbmc7XG5cbiAgY29uc3RydWN0b3IoXG4gICAgZXh0cmFjdG9yOiBUcmF2ZXJzYWxFeHRyYWN0b3IgfCB1bmRlZmluZWQsXG4gICAgZW5yaWNoU25hcHNob3RzOiBib29sZWFuLFxuICAgIGV4ZWN1dGlvblJ1bnRpbWU6IElFeGVjdXRpb25SdW50aW1lLFxuICAgIGxvZ2dlcjogSUxvZ2dlcixcbiAgKSB7XG4gICAgdGhpcy5leHRyYWN0b3IgPSBleHRyYWN0b3I7XG4gICAgdGhpcy5lbnJpY2hTbmFwc2hvdHMgPSBlbnJpY2hTbmFwc2hvdHM7XG4gICAgdGhpcy5leGVjdXRpb25SdW50aW1lID0gZXhlY3V0aW9uUnVudGltZTtcbiAgICB0aGlzLmxvZ2dlciA9IGxvZ2dlcjtcbiAgfVxuXG4gIC8qKlxuICAgKiBDYWxsIHRoZSBleHRyYWN0b3IgZm9yIGEgc3RhZ2UgYW5kIHN0b3JlIHRoZSByZXN1bHQuXG4gICAqIEluY3JlbWVudHMgc3RlcENvdW50ZXIgKDEtYmFzZWQpIGJlZm9yZSBjcmVhdGluZyBzbmFwc2hvdC5cbiAgICovXG4gIGNhbGxFeHRyYWN0b3IoXG4gICAgbm9kZTogU3RhZ2VOb2RlLFxuICAgIGNvbnRleHQ6IFN0YWdlQ29udGV4dCxcbiAgICBzdGFnZVBhdGg6IHN0cmluZyxcbiAgICBzdGFnZU91dHB1dD86IHVua25vd24sXG4gICAgZXJyb3JJbmZvPzogeyB0eXBlOiBzdHJpbmc7IG1lc3NhZ2U6IHN0cmluZyB9LFxuICApOiB2b2lkIHtcbiAgICBpZiAoIXRoaXMuZXh0cmFjdG9yKSByZXR1cm47XG5cbiAgICB0aGlzLnN0ZXBDb3VudGVyKys7XG5cbiAgICB0cnkge1xuICAgICAgY29uc3Qgc25hcHNob3Q6IFN0YWdlU25hcHNob3QgPSB7XG4gICAgICAgIG5vZGUsXG4gICAgICAgIGNvbnRleHQsXG4gICAgICAgIHN0ZXBOdW1iZXI6IHRoaXMuc3RlcENvdW50ZXIsXG4gICAgICAgIHN0cnVjdHVyZU1ldGFkYXRhOiB0aGlzLmJ1aWxkU3RydWN0dXJlTWV0YWRhdGEobm9kZSksXG4gICAgICB9O1xuXG4gICAgICBpZiAodGhpcy5lbnJpY2hTbmFwc2hvdHMpIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBzbmFwc2hvdC5zY29wZVN0YXRlID0geyAuLi50aGlzLmV4ZWN1dGlvblJ1bnRpbWUuZ2xvYmFsU3RvcmUuZ2V0U3RhdGUoKSB9O1xuXG4gICAgICAgICAgc25hcHNob3QuZGVidWdJbmZvID0ge1xuICAgICAgICAgICAgbG9nczogeyAuLi5jb250ZXh0LmRlYnVnLmxvZ0NvbnRleHQgfSxcbiAgICAgICAgICAgIGVycm9yczogeyAuLi5jb250ZXh0LmRlYnVnLmVycm9yQ29udGV4dCB9LFxuICAgICAgICAgICAgbWV0cmljczogeyAuLi5jb250ZXh0LmRlYnVnLm1ldHJpY0NvbnRleHQgfSxcbiAgICAgICAgICAgIGV2YWxzOiB7IC4uLmNvbnRleHQuZGVidWcuZXZhbENvbnRleHQgfSxcbiAgICAgICAgICB9O1xuICAgICAgICAgIGlmIChjb250ZXh0LmRlYnVnLmZsb3dNZXNzYWdlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBzbmFwc2hvdC5kZWJ1Z0luZm8uZmxvd01lc3NhZ2VzID0gWy4uLmNvbnRleHQuZGVidWcuZmxvd01lc3NhZ2VzXTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBzbmFwc2hvdC5zdGFnZU91dHB1dCA9IHN0YWdlT3V0cHV0O1xuXG4gICAgICAgICAgaWYgKGVycm9ySW5mbykge1xuICAgICAgICAgICAgc25hcHNob3QuZXJyb3JJbmZvID0gZXJyb3JJbmZvO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHNuYXBzaG90Lmhpc3RvcnlJbmRleCA9IHRoaXMuZXhlY3V0aW9uUnVudGltZS5leGVjdXRpb25IaXN0b3J5Lmxpc3QoKS5sZW5ndGg7XG4gICAgICAgIH0gY2F0Y2ggKGVucmljaEVycm9yOiBhbnkpIHtcbiAgICAgICAgICB0aGlzLmxvZ2dlci53YXJuKGBFbnJpY2htZW50IGVycm9yIGF0IHN0YWdlICcke3N0YWdlUGF0aH0nOmAsIHsgZXJyb3I6IGVucmljaEVycm9yIH0pO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJlc3VsdCA9IHRoaXMuZXh0cmFjdG9yKHNuYXBzaG90KTtcblxuICAgICAgaWYgKHJlc3VsdCAhPT0gdW5kZWZpbmVkICYmIHJlc3VsdCAhPT0gbnVsbCkge1xuICAgICAgICB0aGlzLmV4dHJhY3RlZFJlc3VsdHMuc2V0KHN0YWdlUGF0aCwgcmVzdWx0KTtcbiAgICAgIH1cbiAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XG4gICAgICB0aGlzLmxvZ2dlci5lcnJvcihgRXh0cmFjdG9yIGVycm9yIGF0IHN0YWdlICcke3N0YWdlUGF0aH0nOmAsIHsgZXJyb3IgfSk7XG4gICAgICB0aGlzLmV4dHJhY3RvckVycm9ycy5wdXNoKHtcbiAgICAgICAgc3RhZ2VQYXRoLFxuICAgICAgICBtZXNzYWdlOiBlcnJvcj8ubWVzc2FnZSA/PyBTdHJpbmcoZXJyb3IpLFxuICAgICAgICBlcnJvcixcbiAgICAgIH0pO1xuICAgIH1cbiAgfVxuXG4gIC8qKlxuICAgKiBHZW5lcmF0ZSB0aGUgc3RhZ2UgcGF0aCBmb3IgZXh0cmFjdG9yIHJlc3VsdHMuXG4gICAqIFVzZXMgbm9kZS5pZCBjb21iaW5lZCB3aXRoIGJyYW5jaFBhdGguXG4gICAqL1xuICBnZXRTdGFnZVBhdGgobm9kZTogU3RhZ2VOb2RlLCBicmFuY2hQYXRoPzogc3RyaW5nLCBjb250ZXh0U3RhZ2VOYW1lPzogc3RyaW5nKTogc3RyaW5nIHtcbiAgICBjb25zdCBiYXNlTmFtZSA9IG5vZGUuaWQ7XG4gICAgY29uc3Qgbm9kZUlkID0gY29udGV4dFN0YWdlTmFtZSAmJiBjb250ZXh0U3RhZ2VOYW1lICE9PSBub2RlLm5hbWUgPyBjb250ZXh0U3RhZ2VOYW1lIDogYmFzZU5hbWU7XG4gICAgaWYgKCFicmFuY2hQYXRoKSByZXR1cm4gbm9kZUlkO1xuICAgIHJldHVybiBgJHticmFuY2hQYXRofS4ke25vZGVJZH1gO1xuICB9XG5cbiAgcHJpdmF0ZSBidWlsZFN0cnVjdHVyZU1ldGFkYXRhKG5vZGU6IFN0YWdlTm9kZSk6IFJ1bnRpbWVTdHJ1Y3R1cmVNZXRhZGF0YSB7XG4gICAgY29uc3QgbWV0YWRhdGE6IFJ1bnRpbWVTdHJ1Y3R1cmVNZXRhZGF0YSA9IHtcbiAgICAgIHR5cGU6IGNvbXB1dGVOb2RlVHlwZShub2RlKSxcbiAgICB9O1xuXG4gICAgaWYgKG5vZGUuaXNTdWJmbG93Um9vdCkge1xuICAgICAgbWV0YWRhdGEuaXNTdWJmbG93Um9vdCA9IHRydWU7XG4gICAgICBtZXRhZGF0YS5zdWJmbG93SWQgPSBub2RlLnN1YmZsb3dJZDtcbiAgICAgIG1ldGFkYXRhLnN1YmZsb3dOYW1lID0gbm9kZS5zdWJmbG93TmFtZTtcbiAgICB9IGVsc2UgaWYgKHRoaXMuY3VycmVudFN1YmZsb3dJZCkge1xuICAgICAgbWV0YWRhdGEuc3ViZmxvd0lkID0gdGhpcy5jdXJyZW50U3ViZmxvd0lkO1xuICAgIH1cblxuICAgIGlmICh0aGlzLmN1cnJlbnRGb3JrSWQpIHtcbiAgICAgIG1ldGFkYXRhLmlzUGFyYWxsZWxDaGlsZCA9IHRydWU7XG4gICAgICBtZXRhZGF0YS5wYXJhbGxlbEdyb3VwSWQgPSB0aGlzLmN1cnJlbnRGb3JrSWQ7XG4gICAgfVxuXG4gICAgaWYgKG5vZGUuaXNTdHJlYW1pbmcpIHtcbiAgICAgIG1ldGFkYXRhLnN0cmVhbUlkID0gbm9kZS5zdHJlYW1JZDtcbiAgICB9XG5cbiAgICBjb25zdCBoYXNEeW5hbWljQ2hpbGRyZW4gPSBCb29sZWFuKG5vZGUuY2hpbGRyZW4/Lmxlbmd0aCAmJiAhbm9kZS5uZXh0Tm9kZVNlbGVjdG9yICYmIG5vZGUuZm4pO1xuICAgIGlmIChoYXNEeW5hbWljQ2hpbGRyZW4pIHtcbiAgICAgIG1ldGFkYXRhLmlzRHluYW1pYyA9IHRydWU7XG4gICAgfVxuXG4gICAgcmV0dXJuIG1ldGFkYXRhO1xuICB9XG5cbiAgLyoqIFJldHVybnMgZXh0cmFjdGVkIHJlc3VsdHMgY29sbGVjdGVkIGR1cmluZyBleGVjdXRpb24uICovXG4gIGdldEV4dHJhY3RlZFJlc3VsdHM8VFJlc3VsdCA9IHVua25vd24+KCk6IE1hcDxzdHJpbmcsIFRSZXN1bHQ+IHtcbiAgICByZXR1cm4gdGhpcy5leHRyYWN0ZWRSZXN1bHRzIGFzIE1hcDxzdHJpbmcsIFRSZXN1bHQ+O1xuICB9XG5cbiAgLyoqIFJldHVybnMgZXJyb3JzIGVuY291bnRlcmVkIGR1cmluZyBleHRyYWN0aW9uLiAqL1xuICBnZXRFeHRyYWN0b3JFcnJvcnMoKTogRXh0cmFjdG9yRXJyb3JbXSB7XG4gICAgcmV0dXJuIHRoaXMuZXh0cmFjdG9yRXJyb3JzO1xuICB9XG59XG4iXX0=