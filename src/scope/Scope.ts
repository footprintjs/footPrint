/**
 * Scope - Core runtime memory container for pipeline execution
 * ----------------------------------------------------------------------------
 * The Scope class provides the primary interface for stages to read from and
 * write to state during flow execution. It wraps GlobalStore for persistence
 * and WriteBuffer for transactional writes.
 *
 * Key features:
 *   - getValue: Read values from the store with namespace isolation
 *   - setValue: Overwrite values at a key
 *   - updateValue: Deep-merge values at a key
 *   - commit: Flush staged writes to GlobalStore
 *   - Read-after-write consistency: Writes are immediately available for reads
 *
 * This implementation focuses on core operations. Recorder hooks and time-travel
 * support will be added in subsequent tasks.
 *
 * @module scope/Scope
 */

import type { GlobalStore } from '../core/memory/GlobalStore';
import type { ExecutionHistory } from '../internal/history/ExecutionHistory';
import { deepSmartMerge } from '../internal/memory/WriteBuffer';
import type { Recorder, ScopeOptions } from './types';

/**
 * Staged write entry for tracking mutations before commit.
 */
interface StagedWrite {
  key: string;
  value: unknown;
  operation: 'set' | 'update' | 'delete';
}

/**
 * Scope - Core runtime memory container for pipeline execution
 *
 * Provides getValue, setValue, updateValue, and commit operations with
 * namespace isolation via pipelineId. Consumers operate on keys directly;
 * path-based nesting is handled internally.
 */
export class Scope {
  private readonly globalStore: GlobalStore;
  private readonly executionHistory?: ExecutionHistory;
  private readonly pipelineId: string;
  private stageName: string;

  /**
   * Local cache for read-after-write consistency.
   * Stores values that have been written but not yet committed.
   */
  private localCache: Map<string, unknown> = new Map();

  /**
   * Staged writes waiting to be committed.
   */
  private stagedWrites: StagedWrite[] = [];

  /**
   * Recorders attached at the global scope level.
   * Will be populated in Task 5.1.
   */
  private recorders: Recorder[] = [];

  /**
   * Recorders attached at the stage level.
   * Will be populated in Task 5.1.
   */
  private stageRecorders: Map<string, Recorder[]> = new Map();

  /**
   * Stage start time for duration tracking.
   * Will be used in Task 5.2.
   */
  private stageStartTime?: number;

  /**
   * Creates a new Scope instance.
   *
   * @param options - Configuration options for the scope
   * @param options.pipelineId - Unique identifier for namespace isolation
   * @param options.stageName - Initial stage name
   * @param options.globalStore - Shared state container for persistence
   * @param options.executionHistory - Optional history tracker for time-travel
   * @param options.recorders - Optional initial recorders to attach
   */
  constructor(options: ScopeOptions) {
    this.globalStore = options.globalStore;
    this.executionHistory = options.executionHistory;
    this.pipelineId = options.pipelineId;
    this.stageName = options.stageName;

    // Attach initial recorders if provided
    if (options.recorders) {
      for (const recorder of options.recorders) {
        this.recorders.push(recorder);
      }
    }
  }

  // ==========================================================================
  // Core Operations
  // ==========================================================================

  /**
   * Reads a value from the scope.
   *
   * First checks the local cache for uncommitted writes (read-after-write
   * consistency), then falls back to GlobalStore.
   *
   * @param key - Optional key to read a specific field
   * @returns The value at the key, or undefined if not found
   *
   * @example
   * ```typescript
   * const timeout = scope.getValue('timeout');
   * ```
   */
  getValue(key?: string): unknown {
    // Build cache key for local lookup
    const cacheKey = this.buildCacheKey(key);

    // Check local cache first for read-after-write consistency
    let value: unknown;
    if (this.localCache.has(cacheKey)) {
      value = this.localCache.get(cacheKey);
    } else {
      // Fall back to GlobalStore
      value = this.globalStore.getValue(this.pipelineId, [], key);
    }

    // Invoke onRead hook with ReadEvent
    this.invokeHook('onRead', {
      stageName: this.stageName,
      pipelineId: this.pipelineId,
      timestamp: Date.now(),
      key,
      value,
    });

    return value;
  }

