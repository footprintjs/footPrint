/**
 * decide/evidence -- Lightweight temp recorder for auto-capturing reads
 * during a when() function call.
 *
 * Attached to scope before calling when(scope), detached after.
 * Captures ReadEvent key + summarized value + redaction flag.
 * Uses summarizeValue() at capture time (no raw object references held).
 */
import { summarizeValue } from '../scope/recorders/summarizeValue.js';
const MAX_VALUE_LEN = 80;
let evidenceCounter = 0;
/**
 * Minimal Recorder that captures reads for decision evidence.
 * Attach before when(), detach after. Collect via getInputs().
 */
export class EvidenceCollector {
    constructor() {
        this.inputs = [];
        this.id = `evidence-${++evidenceCounter}`;
    }
    onRead(event) {
        if (!event.key)
            return;
        this.inputs.push({
            key: event.key,
            valueSummary: event.redacted ? '[REDACTED]' : summarizeValue(event.value, MAX_VALUE_LEN),
            redacted: event.redacted === true,
        });
    }
    /** Returns collected read inputs. */
    getInputs() {
        return this.inputs;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZXZpZGVuY2UuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL2RlY2lkZS9ldmlkZW5jZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7OztHQU9HO0FBRUgsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLHNDQUFzQyxDQUFDO0FBSXRFLE1BQU0sYUFBYSxHQUFHLEVBQUUsQ0FBQztBQUV6QixJQUFJLGVBQWUsR0FBRyxDQUFDLENBQUM7QUFFeEI7OztHQUdHO0FBQ0gsTUFBTSxPQUFPLGlCQUFpQjtJQUk1QjtRQUZRLFdBQU0sR0FBZ0IsRUFBRSxDQUFDO1FBRy9CLElBQUksQ0FBQyxFQUFFLEdBQUcsWUFBWSxFQUFFLGVBQWUsRUFBRSxDQUFDO0lBQzVDLENBQUM7SUFFRCxNQUFNLENBQUMsS0FBZ0I7UUFDckIsSUFBSSxDQUFDLEtBQUssQ0FBQyxHQUFHO1lBQUUsT0FBTztRQUN2QixJQUFJLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQztZQUNmLEdBQUcsRUFBRSxLQUFLLENBQUMsR0FBRztZQUNkLFlBQVksRUFBRSxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxLQUFLLENBQUMsS0FBSyxFQUFFLGFBQWEsQ0FBQztZQUN4RixRQUFRLEVBQUUsS0FBSyxDQUFDLFFBQVEsS0FBSyxJQUFJO1NBQ2xDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRCxxQ0FBcUM7SUFDckMsU0FBUztRQUNQLE9BQU8sSUFBSSxDQUFDLE1BQU0sQ0FBQztJQUNyQixDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIGRlY2lkZS9ldmlkZW5jZSAtLSBMaWdodHdlaWdodCB0ZW1wIHJlY29yZGVyIGZvciBhdXRvLWNhcHR1cmluZyByZWFkc1xuICogZHVyaW5nIGEgd2hlbigpIGZ1bmN0aW9uIGNhbGwuXG4gKlxuICogQXR0YWNoZWQgdG8gc2NvcGUgYmVmb3JlIGNhbGxpbmcgd2hlbihzY29wZSksIGRldGFjaGVkIGFmdGVyLlxuICogQ2FwdHVyZXMgUmVhZEV2ZW50IGtleSArIHN1bW1hcml6ZWQgdmFsdWUgKyByZWRhY3Rpb24gZmxhZy5cbiAqIFVzZXMgc3VtbWFyaXplVmFsdWUoKSBhdCBjYXB0dXJlIHRpbWUgKG5vIHJhdyBvYmplY3QgcmVmZXJlbmNlcyBoZWxkKS5cbiAqL1xuXG5pbXBvcnQgeyBzdW1tYXJpemVWYWx1ZSB9IGZyb20gJy4uL3Njb3BlL3JlY29yZGVycy9zdW1tYXJpemVWYWx1ZS5qcyc7XG5pbXBvcnQgdHlwZSB7IFJlYWRFdmVudCwgUmVjb3JkZXIgfSBmcm9tICcuLi9zY29wZS90eXBlcy5qcyc7XG5pbXBvcnQgdHlwZSB7IFJlYWRJbnB1dCB9IGZyb20gJy4vdHlwZXMuanMnO1xuXG5jb25zdCBNQVhfVkFMVUVfTEVOID0gODA7XG5cbmxldCBldmlkZW5jZUNvdW50ZXIgPSAwO1xuXG4vKipcbiAqIE1pbmltYWwgUmVjb3JkZXIgdGhhdCBjYXB0dXJlcyByZWFkcyBmb3IgZGVjaXNpb24gZXZpZGVuY2UuXG4gKiBBdHRhY2ggYmVmb3JlIHdoZW4oKSwgZGV0YWNoIGFmdGVyLiBDb2xsZWN0IHZpYSBnZXRJbnB1dHMoKS5cbiAqL1xuZXhwb3J0IGNsYXNzIEV2aWRlbmNlQ29sbGVjdG9yIGltcGxlbWVudHMgUmVjb3JkZXIge1xuICByZWFkb25seSBpZDogc3RyaW5nO1xuICBwcml2YXRlIGlucHV0czogUmVhZElucHV0W10gPSBbXTtcblxuICBjb25zdHJ1Y3RvcigpIHtcbiAgICB0aGlzLmlkID0gYGV2aWRlbmNlLSR7KytldmlkZW5jZUNvdW50ZXJ9YDtcbiAgfVxuXG4gIG9uUmVhZChldmVudDogUmVhZEV2ZW50KTogdm9pZCB7XG4gICAgaWYgKCFldmVudC5rZXkpIHJldHVybjtcbiAgICB0aGlzLmlucHV0cy5wdXNoKHtcbiAgICAgIGtleTogZXZlbnQua2V5LFxuICAgICAgdmFsdWVTdW1tYXJ5OiBldmVudC5yZWRhY3RlZCA/ICdbUkVEQUNURURdJyA6IHN1bW1hcml6ZVZhbHVlKGV2ZW50LnZhbHVlLCBNQVhfVkFMVUVfTEVOKSxcbiAgICAgIHJlZGFjdGVkOiBldmVudC5yZWRhY3RlZCA9PT0gdHJ1ZSxcbiAgICB9KTtcbiAgfVxuXG4gIC8qKiBSZXR1cm5zIGNvbGxlY3RlZCByZWFkIGlucHV0cy4gKi9cbiAgZ2V0SW5wdXRzKCk6IFJlYWRJbnB1dFtdIHtcbiAgICByZXR1cm4gdGhpcy5pbnB1dHM7XG4gIH1cbn1cbiJdfQ==