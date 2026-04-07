/**
 * SilentNarrativeFlowRecorder — Suppresses all per-iteration loop sentences,
 * emits a single summary sentence at the end.
 *
 * Best for: Loops where iteration details are irrelevant and you only care
 * about the total count.
 *
 * @example
 * ```typescript
 * executor.attachFlowRecorder(new SilentNarrativeFlowRecorder());
 * // Produces: "Looped 50 times through AskLLM."
 * ```
 */
import { NarrativeFlowRecorder } from '../NarrativeFlowRecorder.js';
export class SilentNarrativeFlowRecorder extends NarrativeFlowRecorder {
    constructor(id) {
        super(id !== null && id !== void 0 ? id : 'narrative-silent');
        this.loopCounts = new Map();
        this.loopOrder = [];
    }
    onLoop(event) {
        var _a;
        // Don't call super — suppress all per-iteration sentences
        const count = ((_a = this.loopCounts.get(event.target)) !== null && _a !== void 0 ? _a : 0) + 1;
        if (!this.loopCounts.has(event.target)) {
            this.loopOrder.push(event.target);
        }
        this.loopCounts.set(event.target, count);
    }
    getSentences() {
        const base = super.getSentences();
        // Inject loop summaries at the end (or you could insert them in-place)
        const summaries = [];
        for (const target of this.loopOrder) {
            const count = this.loopCounts.get(target);
            summaries.push(`Looped ${count} time${count !== 1 ? 's' : ''} through ${target}.`);
        }
        return [...base, ...summaries];
    }
    /** Returns the total loop count per target. */
    getLoopCounts() {
        return new Map(this.loopCounts);
    }
    clear() {
        super.clear();
        this.loopCounts.clear();
        this.loopOrder = [];
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiU2lsZW50TmFycmF0aXZlRmxvd1JlY29yZGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vLi4vc3JjL2xpYi9lbmdpbmUvbmFycmF0aXZlL3JlY29yZGVycy9TaWxlbnROYXJyYXRpdmVGbG93UmVjb3JkZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7OztHQVlHO0FBRUgsT0FBTyxFQUFFLHFCQUFxQixFQUFFLE1BQU0sNkJBQTZCLENBQUM7QUFHcEUsTUFBTSxPQUFPLDJCQUE0QixTQUFRLHFCQUFxQjtJQUlwRSxZQUFZLEVBQVc7UUFDckIsS0FBSyxDQUFDLEVBQUUsYUFBRixFQUFFLGNBQUYsRUFBRSxHQUFJLGtCQUFrQixDQUFDLENBQUM7UUFKMUIsZUFBVSxHQUF3QixJQUFJLEdBQUcsRUFBRSxDQUFDO1FBQzVDLGNBQVMsR0FBYSxFQUFFLENBQUM7SUFJakMsQ0FBQztJQUVRLE1BQU0sQ0FBQyxLQUFvQjs7UUFDbEMsMERBQTBEO1FBQzFELE1BQU0sS0FBSyxHQUFHLENBQUMsTUFBQSxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLG1DQUFJLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUMzRCxJQUFJLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxHQUFHLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7WUFDdkMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQ3BDLENBQUM7UUFDRCxJQUFJLENBQUMsVUFBVSxDQUFDLEdBQUcsQ0FBQyxLQUFLLENBQUMsTUFBTSxFQUFFLEtBQUssQ0FBQyxDQUFDO0lBQzNDLENBQUM7SUFFUSxZQUFZO1FBQ25CLE1BQU0sSUFBSSxHQUFHLEtBQUssQ0FBQyxZQUFZLEVBQUUsQ0FBQztRQUVsQyx1RUFBdUU7UUFDdkUsTUFBTSxTQUFTLEdBQWEsRUFBRSxDQUFDO1FBQy9CLEtBQUssTUFBTSxNQUFNLElBQUksSUFBSSxDQUFDLFNBQVMsRUFBRSxDQUFDO1lBQ3BDLE1BQU0sS0FBSyxHQUFHLElBQUksQ0FBQyxVQUFVLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBRSxDQUFDO1lBQzNDLFNBQVMsQ0FBQyxJQUFJLENBQUMsVUFBVSxLQUFLLFFBQVEsS0FBSyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxFQUFFLFlBQVksTUFBTSxHQUFHLENBQUMsQ0FBQztRQUNyRixDQUFDO1FBRUQsT0FBTyxDQUFDLEdBQUcsSUFBSSxFQUFFLEdBQUcsU0FBUyxDQUFDLENBQUM7SUFDakMsQ0FBQztJQUVELCtDQUErQztJQUMvQyxhQUFhO1FBQ1gsT0FBTyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDLENBQUM7SUFDbEMsQ0FBQztJQUVRLEtBQUs7UUFDWixLQUFLLENBQUMsS0FBSyxFQUFFLENBQUM7UUFDZCxJQUFJLENBQUMsVUFBVSxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ3hCLElBQUksQ0FBQyxTQUFTLEdBQUcsRUFBRSxDQUFDO0lBQ3RCLENBQUM7Q0FDRiIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU2lsZW50TmFycmF0aXZlRmxvd1JlY29yZGVyIOKAlCBTdXBwcmVzc2VzIGFsbCBwZXItaXRlcmF0aW9uIGxvb3Agc2VudGVuY2VzLFxuICogZW1pdHMgYSBzaW5nbGUgc3VtbWFyeSBzZW50ZW5jZSBhdCB0aGUgZW5kLlxuICpcbiAqIEJlc3QgZm9yOiBMb29wcyB3aGVyZSBpdGVyYXRpb24gZGV0YWlscyBhcmUgaXJyZWxldmFudCBhbmQgeW91IG9ubHkgY2FyZVxuICogYWJvdXQgdGhlIHRvdGFsIGNvdW50LlxuICpcbiAqIEBleGFtcGxlXG4gKiBgYGB0eXBlc2NyaXB0XG4gKiBleGVjdXRvci5hdHRhY2hGbG93UmVjb3JkZXIobmV3IFNpbGVudE5hcnJhdGl2ZUZsb3dSZWNvcmRlcigpKTtcbiAqIC8vIFByb2R1Y2VzOiBcIkxvb3BlZCA1MCB0aW1lcyB0aHJvdWdoIEFza0xMTS5cIlxuICogYGBgXG4gKi9cblxuaW1wb3J0IHsgTmFycmF0aXZlRmxvd1JlY29yZGVyIH0gZnJvbSAnLi4vTmFycmF0aXZlRmxvd1JlY29yZGVyLmpzJztcbmltcG9ydCB0eXBlIHsgRmxvd0xvb3BFdmVudCB9IGZyb20gJy4uL3R5cGVzLmpzJztcblxuZXhwb3J0IGNsYXNzIFNpbGVudE5hcnJhdGl2ZUZsb3dSZWNvcmRlciBleHRlbmRzIE5hcnJhdGl2ZUZsb3dSZWNvcmRlciB7XG4gIHByaXZhdGUgbG9vcENvdW50czogTWFwPHN0cmluZywgbnVtYmVyPiA9IG5ldyBNYXAoKTtcbiAgcHJpdmF0ZSBsb29wT3JkZXI6IHN0cmluZ1tdID0gW107XG5cbiAgY29uc3RydWN0b3IoaWQ/OiBzdHJpbmcpIHtcbiAgICBzdXBlcihpZCA/PyAnbmFycmF0aXZlLXNpbGVudCcpO1xuICB9XG5cbiAgb3ZlcnJpZGUgb25Mb29wKGV2ZW50OiBGbG93TG9vcEV2ZW50KTogdm9pZCB7XG4gICAgLy8gRG9uJ3QgY2FsbCBzdXBlciDigJQgc3VwcHJlc3MgYWxsIHBlci1pdGVyYXRpb24gc2VudGVuY2VzXG4gICAgY29uc3QgY291bnQgPSAodGhpcy5sb29wQ291bnRzLmdldChldmVudC50YXJnZXQpID8/IDApICsgMTtcbiAgICBpZiAoIXRoaXMubG9vcENvdW50cy5oYXMoZXZlbnQudGFyZ2V0KSkge1xuICAgICAgdGhpcy5sb29wT3JkZXIucHVzaChldmVudC50YXJnZXQpO1xuICAgIH1cbiAgICB0aGlzLmxvb3BDb3VudHMuc2V0KGV2ZW50LnRhcmdldCwgY291bnQpO1xuICB9XG5cbiAgb3ZlcnJpZGUgZ2V0U2VudGVuY2VzKCk6IHN0cmluZ1tdIHtcbiAgICBjb25zdCBiYXNlID0gc3VwZXIuZ2V0U2VudGVuY2VzKCk7XG5cbiAgICAvLyBJbmplY3QgbG9vcCBzdW1tYXJpZXMgYXQgdGhlIGVuZCAob3IgeW91IGNvdWxkIGluc2VydCB0aGVtIGluLXBsYWNlKVxuICAgIGNvbnN0IHN1bW1hcmllczogc3RyaW5nW10gPSBbXTtcbiAgICBmb3IgKGNvbnN0IHRhcmdldCBvZiB0aGlzLmxvb3BPcmRlcikge1xuICAgICAgY29uc3QgY291bnQgPSB0aGlzLmxvb3BDb3VudHMuZ2V0KHRhcmdldCkhO1xuICAgICAgc3VtbWFyaWVzLnB1c2goYExvb3BlZCAke2NvdW50fSB0aW1lJHtjb3VudCAhPT0gMSA/ICdzJyA6ICcnfSB0aHJvdWdoICR7dGFyZ2V0fS5gKTtcbiAgICB9XG5cbiAgICByZXR1cm4gWy4uLmJhc2UsIC4uLnN1bW1hcmllc107XG4gIH1cblxuICAvKiogUmV0dXJucyB0aGUgdG90YWwgbG9vcCBjb3VudCBwZXIgdGFyZ2V0LiAqL1xuICBnZXRMb29wQ291bnRzKCk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICAgIHJldHVybiBuZXcgTWFwKHRoaXMubG9vcENvdW50cyk7XG4gIH1cblxuICBvdmVycmlkZSBjbGVhcigpOiB2b2lkIHtcbiAgICBzdXBlci5jbGVhcigpO1xuICAgIHRoaXMubG9vcENvdW50cy5jbGVhcigpO1xuICAgIHRoaXMubG9vcE9yZGVyID0gW107XG4gIH1cbn1cbiJdfQ==