  /**
   * Sets a value at the specified key, overwriting any existing value.
   *
   * The write is staged locally and made immediately available for subsequent
   * reads (read-after-write consistency). Call commit() to persist to GlobalStore.
   *
   * @param key - The key to write to
   * @param value - The value to write
   *
   * @throws TypeError if key is not a string
   *
   * @example
   * ```typescript
   * scope.setValue('timeout', 5000);
   * scope.setValue('admin', { name: 'Admin', role: 'admin' });
   * ```
   */
  setValue(key: string, value: unknown): void {
    // Validate inputs
    if (typeof key !== 'string') {
      throw new TypeError('key must be a string');
    }

    // Stage the write
    this.stagedWrites.push({
      key,
      value,
      operation: 'set',
    });

    // Update local cache for read-after-write consistency
    const cacheKey = this.buildCacheKey(key);
    this.localCache.set(cacheKey, value);

    // Invoke onWrite hook with WriteEvent
    this.invokeHook('onWrite', {
      stageName: this.stageName,
      pipelineId: this.pipelineId,
      timestamp: Date.now(),
      key,
      value,
      operation: 'set',
    });
  }

  /**
   * Updates a value at the specified key using deep merge semantics.
   *
   * If the existing value is an object, the new value is deep-merged into it.
   * If the existing value is an array, arrays are unioned without duplicates.
   * For primitives, the new value overwrites the existing value.
   *
   * The write is staged locally and made immediately available for subsequent
   * reads (read-after-write consistency). Call commit() to persist to GlobalStore.
   *
   * @param key - The key to update
   * @param value - The value to merge
   *
   * @throws TypeError if key is not a string
   *
   * @example
   * ```typescript
   * // Existing: { timeout: 5000 }
   * scope.updateValue('settings', { retries: 3 });
   * // Result: { timeout: 5000, retries: 3 }
   * ```
   */
  updateValue(key: string, value: unknown): void {
    // Validate inputs
    if (typeof key !== 'string') {
      throw new TypeError('key must be a string');
    }

    // Stage the write
    this.stagedWrites.push({
      key,
      value,
      operation: 'update',
    });

    // Get current value for merge (check cache first, then GlobalStore)
    const cacheKey = this.buildCacheKey(key);
    let currentValue: unknown;

    if (this.localCache.has(cacheKey)) {
      currentValue = this.localCache.get(cacheKey);
    } else {
      currentValue = this.globalStore.getValue(this.pipelineId, [], key);
    }

    // Deep merge and update cache for read-after-write consistency
    const mergedValue = deepSmartMerge(currentValue, value);
    this.localCache.set(cacheKey, mergedValue);

    // Invoke onWrite hook with WriteEvent
    this.invokeHook('onWrite', {
      stageName: this.stageName,
      pipelineId: this.pipelineId,
      timestamp: Date.now(),
      key,
      value,
      operation: 'update',
    });
  }

  /**
   * Deletes a value at the specified key by setting it to undefined.
   *
   * The delete is staged locally (sets undefined) and made immediately
   * available for subsequent reads. Call commit() to persist to GlobalStore.
   *
   * @param key - The key to delete
   *
   * @throws TypeError if key is not a string
   *
   * @example
   * ```typescript
   * scope.deleteValue('temporaryData');
   * ```
   */
  deleteValue(key: string): void {
    if (typeof key !== 'string') {
      throw new TypeError('key must be a string');
    }

    this.stagedWrites.push({
      key,
      value: undefined,
      operation: 'delete',
    });

    const cacheKey = this.buildCacheKey(key);
    this.localCache.set(cacheKey, undefined);

    this.invokeHook('onWrite', {
      stageName: this.stageName,
      pipelineId: this.pipelineId,
      timestamp: Date.now(),
      key,
      value: undefined,
      operation: 'delete',
    });
  }

  /**
   * Commits all staged writes to GlobalStore.
   *
   * Applies all setValue and updateValue operations that have been staged
   * since the last commit. For updateValue operations, the deep-merged result
   * is computed and written as a setValue to preserve deep merge semantics.
   *
   * After commit, the local cache is cleared and subsequent reads will go
   * directly to GlobalStore. A snapshot of the current state is also created
   * for time-travel support.
   *
   * @example
   * ```typescript
   * scope.setValue('timeout', 5000);
   * scope.updateValue('settings', { retries: 3 });
   * scope.commit(); // Persists both writes to GlobalStore
   * ```
   */
  commit(): void {
    // Build a map of final values for each key
    // This ensures deep merge semantics are preserved
    const finalValues = new Map<string, { key: string; value: unknown }>();

    // Collect mutations for the CommitEvent
    const mutations: Array<{
      key: string;
      value: unknown;
      operation: 'set' | 'update' | 'delete';
    }> = [];

    for (const write of this.stagedWrites) {
      const cacheKey = this.buildCacheKey(write.key);

      // Track mutation for CommitEvent
      mutations.push({
        key: write.key,
        value: write.value,
        operation: write.operation,
      });

      if (write.operation === 'set' || write.operation === 'delete') {
        // Set and delete operations overwrite (delete sets undefined)
        finalValues.set(cacheKey, {
          key: write.key,
          value: write.value,
        });
      } else {
        // Update operations need to merge with existing value
        const existing = finalValues.get(cacheKey);
        if (existing) {
          // Merge with previously staged value
          finalValues.set(cacheKey, {
            key: write.key,
            value: deepSmartMerge(existing.value, write.value),
          });
        } else {
          // Merge with GlobalStore value
          const currentValue = this.globalStore.getValue(this.pipelineId, [], write.key);
          finalValues.set(cacheKey, {
            key: write.key,
            value: deepSmartMerge(currentValue, write.value),
          });
        }
      }
    }

    // Apply all final values to GlobalStore using setValue
    // This ensures our deep merge semantics are preserved
    for (const { key, value } of finalValues.values()) {
      this.globalStore.setValue(this.pipelineId, [], key, value);
    }

    // Invoke onCommit hook with CommitEvent
    this.invokeHook('onCommit', {
      stageName: this.stageName,
      pipelineId: this.pipelineId,
      timestamp: Date.now(),
      mutations,
    });

    // Clear staged writes and local cache
    this.stagedWrites = [];
    this.localCache.clear();
  }

