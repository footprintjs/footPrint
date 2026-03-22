# reactive/ -- TypedScope Deep Proxy System

Internal package for footprintjs. Provides typed property access to pipeline scope state via JavaScript Proxy.

## What It Does

Wraps a ReactiveTarget (ScopeFacade) in a Proxy so stage functions get typed, natural JS access:

```typescript
// Before: untyped, cast everywhere
scope.getValue('creditTier') as string
scope.setValue('amount', 50000)

// After: typed, natural JS
scope.creditTier   // string (typed)
scope.amount = 50000  // type-checked write
scope.customer.address.zip = '90210'  // deep write, tracked
scope.tags.push('vip')  // array mutation, tracked
```

## Read Semantics

- scope.fieldName calls getValue -- fires onRead ONCE
- scope.customer.address.zip fires onRead for 'customer' only -- nested navigates in-memory
- scope.$read('customer.address.zip') fires onRead for 'customer', uses lodash.get for nested path

## Write Semantics

- scope.fieldName = value calls setValue -- fires onWrite
- scope.customer.address.zip = '90210' calls updateValue with deep path -- fires onWrite once
- scope.tags.push('vip') clones array, applies mutation, calls setValue -- copy-on-write

## $-Prefixed Methods

Non-enumerable escape hatches (don't appear in Object.keys or destructuring):

$getValue, $setValue, $update, $delete, $read, $getArgs, $getEnv,
$debug, $log, $error, $metric, $eval,
$attachRecorder, $detachRecorder, $getRecorders, $break, $toRaw

## Allowlist

Only plain, unfrozen objects and arrays get deep Proxy wrapping. These are returned unwrapped:
- Date, Map, Set, RegExp, class instances, TypedArrays, Promise, Error, WeakRef
- Object.freeze()'d and Object.seal()'d values (nested set traps would silently fail)

## Performance Guidance

**Arrays:** Each `push`/`splice`/`sort` clones the entire array (copy-on-write). For bulk
operations on large arrays, build the final array and set it once:

```typescript
// Slow: N clones for N pushes (O(n^2) total)
for (const item of items) scope.tags.push(item);

// Fast: one clone (O(n))
scope.tags = [...scope.tags, ...items];
// Or via $setValue:
scope.$setValue('tags', [...scope.$getValue('tags'), ...items]);
```

Same guidance as MobX: prefer batch assignment over repeated mutations for large collections.

## Limitations

- Cannot track if conditions (JS Proxy cannot intercept comparison operators)
- Nested reads fire onRead only at top-level key, not per nested property
- JSON.stringify(scope) fires get traps -- use scope.$toRaw() for serialization
- User state keys starting with $ collide with ScopeMethods
- Class instances in state are returned unwrapped (no deep write tracking)
- Frozen/sealed objects are returned unwrapped (replace entire value to update)
- Circular references: detected via ancestor tracking (Set<object> per access chain).
  At the cycle break point, a terminal proxy is returned -- reads pass through (correct
  values), writes are tracked at any depth (terminal proxies chain for nested objects).
  JSON.stringify on circular scope values strips object-typed keys to prevent errors.
