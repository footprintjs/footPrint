"use strict";
/**
 * ManifestFlowRecorder — Builds a lightweight subflow manifest during traversal.
 *
 * Collects subflow metadata (ID, name, description) as a side effect of
 * observing traversal events. Produces a tree structure suitable for LLM
 * navigation: lightweight enough to include in snapshots, with on-demand
 * access to full specs via getSpec().
 *
 * The manifest reflects only subflows that were actually entered during
 * execution — unvisited branches are not included.
 *
 * @example
 * ```typescript
 * const manifest = new ManifestFlowRecorder();
 * executor.attachFlowRecorder(manifest);
 * await executor.run({ input: data });
 *
 * // Lightweight tree of subflow IDs + descriptions
 * const tree = manifest.getManifest();
 *
 * // Full spec for a specific subflow (if available)
 * const spec = manifest.getSpec('sf-credit-check');
 * ```
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManifestFlowRecorder = void 0;
class ManifestFlowRecorder {
    constructor(id) {
        /** Stack tracks nesting depth — current subflow is top of stack. */
        this.stack = [];
        /** Root-level subflows (not nested inside another subflow). */
        this.roots = [];
        /** Full specs stored from dynamic registration events. */
        this.specs = new Map();
        this.id = id !== null && id !== void 0 ? id : 'manifest';
    }
    onSubflowEntry(event) {
        var _a;
        const entry = {
            subflowId: (_a = event.subflowId) !== null && _a !== void 0 ? _a : event.name,
            name: event.name,
            description: event.description,
            children: [],
        };
        this.stack.push(entry);
    }
    onSubflowExit(_event) {
        const completed = this.stack.pop();
        if (!completed)
            return;
        const parent = this.stack[this.stack.length - 1];
        if (parent) {
            parent.children.push(completed);
        }
        else {
            this.roots.push(completed);
        }
    }
    onSubflowRegistered(event) {
        if (event.specStructure && !this.specs.has(event.subflowId)) {
            this.specs.set(event.subflowId, event.specStructure);
        }
    }
    /** Returns the manifest tree — lightweight, suitable for snapshot inclusion. */
    getManifest() {
        return [...this.roots];
    }
    /**
     * Returns the full spec for a dynamically-registered subflow.
     * Only populated for subflows auto-registered at runtime (via StageNode
     * return with subflowDef). Statically-configured subflows are not included
     * even if they appear in getManifest(). Use FlowChart.buildTimeStructure
     * to access statically-defined subflow specs.
     */
    getSpec(subflowId) {
        return this.specs.get(subflowId);
    }
    /** Returns all stored spec IDs. */
    getSpecIds() {
        return Array.from(this.specs.keys());
    }
    toSnapshot() {
        return { name: 'Manifest', data: this.getManifest() };
    }
    /** Clears state for reuse. */
    clear() {
        this.stack = [];
        this.roots = [];
        this.specs.clear();
    }
}
exports.ManifestFlowRecorder = ManifestFlowRecorder;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTWFuaWZlc3RGbG93UmVjb3JkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9uYXJyYXRpdmUvcmVjb3JkZXJzL01hbmlmZXN0Rmxvd1JlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7R0F1Qkc7OztBQWdCSCxNQUFhLG9CQUFvQjtJQVUvQixZQUFZLEVBQVc7UUFQdkIsb0VBQW9FO1FBQzVELFVBQUssR0FBb0IsRUFBRSxDQUFDO1FBQ3BDLCtEQUErRDtRQUN2RCxVQUFLLEdBQW9CLEVBQUUsQ0FBQztRQUNwQywwREFBMEQ7UUFDbEQsVUFBSyxHQUFHLElBQUksR0FBRyxFQUFtQixDQUFDO1FBR3pDLElBQUksQ0FBQyxFQUFFLEdBQUcsRUFBRSxhQUFGLEVBQUUsY0FBRixFQUFFLEdBQUksVUFBVSxDQUFDO0lBQzdCLENBQUM7SUFFRCxjQUFjLENBQUMsS0FBdUI7O1FBQ3BDLE1BQU0sS0FBSyxHQUFrQjtZQUMzQixTQUFTLEVBQUUsTUFBQSxLQUFLLENBQUMsU0FBUyxtQ0FBSSxLQUFLLENBQUMsSUFBSTtZQUN4QyxJQUFJLEVBQUUsS0FBSyxDQUFDLElBQUk7WUFDaEIsV0FBVyxFQUFFLEtBQUssQ0FBQyxXQUFXO1lBQzlCLFFBQVEsRUFBRSxFQUFFO1NBQ2IsQ0FBQztRQUNGLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ3pCLENBQUM7SUFFRCxhQUFhLENBQUMsTUFBd0I7UUFDcEMsTUFBTSxTQUFTLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUNuQyxJQUFJLENBQUMsU0FBUztZQUFFLE9BQU87UUFFdkIsTUFBTSxNQUFNLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sR0FBRyxDQUFDLENBQUMsQ0FBQztRQUNqRCxJQUFJLE1BQU0sRUFBRSxDQUFDO1lBQ1gsTUFBTSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUM7UUFDbEMsQ0FBQzthQUFNLENBQUM7WUFDTixJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUM3QixDQUFDO0lBQ0gsQ0FBQztJQUVELG1CQUFtQixDQUFDLEtBQWlDO1FBQ25ELElBQUksS0FBSyxDQUFDLGFBQWEsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDO1lBQzVELElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxTQUFTLEVBQUUsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDO1FBQ3ZELENBQUM7SUFDSCxDQUFDO0lBRUQsZ0ZBQWdGO0lBQ2hGLFdBQVc7UUFDVCxPQUFPLENBQUMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDekIsQ0FBQztJQUVEOzs7Ozs7T0FNRztJQUNILE9BQU8sQ0FBQyxTQUFpQjtRQUN2QixPQUFPLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDO0lBQ25DLENBQUM7SUFFRCxtQ0FBbUM7SUFDbkMsVUFBVTtRQUNSLE9BQU8sS0FBSyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7SUFDdkMsQ0FBQztJQUVELFVBQVU7UUFDUixPQUFPLEVBQUUsSUFBSSxFQUFFLFVBQVUsRUFBRSxJQUFJLEVBQUUsSUFBSSxDQUFDLFdBQVcsRUFBRSxFQUFFLENBQUM7SUFDeEQsQ0FBQztJQUVELDhCQUE4QjtJQUM5QixLQUFLO1FBQ0gsSUFBSSxDQUFDLEtBQUssR0FBRyxFQUFFLENBQUM7UUFDaEIsSUFBSSxDQUFDLEtBQUssR0FBRyxFQUFFLENBQUM7UUFDaEIsSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUNyQixDQUFDO0NBQ0Y7QUF6RUQsb0RBeUVDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBNYW5pZmVzdEZsb3dSZWNvcmRlciDigJQgQnVpbGRzIGEgbGlnaHR3ZWlnaHQgc3ViZmxvdyBtYW5pZmVzdCBkdXJpbmcgdHJhdmVyc2FsLlxuICpcbiAqIENvbGxlY3RzIHN1YmZsb3cgbWV0YWRhdGEgKElELCBuYW1lLCBkZXNjcmlwdGlvbikgYXMgYSBzaWRlIGVmZmVjdCBvZlxuICogb2JzZXJ2aW5nIHRyYXZlcnNhbCBldmVudHMuIFByb2R1Y2VzIGEgdHJlZSBzdHJ1Y3R1cmUgc3VpdGFibGUgZm9yIExMTVxuICogbmF2aWdhdGlvbjogbGlnaHR3ZWlnaHQgZW5vdWdoIHRvIGluY2x1ZGUgaW4gc25hcHNob3RzLCB3aXRoIG9uLWRlbWFuZFxuICogYWNjZXNzIHRvIGZ1bGwgc3BlY3MgdmlhIGdldFNwZWMoKS5cbiAqXG4gKiBUaGUgbWFuaWZlc3QgcmVmbGVjdHMgb25seSBzdWJmbG93cyB0aGF0IHdlcmUgYWN0dWFsbHkgZW50ZXJlZCBkdXJpbmdcbiAqIGV4ZWN1dGlvbiDigJQgdW52aXNpdGVkIGJyYW5jaGVzIGFyZSBub3QgaW5jbHVkZWQuXG4gKlxuICogQGV4YW1wbGVcbiAqIGBgYHR5cGVzY3JpcHRcbiAqIGNvbnN0IG1hbmlmZXN0ID0gbmV3IE1hbmlmZXN0Rmxvd1JlY29yZGVyKCk7XG4gKiBleGVjdXRvci5hdHRhY2hGbG93UmVjb3JkZXIobWFuaWZlc3QpO1xuICogYXdhaXQgZXhlY3V0b3IucnVuKHsgaW5wdXQ6IGRhdGEgfSk7XG4gKlxuICogLy8gTGlnaHR3ZWlnaHQgdHJlZSBvZiBzdWJmbG93IElEcyArIGRlc2NyaXB0aW9uc1xuICogY29uc3QgdHJlZSA9IG1hbmlmZXN0LmdldE1hbmlmZXN0KCk7XG4gKlxuICogLy8gRnVsbCBzcGVjIGZvciBhIHNwZWNpZmljIHN1YmZsb3cgKGlmIGF2YWlsYWJsZSlcbiAqIGNvbnN0IHNwZWMgPSBtYW5pZmVzdC5nZXRTcGVjKCdzZi1jcmVkaXQtY2hlY2snKTtcbiAqIGBgYFxuICovXG5cbmltcG9ydCB0eXBlIHsgRmxvd1JlY29yZGVyLCBGbG93U3ViZmxvd0V2ZW50LCBGbG93U3ViZmxvd1JlZ2lzdGVyZWRFdmVudCB9IGZyb20gJy4uL3R5cGVzLmpzJztcblxuLyoqIEEgc2luZ2xlIGVudHJ5IGluIHRoZSBzdWJmbG93IG1hbmlmZXN0IHRyZWUuICovXG5leHBvcnQgaW50ZXJmYWNlIE1hbmlmZXN0RW50cnkge1xuICAvKiogU3ViZmxvdyBpZGVudGlmaWVyIOKAlCB1c2UgZm9yIG9uLWRlbWFuZCBzcGVjIGxvb2t1cC4gKi9cbiAgc3ViZmxvd0lkOiBzdHJpbmc7XG4gIC8qKiBIdW1hbi1yZWFkYWJsZSBuYW1lLiAqL1xuICBuYW1lOiBzdHJpbmc7XG4gIC8qKiBCdWlsZC10aW1lIGRlc2NyaXB0aW9uIG9mIHdoYXQgdGhpcyBzdWJmbG93IGRvZXMuICovXG4gIGRlc2NyaXB0aW9uPzogc3RyaW5nO1xuICAvKiogTmVzdGVkIHN1YmZsb3dzIGVudGVyZWQgd2l0aGluIHRoaXMgc3ViZmxvdy4gKi9cbiAgY2hpbGRyZW46IE1hbmlmZXN0RW50cnlbXTtcbn1cblxuZXhwb3J0IGNsYXNzIE1hbmlmZXN0Rmxvd1JlY29yZGVyIGltcGxlbWVudHMgRmxvd1JlY29yZGVyIHtcbiAgcmVhZG9ubHkgaWQ6IHN0cmluZztcblxuICAvKiogU3RhY2sgdHJhY2tzIG5lc3RpbmcgZGVwdGgg4oCUIGN1cnJlbnQgc3ViZmxvdyBpcyB0b3Agb2Ygc3RhY2suICovXG4gIHByaXZhdGUgc3RhY2s6IE1hbmlmZXN0RW50cnlbXSA9IFtdO1xuICAvKiogUm9vdC1sZXZlbCBzdWJmbG93cyAobm90IG5lc3RlZCBpbnNpZGUgYW5vdGhlciBzdWJmbG93KS4gKi9cbiAgcHJpdmF0ZSByb290czogTWFuaWZlc3RFbnRyeVtdID0gW107XG4gIC8qKiBGdWxsIHNwZWNzIHN0b3JlZCBmcm9tIGR5bmFtaWMgcmVnaXN0cmF0aW9uIGV2ZW50cy4gKi9cbiAgcHJpdmF0ZSBzcGVjcyA9IG5ldyBNYXA8c3RyaW5nLCB1bmtub3duPigpO1xuXG4gIGNvbnN0cnVjdG9yKGlkPzogc3RyaW5nKSB7XG4gICAgdGhpcy5pZCA9IGlkID8/ICdtYW5pZmVzdCc7XG4gIH1cblxuICBvblN1YmZsb3dFbnRyeShldmVudDogRmxvd1N1YmZsb3dFdmVudCk6IHZvaWQge1xuICAgIGNvbnN0IGVudHJ5OiBNYW5pZmVzdEVudHJ5ID0ge1xuICAgICAgc3ViZmxvd0lkOiBldmVudC5zdWJmbG93SWQgPz8gZXZlbnQubmFtZSxcbiAgICAgIG5hbWU6IGV2ZW50Lm5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogZXZlbnQuZGVzY3JpcHRpb24sXG4gICAgICBjaGlsZHJlbjogW10sXG4gICAgfTtcbiAgICB0aGlzLnN0YWNrLnB1c2goZW50cnkpO1xuICB9XG5cbiAgb25TdWJmbG93RXhpdChfZXZlbnQ6IEZsb3dTdWJmbG93RXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBjb21wbGV0ZWQgPSB0aGlzLnN0YWNrLnBvcCgpO1xuICAgIGlmICghY29tcGxldGVkKSByZXR1cm47XG5cbiAgICBjb25zdCBwYXJlbnQgPSB0aGlzLnN0YWNrW3RoaXMuc3RhY2subGVuZ3RoIC0gMV07XG4gICAgaWYgKHBhcmVudCkge1xuICAgICAgcGFyZW50LmNoaWxkcmVuLnB1c2goY29tcGxldGVkKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5yb290cy5wdXNoKGNvbXBsZXRlZCk7XG4gICAgfVxuICB9XG5cbiAgb25TdWJmbG93UmVnaXN0ZXJlZChldmVudDogRmxvd1N1YmZsb3dSZWdpc3RlcmVkRXZlbnQpOiB2b2lkIHtcbiAgICBpZiAoZXZlbnQuc3BlY1N0cnVjdHVyZSAmJiAhdGhpcy5zcGVjcy5oYXMoZXZlbnQuc3ViZmxvd0lkKSkge1xuICAgICAgdGhpcy5zcGVjcy5zZXQoZXZlbnQuc3ViZmxvd0lkLCBldmVudC5zcGVjU3RydWN0dXJlKTtcbiAgICB9XG4gIH1cblxuICAvKiogUmV0dXJucyB0aGUgbWFuaWZlc3QgdHJlZSDigJQgbGlnaHR3ZWlnaHQsIHN1aXRhYmxlIGZvciBzbmFwc2hvdCBpbmNsdXNpb24uICovXG4gIGdldE1hbmlmZXN0KCk6IE1hbmlmZXN0RW50cnlbXSB7XG4gICAgcmV0dXJuIFsuLi50aGlzLnJvb3RzXTtcbiAgfVxuXG4gIC8qKlxuICAgKiBSZXR1cm5zIHRoZSBmdWxsIHNwZWMgZm9yIGEgZHluYW1pY2FsbHktcmVnaXN0ZXJlZCBzdWJmbG93LlxuICAgKiBPbmx5IHBvcHVsYXRlZCBmb3Igc3ViZmxvd3MgYXV0by1yZWdpc3RlcmVkIGF0IHJ1bnRpbWUgKHZpYSBTdGFnZU5vZGVcbiAgICogcmV0dXJuIHdpdGggc3ViZmxvd0RlZikuIFN0YXRpY2FsbHktY29uZmlndXJlZCBzdWJmbG93cyBhcmUgbm90IGluY2x1ZGVkXG4gICAqIGV2ZW4gaWYgdGhleSBhcHBlYXIgaW4gZ2V0TWFuaWZlc3QoKS4gVXNlIEZsb3dDaGFydC5idWlsZFRpbWVTdHJ1Y3R1cmVcbiAgICogdG8gYWNjZXNzIHN0YXRpY2FsbHktZGVmaW5lZCBzdWJmbG93IHNwZWNzLlxuICAgKi9cbiAgZ2V0U3BlYyhzdWJmbG93SWQ6IHN0cmluZyk6IHVua25vd24gfCB1bmRlZmluZWQge1xuICAgIHJldHVybiB0aGlzLnNwZWNzLmdldChzdWJmbG93SWQpO1xuICB9XG5cbiAgLyoqIFJldHVybnMgYWxsIHN0b3JlZCBzcGVjIElEcy4gKi9cbiAgZ2V0U3BlY0lkcygpOiBzdHJpbmdbXSB7XG4gICAgcmV0dXJuIEFycmF5LmZyb20odGhpcy5zcGVjcy5rZXlzKCkpO1xuICB9XG5cbiAgdG9TbmFwc2hvdCgpOiB7IG5hbWU6IHN0cmluZzsgZGF0YTogdW5rbm93biB9IHtcbiAgICByZXR1cm4geyBuYW1lOiAnTWFuaWZlc3QnLCBkYXRhOiB0aGlzLmdldE1hbmlmZXN0KCkgfTtcbiAgfVxuXG4gIC8qKiBDbGVhcnMgc3RhdGUgZm9yIHJldXNlLiAqL1xuICBjbGVhcigpOiB2b2lkIHtcbiAgICB0aGlzLnN0YWNrID0gW107XG4gICAgdGhpcy5yb290cyA9IFtdO1xuICAgIHRoaXMuc3BlY3MuY2xlYXIoKTtcbiAgfVxufVxuIl19