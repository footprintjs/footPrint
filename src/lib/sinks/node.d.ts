/**
 * The few Node built-ins the file sink uses, declared just enough to type-check.
 *
 * footprintjs ships no `@types/node` (the examples' `_node-globals.d.ts` and the worker driver's `declare const
 * require` follow the same rule), and `src/lib/sinks/` is the ONE place in `src/` allowed to import a Node built-in
 * (`test/architecture/layering.test.ts`). Nothing here is part of the published types: the sink's public signatures
 * name no Node type.
 */

declare module 'node:fs' {
  export const constants: {
    readonly O_RDONLY: number;
    readonly O_RDWR: number;
    readonly O_APPEND: number;
    readonly O_CREAT: number;
    readonly O_NOFOLLOW?: number;
  };
  export function openSync(path: string, flags: number, mode?: number): number;
  export function write(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
    callback: (error: Error | null, written: number) => void,
  ): void;
  export function readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  export function fstatSync(fd: number): {
    readonly size: number;
    readonly nlink: number;
    readonly uid: number;
    readonly mode: number;
    isFile(): boolean;
  };
  export function closeSync(fd: number): void;
  export function fsync(fd: number, callback: (error: Error | null) => void): void;
}

declare module 'node:path' {
  export function resolve(...segments: string[]): string;
}

declare module 'node:process' {
  /** POSIX only — absent on Windows. */
  export const getuid: (() => number) | undefined;
}
