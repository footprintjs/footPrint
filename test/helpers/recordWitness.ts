import { RecordFrame, SharedMemory } from 'foottrace/write';

/**
 * Test instrumentation only. The engine's mutation controls must patch the same buffer that its
 * public writer composes. Discover that identity from an ordinary frame instead of importing a
 * package-private module or publishing the buffer as an API. A private-layout change fails loudly
 * here, requiring the witness to move with the implementation it observes.
 */
export function recordBufferConstructor(): { prototype: any; new (...args: any[]): any } {
  const frame = new RecordFrame(new SharedMemory());
  frame.write(['probe'], 1, 'set');
  const buffer = (frame as unknown as { buffer?: { constructor: unknown } }).buffer;
  if (!buffer || typeof buffer.constructor !== 'function') {
    throw new Error('RecordFrame buffer identity changed; update the engine witness instrumentation');
  }
  for (const method of ['commit', 'admit', 'detachBase']) {
    if (typeof (buffer.constructor as { prototype: Record<string, unknown> }).prototype[method] !== 'function') {
      throw new Error(`RecordFrame buffer lost ${method}; update the engine witness instrumentation`);
    }
  }
  return buffer.constructor as { prototype: any; new (...args: any[]): any };
}
