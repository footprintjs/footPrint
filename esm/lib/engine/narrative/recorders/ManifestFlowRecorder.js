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
export class ManifestFlowRecorder {
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiTWFuaWZlc3RGbG93UmVjb3JkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi9zcmMvbGliL2VuZ2luZS9uYXJyYXRpdmUvcmVjb3JkZXJzL01hbmlmZXN0Rmxvd1JlY29yZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztHQXVCRztBQWdCSCxNQUFNLE9BQU8sb0JBQW9CO0lBVS9CLFlBQVksRUFBVztRQVB2QixvRUFBb0U7UUFDNUQsVUFBSyxHQUFvQixFQUFFLENBQUM7UUFDcEMsK0RBQStEO1FBQ3ZELFVBQUssR0FBb0IsRUFBRSxDQUFDO1FBQ3BDLDBEQUEwRDtRQUNsRCxVQUFLLEdBQUcsSUFBSSxHQUFHLEVBQW1CLENBQUM7UUFHekMsSUFBSSxDQUFDLEVBQUUsR0FBRyxFQUFFLGFBQUYsRUFBRSxjQUFGLEVBQUUsR0FBSSxVQUFVLENBQUM7SUFDN0IsQ0FBQztJQUVELGNBQWMsQ0FBQyxLQUF1Qjs7UUFDcEMsTUFBTSxLQUFLLEdBQWtCO1lBQzNCLFNBQVMsRUFBRSxNQUFBLEtBQUssQ0FBQyxTQUFTLG1DQUFJLEtBQUssQ0FBQyxJQUFJO1lBQ3hDLElBQUksRUFBRSxLQUFLLENBQUMsSUFBSTtZQUNoQixXQUFXLEVBQUUsS0FBSyxDQUFDLFdBQVc7WUFDOUIsUUFBUSxFQUFFLEVBQUU7U0FDYixDQUFDO1FBQ0YsSUFBSSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUM7SUFDekIsQ0FBQztJQUVELGFBQWEsQ0FBQyxNQUF3QjtRQUNwQyxNQUFNLFNBQVMsR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLEdBQUcsRUFBRSxDQUFDO1FBQ25DLElBQUksQ0FBQyxTQUFTO1lBQUUsT0FBTztRQUV2QixNQUFNLE1BQU0sR0FBRyxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxHQUFHLENBQUMsQ0FBQyxDQUFDO1FBQ2pELElBQUksTUFBTSxFQUFFLENBQUM7WUFDWCxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQztRQUNsQyxDQUFDO2FBQU0sQ0FBQztZQUNOLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQzdCLENBQUM7SUFDSCxDQUFDO0lBRUQsbUJBQW1CLENBQUMsS0FBaUM7UUFDbkQsSUFBSSxLQUFLLENBQUMsYUFBYSxJQUFJLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUM7WUFDNUQsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLFNBQVMsRUFBRSxLQUFLLENBQUMsYUFBYSxDQUFDLENBQUM7UUFDdkQsQ0FBQztJQUNILENBQUM7SUFFRCxnRkFBZ0Y7SUFDaEYsV0FBVztRQUNULE9BQU8sQ0FBQyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUN6QixDQUFDO0lBRUQ7Ozs7OztPQU1HO0lBQ0gsT0FBTyxDQUFDLFNBQWlCO1FBQ3ZCLE9BQU8sSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDbkMsQ0FBQztJQUVELG1DQUFtQztJQUNuQyxVQUFVO1FBQ1IsT0FBTyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQztJQUN2QyxDQUFDO0lBRUQsVUFBVTtRQUNSLE9BQU8sRUFBRSxJQUFJLEVBQUUsVUFBVSxFQUFFLElBQUksRUFBRSxJQUFJLENBQUMsV0FBVyxFQUFFLEVBQUUsQ0FBQztJQUN4RCxDQUFDO0lBRUQsOEJBQThCO0lBQzlCLEtBQUs7UUFDSCxJQUFJLENBQUMsS0FBSyxHQUFHLEVBQUUsQ0FBQztRQUNoQixJQUFJLENBQUMsS0FBSyxHQUFHLEVBQUUsQ0FBQztRQUNoQixJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxDQUFDO0lBQ3JCLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogTWFuaWZlc3RGbG93UmVjb3JkZXIg4oCUIEJ1aWxkcyBhIGxpZ2h0d2VpZ2h0IHN1YmZsb3cgbWFuaWZlc3QgZHVyaW5nIHRyYXZlcnNhbC5cbiAqXG4gKiBDb2xsZWN0cyBzdWJmbG93IG1ldGFkYXRhIChJRCwgbmFtZSwgZGVzY3JpcHRpb24pIGFzIGEgc2lkZSBlZmZlY3Qgb2ZcbiAqIG9ic2VydmluZyB0cmF2ZXJzYWwgZXZlbnRzLiBQcm9kdWNlcyBhIHRyZWUgc3RydWN0dXJlIHN1aXRhYmxlIGZvciBMTE1cbiAqIG5hdmlnYXRpb246IGxpZ2h0d2VpZ2h0IGVub3VnaCB0byBpbmNsdWRlIGluIHNuYXBzaG90cywgd2l0aCBvbi1kZW1hbmRcbiAqIGFjY2VzcyB0byBmdWxsIHNwZWNzIHZpYSBnZXRTcGVjKCkuXG4gKlxuICogVGhlIG1hbmlmZXN0IHJlZmxlY3RzIG9ubHkgc3ViZmxvd3MgdGhhdCB3ZXJlIGFjdHVhbGx5IGVudGVyZWQgZHVyaW5nXG4gKiBleGVjdXRpb24g4oCUIHVudmlzaXRlZCBicmFuY2hlcyBhcmUgbm90IGluY2x1ZGVkLlxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiBjb25zdCBtYW5pZmVzdCA9IG5ldyBNYW5pZmVzdEZsb3dSZWNvcmRlcigpO1xuICogZXhlY3V0b3IuYXR0YWNoRmxvd1JlY29yZGVyKG1hbmlmZXN0KTtcbiAqIGF3YWl0IGV4ZWN1dG9yLnJ1bih7IGlucHV0OiBkYXRhIH0pO1xuICpcbiAqIC8vIExpZ2h0d2VpZ2h0IHRyZWUgb2Ygc3ViZmxvdyBJRHMgKyBkZXNjcmlwdGlvbnNcbiAqIGNvbnN0IHRyZWUgPSBtYW5pZmVzdC5nZXRNYW5pZmVzdCgpO1xuICpcbiAqIC8vIEZ1bGwgc3BlYyBmb3IgYSBzcGVjaWZpYyBzdWJmbG93IChpZiBhdmFpbGFibGUpXG4gKiBjb25zdCBzcGVjID0gbWFuaWZlc3QuZ2V0U3BlYygnc2YtY3JlZGl0LWNoZWNrJyk7XG4gKiBgYGBcbiAqL1xuXG5pbXBvcnQgdHlwZSB7IEZsb3dSZWNvcmRlciwgRmxvd1N1YmZsb3dFdmVudCwgRmxvd1N1YmZsb3dSZWdpc3RlcmVkRXZlbnQgfSBmcm9tICcuLi90eXBlcy5qcyc7XG5cbi8qKiBBIHNpbmdsZSBlbnRyeSBpbiB0aGUgc3ViZmxvdyBtYW5pZmVzdCB0cmVlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBNYW5pZmVzdEVudHJ5IHtcbiAgLyoqIFN1YmZsb3cgaWRlbnRpZmllciDigJQgdXNlIGZvciBvbi1kZW1hbmQgc3BlYyBsb29rdXAuICovXG4gIHN1YmZsb3dJZDogc3RyaW5nO1xuICAvKiogSHVtYW4tcmVhZGFibGUgbmFtZS4gKi9cbiAgbmFtZTogc3RyaW5nO1xuICAvKiogQnVpbGQtdGltZSBkZXNjcmlwdGlvbiBvZiB3aGF0IHRoaXMgc3ViZmxvdyBkb2VzLiAqL1xuICBkZXNjcmlwdGlvbj86IHN0cmluZztcbiAgLyoqIE5lc3RlZCBzdWJmbG93cyBlbnRlcmVkIHdpdGhpbiB0aGlzIHN1YmZsb3cuICovXG4gIGNoaWxkcmVuOiBNYW5pZmVzdEVudHJ5W107XG59XG5cbmV4cG9ydCBjbGFzcyBNYW5pZmVzdEZsb3dSZWNvcmRlciBpbXBsZW1lbnRzIEZsb3dSZWNvcmRlciB7XG4gIHJlYWRvbmx5IGlkOiBzdHJpbmc7XG5cbiAgLyoqIFN0YWNrIHRyYWNrcyBuZXN0aW5nIGRlcHRoIOKAlCBjdXJyZW50IHN1YmZsb3cgaXMgdG9wIG9mIHN0YWNrLiAqL1xuICBwcml2YXRlIHN0YWNrOiBNYW5pZmVzdEVudHJ5W10gPSBbXTtcbiAgLyoqIFJvb3QtbGV2ZWwgc3ViZmxvd3MgKG5vdCBuZXN0ZWQgaW5zaWRlIGFub3RoZXIgc3ViZmxvdykuICovXG4gIHByaXZhdGUgcm9vdHM6IE1hbmlmZXN0RW50cnlbXSA9IFtdO1xuICAvKiogRnVsbCBzcGVjcyBzdG9yZWQgZnJvbSBkeW5hbWljIHJlZ2lzdHJhdGlvbiBldmVudHMuICovXG4gIHByaXZhdGUgc3BlY3MgPSBuZXcgTWFwPHN0cmluZywgdW5rbm93bj4oKTtcblxuICBjb25zdHJ1Y3RvcihpZD86IHN0cmluZykge1xuICAgIHRoaXMuaWQgPSBpZCA/PyAnbWFuaWZlc3QnO1xuICB9XG5cbiAgb25TdWJmbG93RW50cnkoZXZlbnQ6IEZsb3dTdWJmbG93RXZlbnQpOiB2b2lkIHtcbiAgICBjb25zdCBlbnRyeTogTWFuaWZlc3RFbnRyeSA9IHtcbiAgICAgIHN1YmZsb3dJZDogZXZlbnQuc3ViZmxvd0lkID8/IGV2ZW50Lm5hbWUsXG4gICAgICBuYW1lOiBldmVudC5uYW1lLFxuICAgICAgZGVzY3JpcHRpb246IGV2ZW50LmRlc2NyaXB0aW9uLFxuICAgICAgY2hpbGRyZW46IFtdLFxuICAgIH07XG4gICAgdGhpcy5zdGFjay5wdXNoKGVudHJ5KTtcbiAgfVxuXG4gIG9uU3ViZmxvd0V4aXQoX2V2ZW50OiBGbG93U3ViZmxvd0V2ZW50KTogdm9pZCB7XG4gICAgY29uc3QgY29tcGxldGVkID0gdGhpcy5zdGFjay5wb3AoKTtcbiAgICBpZiAoIWNvbXBsZXRlZCkgcmV0dXJuO1xuXG4gICAgY29uc3QgcGFyZW50ID0gdGhpcy5zdGFja1t0aGlzLnN0YWNrLmxlbmd0aCAtIDFdO1xuICAgIGlmIChwYXJlbnQpIHtcbiAgICAgIHBhcmVudC5jaGlsZHJlbi5wdXNoKGNvbXBsZXRlZCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMucm9vdHMucHVzaChjb21wbGV0ZWQpO1xuICAgIH1cbiAgfVxuXG4gIG9uU3ViZmxvd1JlZ2lzdGVyZWQoZXZlbnQ6IEZsb3dTdWJmbG93UmVnaXN0ZXJlZEV2ZW50KTogdm9pZCB7XG4gICAgaWYgKGV2ZW50LnNwZWNTdHJ1Y3R1cmUgJiYgIXRoaXMuc3BlY3MuaGFzKGV2ZW50LnN1YmZsb3dJZCkpIHtcbiAgICAgIHRoaXMuc3BlY3Muc2V0KGV2ZW50LnN1YmZsb3dJZCwgZXZlbnQuc3BlY1N0cnVjdHVyZSk7XG4gICAgfVxuICB9XG5cbiAgLyoqIFJldHVybnMgdGhlIG1hbmlmZXN0IHRyZWUg4oCUIGxpZ2h0d2VpZ2h0LCBzdWl0YWJsZSBmb3Igc25hcHNob3QgaW5jbHVzaW9uLiAqL1xuICBnZXRNYW5pZmVzdCgpOiBNYW5pZmVzdEVudHJ5W10ge1xuICAgIHJldHVybiBbLi4udGhpcy5yb290c107XG4gIH1cblxuICAvKipcbiAgICogUmV0dXJucyB0aGUgZnVsbCBzcGVjIGZvciBhIGR5bmFtaWNhbGx5LXJlZ2lzdGVyZWQgc3ViZmxvdy5cbiAgICogT25seSBwb3B1bGF0ZWQgZm9yIHN1YmZsb3dzIGF1dG8tcmVnaXN0ZXJlZCBhdCBydW50aW1lICh2aWEgU3RhZ2VOb2RlXG4gICAqIHJldHVybiB3aXRoIHN1YmZsb3dEZWYpLiBTdGF0aWNhbGx5LWNvbmZpZ3VyZWQgc3ViZmxvd3MgYXJlIG5vdCBpbmNsdWRlZFxuICAgKiBldmVuIGlmIHRoZXkgYXBwZWFyIGluIGdldE1hbmlmZXN0KCkuIFVzZSBGbG93Q2hhcnQuYnVpbGRUaW1lU3RydWN0dXJlXG4gICAqIHRvIGFjY2VzcyBzdGF0aWNhbGx5LWRlZmluZWQgc3ViZmxvdyBzcGVjcy5cbiAgICovXG4gIGdldFNwZWMoc3ViZmxvd0lkOiBzdHJpbmcpOiB1bmtub3duIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5zcGVjcy5nZXQoc3ViZmxvd0lkKTtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIGFsbCBzdG9yZWQgc3BlYyBJRHMuICovXG4gIGdldFNwZWNJZHMoKTogc3RyaW5nW10ge1xuICAgIHJldHVybiBBcnJheS5mcm9tKHRoaXMuc3BlY3Mua2V5cygpKTtcbiAgfVxuXG4gIHRvU25hcHNob3QoKTogeyBuYW1lOiBzdHJpbmc7IGRhdGE6IHVua25vd24gfSB7XG4gICAgcmV0dXJuIHsgbmFtZTogJ01hbmlmZXN0JywgZGF0YTogdGhpcy5nZXRNYW5pZmVzdCgpIH07XG4gIH1cblxuICAvKiogQ2xlYXJzIHN0YXRlIGZvciByZXVzZS4gKi9cbiAgY2xlYXIoKTogdm9pZCB7XG4gICAgdGhpcy5zdGFjayA9IFtdO1xuICAgIHRoaXMucm9vdHMgPSBbXTtcbiAgICB0aGlzLnNwZWNzLmNsZWFyKCk7XG4gIH1cbn1cbiJdfQ==