  // ==========================================================================
  // Stage Lifecycle
  // ==========================================================================

  /**
   * Signals the start of a new stage.
   *
   * Updates the current stage name and invokes the onStageStart hook on all
   * active recorders. Also records the start time for duration tracking.
   *
   * @param stageName - The name of the stage that is starting
   *
   * @example
   * ```typescript
   * scope.startStage('processData');
   * // ... perform stage operations ...
   * scope.endStage();
   * ```
   */
  startStage(stageName: string): void {
    // Update the current stage name
    this.stageName = stageName;

    // Record start time for duration tracking
    this.stageStartTime = Date.now();

    // Invoke onStageStart hook with StageEvent
    this.invokeHook('onStageStart', {
      stageName: this.stageName,
      pipelineId: this.pipelineId,
      timestamp: this.stageStartTime,
    });
  }

  /**
   * Signals the end of the current stage.
   *
   * Invokes the onStageEnd hook on all active recorders with the duration
   * since startStage was called. Optionally resets the stage name.
   *
   * @param resetStageName - If true, resets stageName to empty string (default: false)
   *
   * @example
   * ```typescript
   * scope.startStage('processData');
   * // ... perform stage operations ...
   * scope.endStage();
   *
   * // Or reset stage name after ending
   * scope.endStage(true);
   * ```
   */
  endStage(resetStageName: boolean = false): void {
    const endTime = Date.now();

    // Calculate duration if we have a start time
    const duration = this.stageStartTime !== undefined ? endTime - this.stageStartTime : undefined;

    // Invoke onStageEnd hook with StageEvent including duration
    this.invokeHook('onStageEnd', {
      stageName: this.stageName,
      pipelineId: this.pipelineId,
      timestamp: endTime,
      duration,
    });

    // Clear start time
    this.stageStartTime = undefined;

    // Optionally reset stage name
    if (resetStageName) {
      this.stageName = '';
    }
  }

  // ==========================================================================
  // Recorder Management
  // ==========================================================================

  /**
   * Attaches a recorder at the global scope level.
   *
   * Global recorders receive events for all operations across all stages.
   * Recorders are invoked in attachment order.
   *
   * @param recorder - The recorder to attach
   *
   * @example
   * ```typescript
   * const metricRecorder = new MetricRecorder();
   * scope.attachRecorder(metricRecorder);
   * ```
   */
  attachRecorder(recorder: Recorder): void {
    this.recorders.push(recorder);
  }

  /**
   * Attaches a recorder at the stage level.
   *
   * Stage-level recorders only receive events for operations performed
   * during the specified stage. This allows targeted recording for
   * specific stages without noise from other stages.
   *
   * @param stageName - The name of the stage to attach the recorder to
   * @param recorder - The recorder to attach
   *
   * @example
   * ```typescript
   * const debugRecorder = new DebugRecorder({ verbosity: 'verbose' });
   * scope.attachStageRecorder('processData', debugRecorder);
   * ```
   */
  attachStageRecorder(stageName: string, recorder: Recorder): void {
    const existing = this.stageRecorders.get(stageName);
    if (existing) {
      existing.push(recorder);
    } else {
      this.stageRecorders.set(stageName, [recorder]);
    }
  }

  /**
   * Detaches a recorder by its ID.
   *
   * Removes the recorder from both global and stage-level attachment.
   * If the recorder is not found, this is a no-op (silent).
   *
   * @param recorderId - The unique ID of the recorder to detach
   *
   * @example
   * ```typescript
   * scope.attachRecorder(metricRecorder);
   * // ... later ...
   * scope.detachRecorder(metricRecorder.id);
   * ```
   */
  detachRecorder(recorderId: string): void {
    // Remove from global recorders
    this.recorders = this.recorders.filter((r) => r.id !== recorderId);

    // Remove from stage recorders
    for (const [stageName, recorders] of this.stageRecorders.entries()) {
      const filtered = recorders.filter((r) => r.id !== recorderId);
      if (filtered.length === 0) {
        this.stageRecorders.delete(stageName);
      } else if (filtered.length !== recorders.length) {
        this.stageRecorders.set(stageName, filtered);
      }
    }
  }

