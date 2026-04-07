"use strict";
/**
 * NarrativeFlowRecorder — Default FlowRecorder that generates plain-English narrative.
 *
 * This is the FlowRecorder equivalent of ControlFlowNarrativeGenerator.
 * Produces the same sentences, same format, same behavior — but as a
 * pluggable FlowRecorder that can be swapped, extended, or composed.
 *
 * Consumers who want different narrative behavior (windowed loops, adaptive
 * summarization, etc.) can replace this with a different FlowRecorder.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NarrativeFlowRecorder = void 0;
class NarrativeFlowRecorder {
    constructor(id) {
        this.sentences = [];
        /** Parallel array: the actual stage name that produced each sentence. */
        this.stageNames = [];
        this.id = id !== null && id !== void 0 ? id : 'narrative';
    }
    onStageExecuted(event) {
        if (event.description) {
            this.sentences.push(`Next step: ${event.description}.`);
        }
        else {
            this.sentences.push(`Next, it moved on to ${event.stageName}.`);
        }
        this.stageNames.push(event.stageName);
    }
    onNext(event) {
        if (event.description) {
            this.sentences.push(`Next step: ${event.description}.`);
        }
        else {
            this.sentences.push(`Next, it moved on to ${event.to}.`);
        }
        this.stageNames.push(event.to);
    }
    onDecision(event) {
        const branchName = event.chosen;
        if (event.description && event.rationale) {
            this.sentences.push(`It ${event.description}: ${event.rationale}, so it chose ${branchName}.`);
        }
        else if (event.description) {
            this.sentences.push(`It ${event.description} and chose ${branchName}.`);
        }
        else if (event.rationale) {
            this.sentences.push(`A decision was made: ${event.rationale}, so the path taken was ${branchName}.`);
        }
        else {
            this.sentences.push(`A decision was made, and the path taken was ${branchName}.`);
        }
        this.stageNames.push(event.decider);
    }
    onFork(event) {
        const names = event.children.join(', ');
        this.sentences.push(`Forking into ${event.children.length} parallel paths: ${names}.`);
        this.stageNames.push(undefined);
    }
    onSelected(event) {
        const names = event.selected.join(', ');
        this.sentences.push(`${event.selected.length} of ${event.total} paths were selected: ${names}.`);
        this.stageNames.push(undefined);
    }
    onSubflowEntry(event) {
        if (event.description) {
            this.sentences.push(`Entering the ${event.name} subflow: ${event.description}.`);
        }
        else {
            this.sentences.push(`Entering the ${event.name} subflow.`);
        }
        this.stageNames.push(event.name);
    }
    onSubflowExit(event) {
        this.sentences.push(`Exiting the ${event.name} subflow.`);
        this.stageNames.push(event.name);
    }
    onLoop(event) {
        if (event.description) {
            this.sentences.push(`On pass ${event.iteration}: ${event.description} again.`);
        }
        else {
            this.sentences.push(`On pass ${event.iteration} through ${event.target}.`);
        }
        this.stageNames.push(event.target);
    }
    onBreak(event) {
        this.sentences.push(`Execution stopped at ${event.stageName}.`);
        this.stageNames.push(event.stageName);
    }
    onError(event) {
        let sentence = `An error occurred at ${event.stageName}: ${event.message}.`;
        // Enrich with field-level issues when available
        if (event.structuredError.issues && event.structuredError.issues.length > 0) {
            const issueDetails = event.structuredError.issues
                .map((issue) => {
                const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
                return `${path}: ${issue.message}`;
            })
                .join('; ');
            sentence += ` Validation issues: ${issueDetails}.`;
        }
        this.sentences.push(sentence);
        this.stageNames.push(event.stageName);
    }
    onPause(event) {
        this.sentences.push(`Execution paused at ${event.stageName}.`);
        this.stageNames.push(event.stageName);
    }
    onResume(event) {
        const suffix = event.hasInput ? ' with input.' : '.';
        this.sentences.push(`Execution resumed at ${event.stageName}${suffix}`);
        this.stageNames.push(event.stageName);
    }
    /** Returns a defensive copy of accumulated sentences. */
    getSentences() {
        return [...this.sentences];
    }
    /** Clears accumulated sentences. Useful for reuse across runs. */
    clear() {
        this.sentences = [];
        this.stageNames = [];
    }
}
exports.NarrativeFlowRecorder = NarrativeFlowRecorder;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTmFycmF0aXZlRmxvd1JlY29yZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvbmFycmF0aXZlL05hcnJhdGl2ZUZsb3dSZWNvcmRlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7OztHQVNHOzs7QUFpQkgsTUFBYSxxQkFBcUI7SUFNaEMsWUFBWSxFQUFXO1FBSmYsY0FBUyxHQUFhLEVBQUUsQ0FBQztRQUNqQyx5RUFBeUU7UUFDakUsZUFBVSxHQUEyQixFQUFFLENBQUM7UUFHOUMsSUFBSSxDQUFDLEVBQUUsR0FBRyxFQUFFLGFBQUYsRUFBRSxjQUFGLEVBQUUsR0FBSSxXQUFXLENBQUM7SUFDOUIsQ0FBQztJQUVELGVBQWUsQ0FBQyxLQUFxQjtRQUNuQyxJQUFJLEtBQUssQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUN0QixJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxjQUFjLEtBQUssQ0FBQyxXQUFXLEdBQUcsQ0FBQyxDQUFDO1FBQzFELENBQUM7YUFBTSxDQUFDO1lBQ04sSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsd0JBQXdCLEtBQUssQ0FBQyxTQUFTLEdBQUcsQ0FBQyxDQUFDO1FBQ2xFLENBQUM7UUFDRCxJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDeEMsQ0FBQztJQUVELE1BQU0sQ0FBQyxLQUFvQjtRQUN6QixJQUFJLEtBQUssQ0FBQyxXQUFXLEVBQUUsQ0FBQztZQUN0QixJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxjQUFjLEtBQUssQ0FBQyxXQUFXLEdBQUcsQ0FBQyxDQUFDO1FBQzFELENBQUM7YUFBTSxDQUFDO1lBQ04sSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsd0JBQXdCLEtBQUssQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1FBQzNELENBQUM7UUFDRCxJ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O2lCQUNELElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztZQUNkLFFBQVEsSUFBSSx1QkFBdUIsWUFBWSxHQUFHLENBQUM7UUFDckQsQ0FBQztRQUVELElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDO1FBQzlCLElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUN4QyxDQUFDO0lBRUQsT0FBTyxDQUFDLEtBQXFCO1FBQzNCLElBQUksQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLHVCQUF1QixLQUFLLENBQUMsU0FBUyxHQUFHLENBQUMsQ0FBQztRQUMvRCxJQUFJLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDeEMsQ0FBQztJQUVELFFBQVEsQ0FBQyxLQUFzQjtRQUM3QixNQUFNLE1BQU0sR0FBRyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQztRQUNyRCxJQUFJLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyx3QkFBd0IsS0FBSyxDQUFDLFNBQVMsR0FBRyxNQUFNLEVBQUUsQ0FBQyxDQUFDO1FBQ3hFLElBQUksQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsQ0FBQztJQUN4QyxDQUFDO0lBRUQseURBQXlEO0lBQ3pELFlBQVk7UUFDVixPQUFPLENBQUMsR0FBRyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDN0IsQ0FBQztJQUVELGtFQUFrRTtJQUNsRSxLQUFLO1FBQ0gsSUFBSSxDQUFDLFNBQVMsR0FBRyxFQUFFLENBQUM7UUFDcEIsSUFBSSxDQUFDLFVBQVUsR0FBRyxFQUFFLENBQUM7SUFDdkIsQ0FBQztDQUNGO0FBekhELHNEQXlIQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogTmFycmF0aXZlRmxvd1JlY29yZGVyIOKAlCBEZWZhdWx0IEZsb3dSZWNvcmRlciB0aGF0IGdlbmVyYXRlcyBwbGFpbi1FbmdsaXNoIG5hcnJhdGl2ZS5cbiAqXG4gKiBUaGlzIGlzIHRoZSBGbG93UmVjb3JkZXIgZXF1aXZhbGVudCBvZiBDb250cm9sRmxvd05hcnJhdGl2ZUdlbmVyYXRvci5cbiAqIFByb2R1Y2VzIHRoZSBzYW1lIHNlbnRlbmNlcywgc2FtZSBmb3JtYXQsIHNhbWUgYmVoYXZpb3Ig4oCUIGJ1dCBhcyBhXG4gKiBwbHVnZ2FibGUgRmxvd1JlY29yZGVyIHRoYXQgY2FuIGJlIHN3YXBwZWQsIGV4dGVuZGVkLCBvciBjb21wb3NlZC5cbiAqXG4gKiBDb25zdW1lcnMgd2hvIHdhbnQgZGlmZmVyZW50IG5hcnJhdGl2ZSBiZWhhdmlvciAod2luZG93ZWQgbG9vcHMsIGFkYXB0aXZlXG4gKiBzdW1tYXJpemF0aW9uLCBldGMuKSBjYW4gcmVwbGFjZSB0aGlzIHdpdGggYSBkaWZmZXJlbnQgRmxvd1JlY29yZGVyLlxuICovXG5cbmltcG9ydCB0eXBlIHtcbiAgRmxvd0JyZWFrRXZlbnQsXG4gIEZsb3dEZWNpc2lvbkV2ZW50LFxuICBGbG93RXJyb3JFdmVudCxcbiAgRmxvd0ZvcmtFdmVudCxcbiAgRmxvd0xvb3BFdmVudCxcbiAgRmxvd05leHRFdmVudCxcbiAgRmxvd1BhdXNlRXZlbnQsXG4gIEZsb3dSZWNvcmRlcixcbiAgRmxvd1Jlc3VtZUV2ZW50LFxuICBGbG93U2VsZWN0ZWRFdmVudCxcbiAgRmxvd1N0YWdlRXZlbnQsXG4gIEZsb3dTdWJmbG93RXZlbnQsXG59IGZyb20gJy4vdHlwZXMuanMnO1xuXG5leHBvcnQgY2xhc3MgTmFycmF0aXZlRmxvd1JlY29yZGVyIGltcGxlbWVudHMgRmxvd1JlY29yZGVyIHtcbiAgcmVhZG9ubHkgaWQ6IHN0cmluZztcbiAgcHJpdmF0ZSBzZW50ZW5jZXM6IHN0cmluZ1tdID0gW107XG4gIC8qKiBQYXJhbGxlbCBhcnJheTogdGhlIGFjdHVhbCBzdGFnZSBuYW1lIHRoYXQgcHJvZHVjZWQgZWFjaCBzZW50ZW5jZS4gKi9cbiAgcHJpdmF0ZSBzdGFnZU5hbWVzOiAoc3RyaW5nIHwgdW5kZWZpbmVkKVtdID0gW107XG5cbiAgY29uc3RydWN0b3IoaWQ/OiBzdHJpbmcpIHtcbiAgICB0aGlzLmlkID0gaWQgPz8gJ25hcnJhdGl2ZSc7XG4gIH1cblxuICBvblN0YWdlRXhlY3V0ZWQoZXZlbnQ6IEZsb3dTdGFnZUV2ZW50KTogdm9pZCB7XG4gICAgaWYgKGV2ZW50LmRlc2NyaXB0aW9uKSB7XG4gICAgICB0aGlzLnNlbnRlbmNlcy5wdXNoKGBOZXh0IHN0ZXA6ICR7ZXZlbnQuZGVzY3JpcHRpb259LmApO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnNlbnRlbmNlcy5wdXNoKGBOZXh0LCBpdCBtb3ZlZCBvbiB0byAke2V2ZW50LnN0YWdlTmFtZX0uYCk7XG4gICAgfVxuICAgIHRoaXMuc3RhZ2VOYW1lcy5wdXNoKGV2ZW50LnN0YWdlTmFtZSk7XG4gIH1cblxuICBvbk5leHQoZXZlbnQ6IEZsb3dOZXh0RXZlbnQpOiB2b2lkIHtcbiAgICBpZiAoZXZlbnQuZGVzY3JpcHRpb24pIHtcbiAgICAgIHRoaXMuc2VudGVuY2VzLnB1c2goYE5leHQgc3RlcDogJHtldmVudC5kZXNjcmlwdGlvbn0uYCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuc2VudGVuY2VzLnB1c2goYE5leHQsIGl0IG1vdmVkIG9uIHRvICR7ZXZlbnQudG99LmApO1xuICAgIH1cbiAgICB0aGlzLnN0YWdlTmFtZXMucHVzaChldmVudC50byk7XG4gIH1cblxuICBvbkRlY2lzaW9uKGV2ZW50OiBGbG93RGVjaXNpb25FdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IGJyYW5jaE5hbWUgPSBldmVudC5jaG9zZW47XG4gICAgaWYgKGV2ZW50LmRlc2NyaXB0aW9uICYmIGV2ZW50LnJhdGlvbmFsZSkge1xuICAgICAgdGhpcy5zZW50ZW5jZXMucHVzaChgSXQgJHtldmVudC5kZXNjcmlwdGlvbn06ICR7ZXZlbnQucmF0aW9uYWxlfSwgc28gaXQgY2hvc2UgJHticmFuY2hOYW1lfS5gKTtcbiAgICB9IGVsc2UgaWYgKGV2ZW50LmRlc2NyaXB0aW9uKSB7XG4gICAgICB0aGlzLnNlbnRlbmNlcy5wdXNoKGBJdCAke2V2ZW50LmRlc2NyaXB0aW9ufSBhbmQgY2hvc2UgJHticmFuY2hOYW1lfS5gKTtcbiAgICB9IGVsc2UgaWYgKGV2ZW50LnJhdGlvbmFsZSkge1xuICAgICAgdGhpcy5zZW50ZW5jZXMucHVzaChgQSBkZWNpc2lvbiB3YXMgbWFkZTogJHtldmVudC5yYXRpb25hbGV9LCBzbyB0aGUgcGF0aCB0YWtlbiB3YXMgJHticmFuY2hOYW1lfS5gKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zZW50ZW5jZXMucHVzaChgQSBkZWNpc2lvbiB3YXMgbWFkZSwgYW5kIHRoZSBwYXRoIHRha2VuIHdhcyAke2JyYW5jaE5hbWV9LmApO1xuICAgIH1cbiAgICB0aGlzLnN0YWdlTmFtZXMucHVzaChldmVudC5kZWNpZGVyKTtcbiAgfVxuXG4gIG9uRm9yayhldmVudDogRmxvd0ZvcmtFdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IG5hbWVzID0gZXZlbnQuY2hpbGRyZW4uam9pbignLCAnKTtcbiAgICB0aGlzLnNlbnRlbmNlcy5wdXNoKGBGb3JraW5nIGludG8gJHtldmVudC5jaGlsZHJlbi5sZW5ndGh9IHBhcmFsbGVsIHBhdGhzOiAke25hbWVzfS5gKTtcbiAgICB0aGlzLnN0YWdlTmFtZXMucHVzaCh1bmRlZmluZWQpO1xuICB9XG5cbiAgb25TZWxlY3RlZChldmVudDogRmxvd1NlbGVjdGVkRXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBuYW1lcyA9IGV2ZW50LnNlbGVjdGVkLmpvaW4oJywgJyk7XG4gICAgdGhpcy5zZW50ZW5jZXMucHVzaChgJHtldmVudC5zZWxlY3RlZC5sZW5ndGh9IG9mICR7ZXZlbnQudG90YWx9IHBhdGhzIHdlcmUgc2VsZWN0ZWQ6ICR7bmFtZXN9LmApO1xuICAgIHRoaXMuc3RhZ2VOYW1lcy5wdXNoKHVuZGVmaW5lZCk7XG4gIH1cblxuICBvblN1YmZsb3dFbnRyeShldmVudDogRmxvd1N1YmZsb3dFdmVudCk6IHZvaWQge1xuICAgIGlmIChldmVudC5kZXNjcmlwdGlvbikge1xuICAgICAgdGhpcy5zZW50ZW5jZXMucHVzaChgRW50ZXJpbmcgdGhlICR7ZXZlbnQubmFtZX0gc3ViZmxvdzogJHtldmVudC5kZXNjcmlwdGlvbn0uYCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuc2VudGVuY2VzLnB1c2goYEVudGVyaW5nIHRoZSAke2V2ZW50Lm5hbWV9IHN1YmZsb3cuYCk7XG4gICAgfVxuICAgIHRoaXMuc3RhZ2VOYW1lcy5wdXNoKGV2ZW50Lm5hbWUpO1xuICB9XG5cbiAgb25TdWJmbG93RXhpdChldmVudDogRmxvd1N1YmZsb3dFdmVudCk6IHZvaWQge1xuICAgIHRoaXMuc2VudGVuY2VzLnB1c2goYEV4aXRpbmcgdGhlICR7ZXZlbnQubmFtZX0gc3ViZmxvdy5gKTtcbiAgICB0aGlzLnN0YWdlTmFtZXMucHVzaChldmVudC5uYW1lKTtcbiAgfVxuXG4gIG9uTG9vcChldmVudDogRmxvd0xvb3BFdmVudCk6IHZvaWQge1xuICAgIGlmIChldmVudC5kZXNjcmlwdGlvbikge1xuICAgICAgdGhpcy5zZW50ZW5jZXMucHVzaChgT24gcGFzcyAke2V2ZW50Lml0ZXJhdGlvbn06ICR7ZXZlbnQuZGVzY3JpcHRpb259IGFnYWluLmApO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnNlbnRlbmNlcy5wdXNoKGBPbiBwYXNzICR7ZXZlbnQuaXRlcmF0aW9ufSB0aHJvdWdoICR7ZXZlbnQudGFyZ2V0fS5gKTtcbiAgICB9XG4gICAgdGhpcy5zdGFnZU5hbWVzLnB1c2goZXZlbnQudGFyZ2V0KTtcbiAgfVxuXG4gIG9uQnJlYWsoZXZlbnQ6IEZsb3dCcmVha0V2ZW50KTogdm9pZCB7XG4gICAgdGhpcy5zZW50ZW5jZXMucHVzaChgRXhlY3V0aW9uIHN0b3BwZWQgYXQgJHtldmVudC5zdGFnZU5hbWV9LmApO1xuICAgIHRoaXMuc3RhZ2VOYW1lcy5wdXNoKGV2ZW50LnN0YWdlTmFtZSk7XG4gIH1cblxuICBvbkVycm9yKGV2ZW50OiBGbG93RXJyb3JFdmVudCk6IHZvaWQge1xuICAgIGxldCBzZW50ZW5jZSA9IGBBbiBlcnJvciBvY2N1cnJlZCBhdCAke2V2ZW50LnN0YWdlTmFtZX06ICR7ZXZlbnQubWVzc2FnZX0uYDtcblxuICAgIC8vIEVucmljaCB3aXRoIGZpZWxkLWxldmVsIGlzc3VlcyB3aGVuIGF2YWlsYWJsZVxuICAgIGlmIChldmVudC5zdHJ1Y3R1cmVkRXJyb3IuaXNzdWVzICYmIGV2ZW50LnN0cnVjdHVyZWRFcnJvci5pc3N1ZXMubGVuZ3RoID4gMCkge1xuICAgICAgY29uc3QgaXNzdWVEZXRhaWxzID0gZXZlbnQuc3RydWN0dXJlZEVycm9yLmlzc3Vlc1xuICAgICAgICAubWFwKChpc3N1ZSkgPT4ge1xuICAgICAgICAgIGNvbnN0IHBhdGggPSBpc3N1ZS5wYXRoLmxlbmd0aCA+IDAgPyBpc3N1ZS5wYXRoLmpvaW4oJy4nKSA6ICcocm9vdCknO1xuICAgICAgICAgIHJldHVybiBgJHtwYXRofTogJHtpc3N1ZS5tZXNzYWdlfWA7XG4gICAgICAgIH0pXG4gICAgICAgIC5qb2luKCc7ICcpO1xuICAgICAgc2VudGVuY2UgKz0gYCBWYWxpZGF0aW9uIGlzc3VlczogJHtpc3N1ZURldGFpbHN9LmA7XG4gICAgfVxuXG4gICAgdGhpcy5zZW50ZW5jZXMucHVzaChzZW50ZW5jZSk7XG4gICAgdGhpcy5zdGFnZU5hbWVzLnB1c2goZXZlbnQuc3RhZ2VOYW1lKTtcbiAgfVxuXG4gIG9uUGF1c2UoZXZlbnQ6IEZsb3dQYXVzZUV2ZW50KTogdm9pZCB7XG4gICAgdGhpcy5zZW50ZW5jZXMucHVzaChgRXhlY3V0aW9uIHBhdXNlZCBhdCAke2V2ZW50LnN0YWdlTmFtZX0uYCk7XG4gICAgdGhpcy5zdGFnZU5hbWVzLnB1c2goZXZlbnQuc3RhZ2VOYW1lKTtcbiAgfVxuXG4gIG9uUmVzdW1lKGV2ZW50OiBGbG93UmVzdW1lRXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBzdWZmaXggPSBldmVudC5oYXNJbnB1dCA/ICcgd2l0aCBpbnB1dC4nIDogJy4nO1xuICAgIHRoaXMuc2VudGVuY2VzLnB1c2goYEV4ZWN1dGlvbiByZXN1bWVkIGF0ICR7ZXZlbnQuc3RhZ2VOYW1lfSR7c3VmZml4fWApO1xuICAgIHRoaXMuc3RhZ2VOYW1lcy5wdXNoKGV2ZW50LnN0YWdlTmFtZSk7XG4gIH1cblxuICAvKiogUmV0dXJucyBhIGRlZmVuc2l2ZSBjb3B5IG9mIGFjY3VtdWxhdGVkIHNlbnRlbmNlcy4gKi9cbiAgZ2V0U2VudGVuY2VzKCk6IHN0cmluZ1tdIHtcbiAgICByZXR1cm4gWy4uLnRoaXMuc2VudGVuY2VzXTtcbiAgfVxuXG4gIC8qKiBDbGVhcnMgYWNjdW11bGF0ZWQgc2VudGVuY2VzLiBVc2VmdWwgZm9yIHJldXNlIGFjcm9zcyBydW5zLiAqL1xuICBjbGVhcigpOiB2b2lkIHtcbiAgICB0aGlzLnNlbnRlbmNlcyA9IFtdO1xuICAgIHRoaXMuc3RhZ2VOYW1lcyA9IFtdO1xuICB9XG59XG4iXX0=