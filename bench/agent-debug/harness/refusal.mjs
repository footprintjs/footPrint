/**
 * A refusal: the harness will not start, for a reason a person must fix (the
 * batch folder is locked, the program does not match its manifest, the folder
 * holds a batch with other flags). `run.mjs` prints its message as one
 * sentence and exits 2, never a stack trace (the reader's R3-3).
 * Example: `throw new Refusal('the batch folder … is locked by process 42.')`.
 */
export class Refusal extends Error {}
