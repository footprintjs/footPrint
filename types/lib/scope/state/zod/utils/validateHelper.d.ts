/**
 * Zod Validation Helpers — Cross-version compatible Zod utilities
 *
 * Detection delegated to schema/detect.ts (single source of truth).
 */
import { type ZodRecord, type ZodTypeAny } from 'zod';
/** Check if the value is a Zod schema node. */
export declare function isZodNode(x: unknown): x is ZodTypeAny;
/** Peel wrappers; returns the underlying base Zod node (or null). */
export declare function unwrap(schema: ZodTypeAny | null | undefined): ZodTypeAny | null;
/** Version-tolerant access to ZodRecord value schema. */
export declare function getRecordValueType(rec: ZodRecord<any, any>): ZodTypeAny | null;
export declare function parseWithThis(schema: ZodTypeAny, value: unknown): unknown;
