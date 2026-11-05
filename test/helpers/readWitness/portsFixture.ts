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
    return this.storage.get([...this.address, ...path, key]);
  }

  getValueDirect(path: (string | number)[], key: string) {
    return this.getValue(path, key);
  }

  commit() {
    return this.storage.commit();
  }
}
export const hooks = { StageContext: StagePort, TransactionBuffer: BufferPort };
