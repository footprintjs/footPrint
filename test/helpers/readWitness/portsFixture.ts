/** Inert native delegation ports: no storage, lookup, deletion or engine implementation. */
export class BufferPort {
  calls: unknown[][] = [];
  readResult: unknown;
  readError: unknown;
  writeError: unknown;
  commitResult = { ordinary: true };
  set(path: unknown, value: unknown) {
    this.calls.push(['set', path, value]);
    if (this.writeError) throw this.writeError;
  }

  merge(path: unknown, value: unknown) {
    this.calls.push(['merge', path, value]);
  }

  delete(path: unknown) {
    this.calls.push(['delete', path]);
    if (this.writeError) throw this.writeError;
  }

  get(path: unknown) {
    this.calls.push(['get', path]);
    if (this.readError) throw this.readError;
    return this.readResult;
  }

  commit() {
    this.calls.push(['commit']);
    return this.commitResult;
  }
}
export class StagePort {
  stageId = 'stage';
  runId = '';
  runtimeStageId = 'stage#0';
  /**
   * What the stage answers when its buffer has nothing: a canned stand-in for an engine's fall-back to
   * live state (9.28.0 always fell back; the build does not below a hard write). Still inert: no lookup.
   */
  fallback: unknown;
  constructor(readonly storage: BufferPort, readonly address: (string | number)[] = []) {}
  setObject(
    path: (string | number)[],
    key: string,
    value: unknown,
    _redact?: boolean,
    _description?: string,
    verb?: 'delete',
  ) {
    const at = [...this.address, ...path, key];
    if (verb === 'delete') return this.storage.delete(at);
    return this.storage.set(at, value);
  }

  updateObject(path: (string | number)[], key: string, value: unknown) {
    return this.storage.merge([...this.address, ...path, key], value);
  }

  getValue(path: (string | number)[], key: string) {
    const own = this.storage.get([...this.address, ...path, key]);
    return own === undefined ? this.fallback : own;
  }

  getValueDirect(path: (string | number)[], key: string) {
    return this.getValue(path, key);
  }

  commit() {
    return this.storage.commit();
  }
}
export const hooks = { StageContext: StagePort, TransactionBuffer: BufferPort };
