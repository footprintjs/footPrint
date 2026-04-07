"use strict";
/**
 * summarizeValue — Human-readable summary of a scope value for narrative output.
 *
 * Shared by NarrativeRecorder and CombinedNarrativeRecorder to ensure consistent
 * narrative formatting. Truncates strings, summarizes arrays/objects by count.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.summarizeValue = void 0;
function summarizeValue(value, maxLen) {
    if (value === undefined)
        return 'undefined';
    if (value === null)
        return 'null';
    if (typeof value === 'string') {
        return value.length <= maxLen ? `"${value}"` : `"${value.slice(0, maxLen - 3)}..."`;
    }
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    if (Array.isArray(value)) {
        return value.length === 0 ? '[]' : `(${value.length} item${value.length > 1 ? 's' : ''})`;
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0)
            return '{}';
        const preview = keys.slice(0, 4).join(', ');
        const suffix = keys.length > 4 ? `, ... (${keys.length} keys)` : '';
        const result = `{${preview}${suffix}}`;
        return result.length <= maxLen ? result : `{${keys.length} keys}`;
    }
    return String(value);
}
exports.summarizeValue = summarizeValue;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3VtbWFyaXplVmFsdWUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvbGliL3Njb3BlL3JlY29yZGVycy9zdW1tYXJpemVWYWx1ZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiO0FBQUE7Ozs7O0dBS0c7OztBQUVILFNBQWdCLGNBQWMsQ0FBQyxLQUFjLEVBQUUsTUFBYztJQUMzRCxJQUFJLEtBQUssS0FBSyxTQUFTO1FBQUUsT0FBTyxXQUFXLENBQUM7SUFDNUMsSUFBSSxLQUFLLEtBQUssSUFBSTtRQUFFLE9BQU8sTUFBTSxDQUFDO0lBQ2xDLElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxFQUFFLENBQUM7UUFDOUIsT0FBTyxLQUFLLENBQUMsTUFBTSxJQUFJLE1BQU0sQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRSxNQUFNLEdBQUcsQ0FBQyxDQUFDLE1BQU0sQ0FBQztJQUN0RixDQUFDO0lBQ0QsSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRLElBQUksT0FBTyxLQUFLLEtBQUssU0FBUztRQUFFLE9BQU8sTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ2xGLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDO1FBQ3pCLE9BQU8sS0FBSyxDQUFDLE1BQU0sS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxLQUFLLENBQUMsTUFBTSxRQUFRLEtBQUssQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsR0FBRyxDQUFDO0lBQzVGLENBQUM7SUFDRCxJQUFJLE9BQU8sS0FBSyxLQUFLLFFBQVEsRUFBRSxDQUFDO1FBQzlCLE1BQU0sSUFBSSxHQUFHLE1BQU0sQ0FBQyxJQUFJLENBQUMsS0FBZ0MsQ0FBQyxDQUFDO1FBQzNELElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxDQUFDO1lBQUUsT0FBTyxJQUFJLENBQUM7UUFDbkMsTUFBTSxPQUFPLEdBQUcsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDO1FBQzVDLE1BQU0sTUFBTSxHQUFHLElBQUksQ0FBQyxNQUFNLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLElBQUksQ0FBQyxNQUFNLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO1FBQ3BFLE1BQU0sTUFBTSxHQUFHLElBQUksT0FBTyxHQUFHLE1BQU0sR0FBRyxDQUFDO1FBQ3ZDLE9BQU8sTUFBTSxDQUFDLE1BQU0sSUFBSSxNQUFNLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsSUFBSSxJQUFJLENBQUMsTUFBTSxRQUFRLENBQUM7SUFDcEUsQ0FBQztJQUNELE9BQU8sTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ3ZCLENBQUM7QUFuQkQsd0NBbUJDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBzdW1tYXJpemVWYWx1ZSDigJQgSHVtYW4tcmVhZGFibGUgc3VtbWFyeSBvZiBhIHNjb3BlIHZhbHVlIGZvciBuYXJyYXRpdmUgb3V0cHV0LlxuICpcbiAqIFNoYXJlZCBieSBOYXJyYXRpdmVSZWNvcmRlciBhbmQgQ29tYmluZWROYXJyYXRpdmVSZWNvcmRlciB0byBlbnN1cmUgY29uc2lzdGVudFxuICogbmFycmF0aXZlIGZvcm1hdHRpbmcuIFRydW5jYXRlcyBzdHJpbmdzLCBzdW1tYXJpemVzIGFycmF5cy9vYmplY3RzIGJ5IGNvdW50LlxuICovXG5cbmV4cG9ydCBmdW5jdGlvbiBzdW1tYXJpemVWYWx1ZSh2YWx1ZTogdW5rbm93biwgbWF4TGVuOiBudW1iZXIpOiBzdHJpbmcge1xuICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkgcmV0dXJuICd1bmRlZmluZWQnO1xuICBpZiAodmFsdWUgPT09IG51bGwpIHJldHVybiAnbnVsbCc7XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgcmV0dXJuIHZhbHVlLmxlbmd0aCA8PSBtYXhMZW4gPyBgXCIke3ZhbHVlfVwiYCA6IGBcIiR7dmFsdWUuc2xpY2UoMCwgbWF4TGVuIC0gMyl9Li4uXCJgO1xuICB9XG4gIGlmICh0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInIHx8IHR5cGVvZiB2YWx1ZSA9PT0gJ2Jvb2xlYW4nKSByZXR1cm4gU3RyaW5nKHZhbHVlKTtcbiAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgcmV0dXJuIHZhbHVlLmxlbmd0aCA9PT0gMCA/ICdbXScgOiBgKCR7dmFsdWUubGVuZ3RofSBpdGVtJHt2YWx1ZS5sZW5ndGggPiAxID8gJ3MnIDogJyd9KWA7XG4gIH1cbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcpIHtcbiAgICBjb25zdCBrZXlzID0gT2JqZWN0LmtleXModmFsdWUgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pO1xuICAgIGlmIChrZXlzLmxlbmd0aCA9PT0gMCkgcmV0dXJuICd7fSc7XG4gICAgY29uc3QgcHJldmlldyA9IGtleXMuc2xpY2UoMCwgNCkuam9pbignLCAnKTtcbiAgICBjb25zdCBzdWZmaXggPSBrZXlzLmxlbmd0aCA+IDQgPyBgLCAuLi4gKCR7a2V5cy5sZW5ndGh9IGtleXMpYCA6ICcnO1xuICAgIGNvbnN0IHJlc3VsdCA9IGB7JHtwcmV2aWV3fSR7c3VmZml4fX1gO1xuICAgIHJldHVybiByZXN1bHQubGVuZ3RoIDw9IG1heExlbiA/IHJlc3VsdCA6IGB7JHtrZXlzLmxlbmd0aH0ga2V5c31gO1xuICB9XG4gIHJldHVybiBTdHJpbmcodmFsdWUpO1xufVxuIl19