import { applySmartMerge, DELIM, WriteBuffer } from '../../../src/core/stateManagement/WriteBuffer';
import { setNestedValue, updateNestedValue } from '../../../src/core/stateManagement/utils';

/** Turn a commit() payload back into a full JSON tree */
function materialise(base: any, commitRes: ReturnType<WriteBuffer['commit']>) {
  const { overwrite, updates, trace } = commitRes;
  return applySmartMerge(base, updates, overwrite, trace);
}

/* -------------------------------------------------------------------------- *
 * 1.  Edge‑value tests
 * -------------------------------------------------------------------------- */
describe('WriteBuffer – handling null, undefined, NaN, and empty strings', () => {
  const base = {
    primitive: 'value',
    object: { a: 1, b: 2 },
    array: [1, 2, 3],
  };

  describe('setObject with edge values', () => {
    it('should overwrite with null', () => {
      const mem = new WriteBuffer(base);
      mem.set(['primitive'], null);
      const result = materialise(base, mem.commit());
      expect(result.primitive).toBeNull();
    });

    it('should overwrite with empty string', () => {
      const mem = new WriteBuffer(base);
      mem.set(['primitive'], '');
      const result = materialise(base, mem.commit());
      expect(result.primitive).toBe('');
    });

    it('should overwrite with NaN', () => {
      const mem = new WriteBuffer(base);
      mem.set(['primitive'], NaN);
      const result = materialise(base, mem.commit());
      expect(Number.isNaN(result.primitive)).toBe(true);
    });
  });

  describe('merge() with edge values', () => {
    it('should set field to null', () => {
      const mem = new WriteBuffer(base);
      mem.merge(['object'], { a: null });
      const result = materialise(base, mem.commit());
      expect(result.object).toEqual({ a: null, b: 2 });
    });

    it('should set field to empty string', () => {
      const mem = new WriteBuffer(base);
      mem.merge(['object'], { a: '' });
      const result = materialise(base, mem.commit());
      expect(result.object).toEqual({ a: '', b: 2 });
    });

    it('should set field to NaN', () => {
      const mem = new WriteBuffer(base);
      mem.merge(['object'], { a: NaN });
      const result = materialise(base, mem.commit());
      expect(Number.isNaN(result.object.a)).toBe(true);
    });
  });
});

/* -------------------------------------------------------------------------- *
 * 2.  Back‑compat equivalence vs old helpers
 * -------------------------------------------------------------------------- */
describe('Backward compatibility – old vs new memory model', () => {
  const pipelineId = 'testFlow';
  const base = {
    pipelines: {
      [pipelineId]: {
        config: { a: 1, b: 2, tags: ['a'] },
        primitive: 'keep',
      },
    },
  };

  /* ------- legacy helpers (unchanged) ------- */
  function applyOldMutation(obj: any, patchPath: string[], key: string, value: any) {
    const clone = JSON.parse(JSON.stringify(obj));
    updateNestedValue(clone, pipelineId, patchPath, key, value);
    return clone;
  }

  function setOldMutation(obj: any, patchPath: string[], key: string, value: any) {
    const clone = JSON.parse(JSON.stringify(obj));
    setNestedValue(clone, pipelineId, patchPath, key, value);
    return clone;
  }

  /* --------------------------------------------------------------------------
   * Helper -> applyNewMutation
   * --------------------------------------------------------------------------
   * In production a stage calls:
   *
   *     scope.updateObject(patchPath, key, value)  ➜ StageContext.merge(...)
   *     └── StageContext.withNamespace(...)        ➜ ['pipelines', id, ...patchPath, key]
   *         (adds the pipeline prefix *and* pushes `key` onto the path array)
   *     └── WriteBuffer.merge(fullLeafPath, value)
   *
   * The memory layer therefore sees the *leaf* path (where the value lives) and
   * a plain value, NOT an object wrapper like { [key]: value }.
   *
   * To mimic that exact runtime behaviour in unit tests we must assemble the
   * same leaf path here before calling merge()/set().
   * ------------------------------------------------------------------------ */
  function applyNewMutation(obj: any, patchPath: string[], key: string, value: any) {
    const mem = new WriteBuffer(obj);
    const fullPath = ['pipelines', pipelineId, ...patchPath, key];
    mem.merge(fullPath, value);
    return materialise(obj, mem.commit());
  }

  /* --------------------------------------------------------------------------
   * Helper –>setNewMutation   (identical reasoning for hard overwrites)
   * ------------------------------------------------------------------------ */
  function setNewMutation(obj: any, patchPath: string[], key: string, value: any) {
    const mem = new WriteBuffer(obj);
    const fullPath = ['pipelines', pipelineId, ...patchPath, key];
    mem.set(fullPath, value);
    return materialise(obj, mem.commit());
  }

  /* ----------------- tests ------------------ */
  it('Update: should match behavior for object merge', () => {
    const value = { x: 1 };
    const patchPath = ['config'];
    const oldResult = applyOldMutation(base, patchPath, 'b', value);
    const newResult = applyNewMutation(base, patchPath, 'b', value);
    expect(newResult).toEqual(oldResult);
  });

  it('Update: should match behavior for appending arrays', () => {
    const value = ['b'];
    const patchPath = ['config'];
    const oldResult = applyOldMutation(base, patchPath, 'tags', value);
    const newResult = applyNewMutation(base, patchPath, 'tags', value);
    expect(newResult).toEqual(oldResult);
  });

  it('Update: should match primitive update', () => {
    const value = 'newValue';
    const patchPath: string[] = [];
    const oldResult = applyOldMutation(base, patchPath, 'primitive', value);
    const newResult = applyNewMutation(base, patchPath, 'primitive', value);
    expect(newResult).toEqual(oldResult);
  });

  it('Update: should match behavior for updating undefined', () => {
    const value = undefined;
    const patchPath = ['config'];
    const oldResult = applyOldMutation(base, patchPath, 'a', value);
    const newResult = applyNewMutation(base, patchPath, 'a', value);
    expect(newResult).toEqual(oldResult);
  });

  it('Set (overwrite): should match primitive overwrite', () => {
    const value = 'newValue';
    const patchPath: string[] = [];
    const oldResult = setOldMutation(base, patchPath, 'primitive', value);
    const newResult = setNewMutation(base, patchPath, 'primitive', value);
    expect(newResult).toEqual(oldResult);
  });

  it('Set (overwrite): should match object overwrite', () => {
    const value = { x: 1 };
    const patchPath: string[] = [];
    const oldResult = setOldMutation(base, patchPath, 'config', value);
    const newResult = setNewMutation(base, patchPath, 'config', value);
    expect(newResult).toEqual(oldResult);
  });

  it('Set (overwrite): should match array overwrite', () => {
    const value = ['b'];
    const patchPath = ['config'];
    const oldResult = setOldMutation(base, patchPath, 'tags', value);
    const newResult = setNewMutation(base, patchPath, 'tags', value);
    expect(newResult).toEqual(oldResult);
  });

  it('Set (overwrite): should preserve identical behavior for undefined', () => {
    const value = undefined;
    const patchPath: string[] = [];
    const oldResult = setOldMutation(base, patchPath, 'a', value);
    const newResult = setNewMutation(base, patchPath, 'a', value);
    expect(newResult).toEqual(oldResult);
  });
});

