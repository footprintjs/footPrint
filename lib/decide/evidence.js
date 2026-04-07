"use strict";
/**
 * decide/evidence -- Lightweight temp recorder for auto-capturing reads
 * during a when() function call.
 *
 * Attached to scope before calling when(scope), detached after.
 * Captures ReadEvent key + summarized value + redaction flag.
 * Uses summarizeValue() at capture time (no raw object references held).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EvidenceCollector = void 0;
const summarizeValue_js_1 = require("../scope/recorders/summarizeValue.js");
const MAX_VALUE_LEN = 80;
let evidenceCounter = 0;
/**
 * Minimal Recorder that captures reads for decision evidence.
 * Attach before when(), detach after. Collect via getInputs().
 */
class EvidenceCollector {
    constructor() {
        this.inputs = [];
        this.id = `evidence-${++evidenceCounter}`;
    }
    onRead(event) {
        if (!event.key)
            return;
        this.inputs.push({
            key: event.key,
            valueSummary: event.redacted ? '[REDACTED]' : (0, summarizeValue_js_1.summarizeValue)(event.value, MAX_VALUE_LEN),
            redacted: event.redacted === true,
        });
    }
    /** Returns collected read inputs. */
    getInputs() {
        return this.inputs;
    }
}
exports.EvidenceCollector = EvidenceCollector;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZpZGVuY2UuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvbGliL2RlY2lkZS9ldmlkZW5jZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7Ozs7R0FPRzs7O0FBRUgsNEVBQXNFO0FBSXRFLE1BQU0sYUFBYSxHQUFHLEVBQUUsQ0FBQztBQUV6QixJQUFJLGVBQWUsR0FBRyxDQUFDLENBQUM7QUFFeEI7OztHQUdHO0FBQ0gsTUFBYSxpQkFBaUI7SUFJNUI7UUFGUSxXQUFNLEdBQWdCLEVBQUUsQ0FBQztRQUcvQixJQUFJLENBQUMsRUFBRSxHQUFHLFlBQVksRUFBRSxlQUFlLEVBQUUsQ0FBQztJQUM1QyxDQUFDO0lBRUQsTUFBTSxDQUFDLEtBQWdCO1FBQ3JCLElBQUksQ0FBQyxLQUFLLENBQUMsR0FBRztZQUFFLE9BQU87UUFDdkIsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUM7WUFDZixHQUFHLEVBQUUsS0FBSyxDQUFDLEdBQUc7WUFDZCxZQUFZLEVBQUUsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxJQUFBLGtDQUFjLEVBQUMsS0FBSyxDQUFDLEtBQUssRUFBRSxhQUFhLENBQUM7WUFDeEYsUUFBUSxFQUFFLEtBQUssQ0FBQyxRQUFRLEtBQUssSUFBSTtTQUNsQyxDQUFDLENBQUM7SUFDTCxDQUFDO0lBRUQscUNBQXFDO0lBQ3JDLFNBQVM7UUFDUCxPQUFPLElBQUksQ0FBQyxNQUFNLENBQUM7SUFDckIsQ0FBQztDQUNGO0FBckJELDhDQXFCQyIsInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogZGVjaWRlL2V2aWRlbmNlIC0tIExpZ2h0d2VpZ2h0IHRlbXAgcmVjb3JkZXIgZm9yIGF1dG8tY2FwdHVyaW5nIHJlYWRzXG4gKiBkdXJpbmcgYSB3aGVuKCkgZnVuY3Rpb24gY2FsbC5cbiAqXG4gKiBBdHRhY2hlZCB0byBzY29wZSBiZWZvcmUgY2FsbGluZyB3aGVuKHNjb3BlKSwgZGV0YWNoZWQgYWZ0ZXIuXG4gKiBDYXB0dXJlcyBSZWFkRXZlbnQga2V5ICsgc3VtbWFyaXplZCB2YWx1ZSArIHJlZGFjdGlvbiBmbGFnLlxuICogVXNlcyBzdW1tYXJpemVWYWx1ZSgpIGF0IGNhcHR1cmUgdGltZSAobm8gcmF3IG9iamVjdCByZWZlcmVuY2VzIGhlbGQpLlxuICovXG5cbmltcG9ydCB7IHN1bW1hcml6ZVZhbHVlIH0gZnJvbSAnLi4vc2NvcGUvcmVjb3JkZXJzL3N1bW1hcml6ZVZhbHVlLmpzJztcbmltcG9ydCB0eXBlIHsgUmVhZEV2ZW50LCBSZWNvcmRlciB9IGZyb20gJy4uL3Njb3BlL3R5cGVzLmpzJztcbmltcG9ydCB0eXBlIHsgUmVhZElucHV0IH0gZnJvbSAnLi90eXBlcy5qcyc7XG5cbmNvbnN0IE1BWF9WQUxVRV9MRU4gPSA4MDtcblxubGV0IGV2aWRlbmNlQ291bnRlciA9IDA7XG5cbi8qKlxuICogTWluaW1hbCBSZWNvcmRlciB0aGF0IGNhcHR1cmVzIHJlYWRzIGZvciBkZWNpc2lvbiBldmlkZW5jZS5cbiAqIEF0dGFjaCBiZWZvcmUgd2hlbigpLCBkZXRhY2ggYWZ0ZXIuIENvbGxlY3QgdmlhIGdldElucHV0cygpLlxuICovXG5leHBvcnQgY2xhc3MgRXZpZGVuY2VDb2xsZWN0b3IgaW1wbGVtZW50cyBSZWNvcmRlciB7XG4gIHJlYWRvbmx5IGlkOiBzdHJpbmc7XG4gIHByaXZhdGUgaW5wdXRzOiBSZWFkSW5wdXRbXSA9IFtdO1xuXG4gIGNvbnN0cnVjdG9yKCkge1xuICAgIHRoaXMuaWQgPSBgZXZpZGVuY2UtJHsrK2V2aWRlbmNlQ291bnRlcn1gO1xuICB9XG5cbiAgb25SZWFkKGV2ZW50OiBSZWFkRXZlbnQpOiB2b2lkIHtcbiAgICBpZiAoIWV2ZW50LmtleSkgcmV0dXJuO1xuICAgIHRoaXMuaW5wdXRzLnB1c2goe1xuICAgICAga2V5OiBldmVudC5rZXksXG4gICAgICB2YWx1ZVN1bW1hcnk6IGV2ZW50LnJlZGFjdGVkID8gJ1tSRURBQ1RFRF0nIDogc3VtbWFyaXplVmFsdWUoZXZlbnQudmFsdWUsIE1BWF9WQUxVRV9MRU4pLFxuICAgICAgcmVkYWN0ZWQ6IGV2ZW50LnJlZGFjdGVkID09PSB0cnVlLFxuICAgIH0pO1xuICB9XG5cbiAgLyoqIFJldHVybnMgY29sbGVjdGVkIHJlYWQgaW5wdXRzLiAqL1xuICBnZXRJbnB1dHMoKTogUmVhZElucHV0W10ge1xuICAgIHJldHVybiB0aGlzLmlucHV0cztcbiAgfVxufVxuIl19