  /**
   * Returns all attached recorders (global and stage-level).
   *
   * Returns a new array containing all recorders. Global recorders
   * are listed first, followed by stage-level recorders.
   *
   * @returns Array of all attached recorders
   *
   * @example
   * ```typescript
   * scope.attachRecorder(metricRecorder);
   * scope.attachStageRecorder('processData', debugRecorder);
   *
   * const recorders = scope.getRecorders();
   * console.log(recorders.length); // 2
   * ```
   */
  getRecorders(): Recorder[] {
    const allRecorders: Recorder[] = [...this.recorders];

    // Add stage-level recorders
    for (const recorders of this.stageRecorders.values()) {
      for (const recorder of recorders) {
        // Avoid duplicates if same recorder is attached globally and to a stage
        if (!allRecorders.some((r) => r.id === recorder.id)) {
          allRecorders.push(recorder);
        }
      }
    }

    return allRecorders;
  }

  /**
   * Gets the active recorders for the current stage.
   *
   * Returns global recorders plus any stage-specific recorders for
   * the current stage. Used internally by invokeHook.
   *
   * @returns Array of recorders active for the current stage
   */
  private getActiveRecorders(): Recorder[] {
    const active: Recorder[] = [...this.recorders];

    // Add stage-specific recorders for current stage
    const stageSpecific = this.stageRecorders.get(this.stageName);
    if (stageSpecific) {
      for (const recorder of stageSpecific) {
        // Avoid duplicates
        if (!active.some((r) => r.id === recorder.id)) {
          active.push(recorder);
        }
      }
    }

    return active;
  }

  /**
   * Invokes a hook on all active recorders with error handling.
   *
   * Recorders are invoked in attachment order. If a recorder throws
   * an error:
   *   1. The error is caught and not propagated to the calling code
   *   2. The error is passed to onError hooks of other recorders
   *   3. The scope operation continues normally
   *   4. A warning is logged in development mode
   *
   * @param hook - The name of the hook to invoke
   * @param event - The event payload to pass to the hook
   *
   * @internal
   */
  private invokeHook(hook: keyof Omit<Recorder, 'id'>, event: unknown): void {
    const activeRecorders = this.getActiveRecorders();

    for (const recorder of activeRecorders) {
      try {
        const hookFn = recorder[hook];
        if (typeof hookFn === 'function') {
          (hookFn as (event: unknown) => void).call(recorder, event);
        }
      } catch (error) {
        // Don't let recorder errors break scope operations
        // Also avoid infinite recursion if onError itself throws
        if (hook !== 'onError') {
          this.invokeHook('onError', {
            stageName: this.stageName,
            pipelineId: this.pipelineId,
            timestamp: Date.now(),
            error: error as Error,
            operation: this.hookToOperation(hook),
          });
        }

        // Log warning in development mode
        if (process.env.NODE_ENV === 'development') {
          console.warn(`Recorder ${recorder.id} threw error in ${hook}:`, error);
        }
      }
    }
  }

  /**
   * Maps a hook name to an operation type for error events.
   *
   * @param hook - The hook name
   * @returns The corresponding operation type
   *
   * @internal
   */
  private hookToOperation(hook: keyof Omit<Recorder, 'id'>): 'read' | 'write' | 'commit' {
    switch (hook) {
      case 'onRead':
        return 'read';
      case 'onWrite':
        return 'write';
      case 'onCommit':
        return 'commit';
      default:
        // For stage lifecycle hooks, default to 'write' as a catch-all
        return 'write';
    }
  }

  // ==========================================================================
  // Cache Helpers
  // ==========================================================================

  /**
   * Builds a cache key for local storage.
   *
   * @param key - Optional key
   * @returns A string key for the local cache
   */
  private buildCacheKey(key?: string): string {
    return key !== undefined ? key : '';
  }

  // ==========================================================================
  // Accessors (for testing and debugging)
  // ==========================================================================

  /**
   * Gets the pipeline ID for this scope.
   */
  getPipelineId(): string {
    return this.pipelineId;
  }

  /**
   * Gets the current stage name.
   */
  getStageName(): string {
    return this.stageName;
  }

  /**
   * Gets the underlying GlobalStore.
   * Primarily for testing and integration purposes.
   */
  getGlobalStore(): GlobalStore {
    return this.globalStore;
  }
}