describe('WriteBuffer – additional edge‑cases', () => {
  const base = { cfg: { tags: ['a'], num: 1 } };

  /* ---------------------------------------------------------------------- */
  describe('last‑writer‑wins semantics', () => {
    it('merge then set → set wins', () => {
      const ctx = new WriteBuffer(base);
      ctx.merge(['cfg', 'num'], 2);
      ctx.set(['cfg', 'num'], 3);

      const final = materialise(base, ctx.commit());
      expect(final.cfg.num).toBe(3);
    });

    it('set then merge → merge wins', () => {
      const ctx = new WriteBuffer(base);
      ctx.set(['cfg', 'num'], 3);
      ctx.merge(['cfg', 'num'], 4);

      const final = materialise(base, ctx.commit());
      expect(final.cfg.num).toBe(4);
    });
  });

  /* ---------------------------------------------------------------------- */
  describe('array union deduplication', () => {
    it('merge appends new items only once', () => {
      const ctx = new WriteBuffer(base);
      ctx.merge(['cfg', 'tags'], ['a', 'b']); // 'a' already exists, 'b' is new

      const final = materialise(base, ctx.commit());
      expect(final.cfg.tags).toEqual(['a', 'b']); // no duplicate 'a'
    });
  });

  /* ---------------------------------------------------------------------- */
  describe('touched‑path tracking', () => {
    it('records exactly the paths modified', () => {
      const ctx = new WriteBuffer(base);

      ctx.set(['cfg', 'num'], 9);
      ctx.merge(['cfg', 'tags'], ['b']);

      const { trace } = ctx.commit();

      expect(trace[0]).toEqual({ path: 'cfg\u001Fnum', verb: 'set' });
      expect(trace[1]).toEqual({ path: 'cfg\u001Ftags', verb: 'merge' });
    });
  });

  /* ---------------------------------------------------------------------- */
  describe('commit resets stage state', () => {
    it('new write after commit starts fresh patch bucket', () => {
      const ctx = new WriteBuffer(base);

      ctx.set(['cfg', 'num'], 99);
      ctx.commit(); // first flush

      ctx.merge(['cfg', 'tags'], ['z']); // new stage write
      const { overwrite, updates } = ctx.commit();

      expect(overwrite).toEqual({}); // overwrite bucket is empty
      expect(Object.keys(updates).length).toBe(1);
    });
  });
});

describe('WriteBuffer redaction flags', () => {
  const base = { chat: { dummy: 1 } };
  const flatPath = `chat${DELIM}secret`; // norm(['chat','secret'])
  const nested = ['chat', 'secret'] as const;
  it('records path when set(..., shouldRedact=true)', () => {
    const mem = new WriteBuffer(base);
    mem.set([...nested], 'TOP-SECRET', true);
    const { redactedPaths } = mem.commit();
    expect(redactedPaths).toEqual(new Set([flatPath]));
  });
  it('records path when merge(..., shouldRedact=true)', () => {
    const mem = new WriteBuffer(base);
    mem.merge(['chat', 'profile'], { ssn: '123' }, true);
    const { redactedPaths } = mem.commit();
    expect(redactedPaths).toEqual(new Set([`chat${DELIM}profile`]));
  });
  it('does NOT record path when shouldRedact is false / omitted', () => {
    const mem = new WriteBuffer(base);
    mem.set([...nested], '123', /* shouldRedact = */ false);
    const { redactedPaths } = mem.commit();
    expect(redactedPaths.size).toBe(0);
  });
  it('clears redactedPaths after commit()', () => {
    const mem = new WriteBuffer(base);
    mem.set([...nested], 'FIRST', true);
    mem.commit(); // first commit
    // second round: no ops; commit should return empty set
    const { redactedPaths } = mem.commit();
    expect(redactedPaths.size).toBe(0);
  });
});
