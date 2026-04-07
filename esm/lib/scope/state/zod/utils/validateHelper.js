/**
 * Zod Validation Helpers — Cross-version compatible Zod utilities
 *
 * Detection delegated to schema/detect.ts (single source of truth).
 */
import { z } from 'zod';
import { detectSchema } from '../../../../schema/detect.js';
/** Check if the value is a Zod schema node. */
export function isZodNode(x) {
    return detectSchema(x) !== 'none';
}
/** Peel wrappers; returns the underlying base Zod node (or null). */
export function unwrap(schema) {
    var _a;
    let s = schema !== null && schema !== void 0 ? schema : null;
    while (isZodNode(s)) {
        const def = (_a = s._def) !== null && _a !== void 0 ? _a : {};
        if (isZodNode(def.innerType)) {
            s = def.innerType;
            continue;
        }
        if (isZodNode(def.schema)) {
            s = def.schema;
            continue;
        }
        if (isZodNode(def.type)) {
            s = def.type;
            continue;
        }
        break;
    }
    return isZodNode(s) ? s : null;
}
/** Version-tolerant access to ZodRecord value schema. */
export function getRecordValueType(rec) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    const r = rec;
    const def = (_a = r._def) !== null && _a !== void 0 ? _a : {};
    return ((_j = (_g = (_e = (_d = (_c = (_b = r.valueSchema) !== null && _b !== void 0 ? _b : r.valueType) !== null && _c !== void 0 ? _c : def.valueType) !== null && _d !== void 0 ? _d : def.value) !== null && _e !== void 0 ? _e : (def.schema && ((_f = def.schema.valueType) !== null && _f !== void 0 ? _f : def.schema.value))) !== null && _g !== void 0 ? _g : (def.innerType && ((_h = def.innerType.valueType) !== null && _h !== void 0 ? _h : def.innerType.value))) !== null && _j !== void 0 ? _j : null);
}
function looksLikeBindingError(err) {
    var _a;
    const msg = (_a = err === null || err === void 0 ? void 0 : err.message) !== null && _a !== void 0 ? _a : '';
    return msg.includes('_zod') || msg.includes('inst._zod') || msg.includes('Cannot read properties of undefined');
}
const WRAPPER_CACHE = new WeakMap();
export function parseWithThis(schema, value) {
    var _a;
    const anySchema = schema;
    if (typeof anySchema.safeParse === 'function') {
        try {
            const res = anySchema.safeParse(value);
            if (res && typeof res === 'object' && Object.prototype.hasOwnProperty.call(res, 'success')) {
                if (res.success)
                    return res.data;
                throw res.error;
            }
        }
        catch (err) {
            if (!looksLikeBindingError(err))
                throw err;
        }
    }
    if (typeof anySchema.safeParse === 'function') {
        try {
            const res = anySchema.safeParse.call(schema, value);
            if (res && typeof res === 'object' && Object.prototype.hasOwnProperty.call(res, 'success')) {
                if (res.success)
                    return res.data;
                throw res.error;
            }
        }
        catch (err) {
            if (!looksLikeBindingError(err))
                throw err;
        }
    }
    if (typeof anySchema.parse === 'function') {
        try {
            return anySchema.parse(value);
        }
        catch (err) {
            if (!looksLikeBindingError(err))
                throw err;
        }
    }
    let wrapper = WRAPPER_CACHE.get(schema);
    if (!wrapper) {
        wrapper = z.any().pipe(schema);
        WRAPPER_CACHE.set(schema, wrapper);
    }
    const res = wrapper.safeParse(value);
    if (res && res.success)
        return res.data;
    throw (_a = res === null || res === void 0 ? void 0 : res.error) !== null && _a !== void 0 ? _a : new TypeError('Zod validation binding failed (wrapper fallback).');
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidmFsaWRhdGVIZWxwZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi8uLi8uLi8uLi9zcmMvbGliL3Njb3BlL3N0YXRlL3pvZC91dGlscy92YWxpZGF0ZUhlbHBlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7OztHQUlHO0FBRUgsT0FBTyxFQUFtQyxDQUFDLEVBQUUsTUFBTSxLQUFLLENBQUM7QUFFekQsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLDhCQUE4QixDQUFDO0FBRTVELCtDQUErQztBQUMvQyxNQUFNLFVBQVUsU0FBUyxDQUFDLENBQVU7SUFDbEMsT0FBTyxZQUFZLENBQUMsQ0FBQyxDQUFDLEtBQUssTUFBTSxDQUFDO0FBQ3BDLENBQUM7QUFFRCxxRUFBcUU7QUFDckUsTUFBTSxVQUFVLE1BQU0sQ0FBQyxNQUFxQzs7SUFDMUQsSUFBSSxDQUFDLEdBQVksTUFBTSxhQUFOLE1BQU0sY0FBTixNQUFNLEdBQUksSUFBSSxDQUFDO0lBQ2hDLE9BQU8sU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7UUFDcEIsTUFBTSxHQUFHLEdBQUcsTUFBQyxDQUFTLENBQUMsSUFBSSxtQ0FBSSxFQUFFLENBQUM7UUFDbEMsSUFBSSxTQUFTLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUM7WUFDN0IsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxTQUFTLENBQUM7WUFDbEIsU0FBUztRQUNYLENBQUM7UUFDRCxJQUFJLFNBQVMsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQztZQUMxQixDQUFDLEdBQUcsR0FBRyxDQUFDLE1BQU0sQ0FBQztZQUNmLFNBQVM7UUFDWCxDQUFDO1FBQ0QsSUFBSSxTQUFTLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUM7WUFDeEIsQ0FBQyxHQUFHLEdBQUcsQ0FBQyxJQUFJLENBQUM7WUFDYixTQUFTO1FBQ1gsQ0FBQztRQUNELE1BQU07SUFDUixD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QUksQ0FBQyxxQkFBcUIsQ0FBQyxHQUFHLENBQUM7Z0JBQUUsTUFBTSxHQUFHLENBQUM7UUFDN0MsQ0FBQztJQUNILENBQUM7SUFFRCxJQUFJLE9BQU8sU0FBUyxDQUFDLEtBQUssS0FBSyxVQUFVLEVBQUUsQ0FBQztRQUMxQyxJQUFJLENBQUM7WUFDSCxPQUFPLFNBQVMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUM7UUFDaEMsQ0FBQztRQUFDLE9BQU8sR0FBRyxFQUFFLENBQUM7WUFDYixJQUFJLENBQUMscUJBQXFCLENBQUMsR0FBRyxDQUFDO2dCQUFFLE1BQU0sR0FBRyxDQUFDO1FBQzdDLENBQUM7SUFDSCxDQUFDO0lBRUQsSUFBSSxPQUFPLEdBQUcsYUFBYSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUN4QyxJQUFJLENBQUMsT0FBTyxFQUFFLENBQUM7UUFDYixPQUFPLEdBQUksQ0FBQyxDQUFDLEdBQUcsRUFBVSxDQUFDLElBQUksQ0FBQyxNQUFhLENBQUMsQ0FBQztRQUMvQyxhQUFhLENBQUMsR0FBRyxDQUFDLE1BQU0sRUFBRSxPQUFRLENBQUMsQ0FBQztJQUN0QyxDQUFDO0lBQ0QsTUFBTSxHQUFHLEdBQUksT0FBZSxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQztJQUM5QyxJQUFJLEdBQUcsSUFBSSxHQUFHLENBQUMsT0FBTztRQUFFLE9BQU8sR0FBRyxDQUFDLElBQUksQ0FBQztJQUV4QyxNQUFNLE1BQUEsR0FBRyxhQUFILEdBQUcsdUJBQUgsR0FBRyxDQUFFLEtBQUssbUNBQUksSUFBSSxTQUFTLENBQUMsbURBQW1ELENBQUMsQ0FBQztBQUN6RixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBab2QgVmFsaWRhdGlvbiBIZWxwZXJzIOKAlCBDcm9zcy12ZXJzaW9uIGNvbXBhdGlibGUgWm9kIHV0aWxpdGllc1xuICpcbiAqIERldGVjdGlvbiBkZWxlZ2F0ZWQgdG8gc2NoZW1hL2RldGVjdC50cyAoc2luZ2xlIHNvdXJjZSBvZiB0cnV0aCkuXG4gKi9cblxuaW1wb3J0IHsgdHlwZSBab2RSZWNvcmQsIHR5cGUgWm9kVHlwZUFueSwgeiB9IGZyb20gJ3pvZCc7XG5cbmltcG9ydCB7IGRldGVjdFNjaGVtYSB9IGZyb20gJy4uLy4uLy4uLy4uL3NjaGVtYS9kZXRlY3QuanMnO1xuXG4vKiogQ2hlY2sgaWYgdGhlIHZhbHVlIGlzIGEgWm9kIHNjaGVtYSBub2RlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzWm9kTm9kZSh4OiB1bmtub3duKTogeCBpcyBab2RUeXBlQW55IHtcbiAgcmV0dXJuIGRldGVjdFNjaGVtYSh4KSAhPT0gJ25vbmUnO1xufVxuXG4vKiogUGVlbCB3cmFwcGVyczsgcmV0dXJucyB0aGUgdW5kZXJseWluZyBiYXNlIFpvZCBub2RlIChvciBudWxsKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bndyYXAoc2NoZW1hOiBab2RUeXBlQW55IHwgbnVsbCB8IHVuZGVmaW5lZCk6IFpvZFR5cGVBbnkgfCBudWxsIHtcbiAgbGV0IHM6IHVua25vd24gPSBzY2hlbWEgPz8gbnVsbDtcbiAgd2hpbGUgKGlzWm9kTm9kZShzKSkge1xuICAgIGNvbnN0IGRlZiA9IChzIGFzIGFueSkuX2RlZiA/PyB7fTtcbiAgICBpZiAoaXNab2ROb2RlKGRlZi5pbm5lclR5cGUpKSB7XG4gICAgICBzID0gZGVmLmlubmVyVHlwZTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoaXNab2ROb2RlKGRlZi5zY2hlbWEpKSB7XG4gICAgICBzID0gZGVmLnNjaGVtYTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoaXNab2ROb2RlKGRlZi50eXBlKSkge1xuICAgICAgcyA9IGRlZi50eXBlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGJyZWFrO1xuICB9XG4gIHJldHVybiBpc1pvZE5vZGUocykgPyAocyBhcyBab2RUeXBlQW55KSA6IG51bGw7XG59XG5cbi8qKiBWZXJzaW9uLXRvbGVyYW50IGFjY2VzcyB0byBab2RSZWNvcmQgdmFsdWUgc2NoZW1hLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdldFJlY29yZFZhbHVlVHlwZShyZWM6IFpvZFJlY29yZDxhbnksIGFueT4pOiBab2RUeXBlQW55IHwgbnVsbCB7XG4gIGNvbnN0IHI6IGFueSA9IHJlYyBhcyBhbnk7XG4gIGNvbnN0IGRlZiA9IHIuX2RlZiA/PyB7fTtcbiAgcmV0dXJuIChcbiAgICByLnZhbHVlU2NoZW1hID8/XG4gICAgci52YWx1ZVR5cGUgPz9cbiAgICBkZWYudmFsdWVUeXBlID8/XG4gICAgZGVmLnZhbHVlID8/XG4gICAgKGRlZi5zY2hlbWEgJiYgKGRlZi5zY2hlbWEudmFsdWVUeXBlID8/IGRlZi5zY2hlbWEudmFsdWUpKSA/P1xuICAgIChkZWYuaW5uZXJUeXBlICYmIChkZWYuaW5uZXJUeXBlLnZhbHVlVHlwZSA/PyBkZWYuaW5uZXJUeXBlLnZhbHVlKSkgPz9cbiAgICBudWxsXG4gICk7XG59XG5cbmZ1bmN0aW9uIGxvb2tzTGlrZUJpbmRpbmdFcnJvcihlcnI6IHVua25vd24pOiBib29sZWFuIHtcbiAgY29uc3QgbXNnID0gKGVyciBhcyBhbnkpPy5tZXNzYWdlID8/ICcnO1xuICByZXR1cm4gbXNnLmluY2x1ZGVzKCdfem9kJykgfHwgbXNnLmluY2x1ZGVzKCdpbnN0Ll96b2QnKSB8fCBtc2cuaW5jbHVkZXMoJ0Nhbm5vdCByZWFkIHByb3BlcnRpZXMgb2YgdW5kZWZpbmVkJyk7XG59XG5cbmNvbnN0IFdSQVBQRVJfQ0FDSEUgPSBuZXcgV2Vha01hcDxab2RUeXBlQW55LCBab2RUeXBlQW55PigpO1xuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VXaXRoVGhpcyhzY2hlbWE6IFpvZFR5cGVBbnksIHZhbHVlOiB1bmtub3duKTogdW5rbm93biB7XG4gIGNvbnN0IGFueVNjaGVtYSA9IHNjaGVtYSBhcyBhbnk7XG5cbiAgaWYgKHR5cGVvZiBhbnlTY2hlbWEuc2FmZVBhcnNlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlcyA9IGFueVNjaGVtYS5zYWZlUGFyc2UodmFsdWUpO1xuICAgICAgaWYgKHJlcyAmJiB0eXBlb2YgcmVzID09PSAnb2JqZWN0JyAmJiBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5LmNhbGwocmVzLCAnc3VjY2VzcycpKSB7XG4gICAgICAgIGlmIChyZXMuc3VjY2VzcykgcmV0dXJuIHJlcy5kYXRhO1xuICAgICAgICB0aHJvdyByZXMuZXJyb3I7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICBpZiAoIWxvb2tzTGlrZUJpbmRpbmdFcnJvcihlcnIpKSB0aHJvdyBlcnI7XG4gICAgfVxuICB9XG5cbiAgaWYgKHR5cGVvZiBhbnlTY2hlbWEuc2FmZVBhcnNlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IHJlcyA9IGFueVNjaGVtYS5zYWZlUGFyc2UuY2FsbChzY2hlbWEsIHZhbHVlKTtcbiAgICAgIGlmIChyZXMgJiYgdHlwZW9mIHJlcyA9PT0gJ29iamVjdCcgJiYgT2JqZWN0LnByb3RvdHlwZS5oYXNPd25Qcm9wZXJ0eS5jYWxsKHJlcywgJ3N1Y2Nlc3MnKSkge1xuICAgICAgICBpZiAocmVzLnN1Y2Nlc3MpIHJldHVybiByZXMuZGF0YTtcbiAgICAgICAgdGhyb3cgcmVzLmVycm9yO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgaWYgKCFsb29rc0xpa2VCaW5kaW5nRXJyb3IoZXJyKSkgdGhyb3cgZXJyO1xuICAgIH1cbiAgfVxuXG4gIGlmICh0eXBlb2YgYW55U2NoZW1hLnBhcnNlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBhbnlTY2hlbWEucGFyc2UodmFsdWUpO1xuICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgaWYgKCFsb29rc0xpa2VCaW5kaW5nRXJyb3IoZXJyKSkgdGhyb3cgZXJyO1xuICAgIH1cbiAgfVxuXG4gIGxldCB3cmFwcGVyID0gV1JBUFBFUl9DQUNIRS5nZXQoc2NoZW1hKTtcbiAgaWYgKCF3cmFwcGVyKSB7XG4gICAgd3JhcHBlciA9ICh6LmFueSgpIGFzIGFueSkucGlwZShzY2hlbWEgYXMgYW55KTtcbiAgICBXUkFQUEVSX0NBQ0hFLnNldChzY2hlbWEsIHdyYXBwZXIhKTtcbiAgfVxuICBjb25zdCByZXMgPSAod3JhcHBlciBhcyBhbnkpLnNhZmVQYXJzZSh2YWx1ZSk7XG4gIGlmIChyZXMgJiYgcmVzLnN1Y2Nlc3MpIHJldHVybiByZXMuZGF0YTtcblxuICB0aHJvdyByZXM/LmVycm9yID8/IG5ldyBUeXBlRXJyb3IoJ1pvZCB2YWxpZGF0aW9uIGJpbmRpbmcgZmFpbGVkICh3cmFwcGVyIGZhbGxiYWNrKS4nKTtcbn1cbiJdfQ==