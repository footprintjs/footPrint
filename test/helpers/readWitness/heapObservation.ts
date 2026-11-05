/** The optional heap port observes original calls; it never supplies a value to an engine. */
export type { HeapObservationPorts } from './heapObservation/index.js';
export { createHeapObservation } from './heapObservation/index.js';
export { heapPoint } from './heapObservation/layout.js';
export { memoryCallsOf, validateHeapLinks } from './heapObservation/links.js';
