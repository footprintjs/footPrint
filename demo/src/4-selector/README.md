# Demo 4: Multi-Choice Parallel

**Pattern:** Selector  
**Complexity:** ⭐⭐⭐  
**Time:** 15 minutes

## What You'll Learn

- Dynamic multi-choice branching with `addSelector()`
- Selector functions that return arrays of branch IDs
- Parallel execution of selected branches only

## The Flow

```
                    ┌─────────────┐
                ┌──▶│  SendEmail  │──┐
┌──────────────┐│   └─────────────┘  │   ┌─────────────────┐
│ AnalyzePrefs │┼──▶│   SendSMS   │──┼──▶│ ConfirmDelivery │
└──────────────┘│   └─────────────┘  │   └─────────────────┘
                └──▶│  SendPush   │──┘
                    └─────────────┘
                    (only selected channels execute)
```

## Key Concepts

### 1. Selector vs Decider

| Feature | Decider | Selector |
|---------|---------|----------|
| Children executed | Exactly 1 | 0 to N |
| Return type | Single ID | Array of IDs |
| Use case | Routing | Dynamic parallel |

### 2. Selector Function

Returns an array of branch IDs to execute in parallel:

```typescript
const notificationSelector = (output: any): string[] => {
  const channels: string[] = [];
  const prefs = output?.prefs || {};

  if (prefs.email) channels.push('email');
  if (prefs.sms) channels.push('sms');
  if (prefs.push) channels.push('push');

  return channels;  // ['email', 'push'] → only these execute
};
```

### 3. Building with Selector

```typescript
new FlowChartBuilder()
  .start('AnalyzePrefs', analyzeFn)
  .addSelector(notificationSelector)
    .addFunctionBranch('email', 'SendEmail', emailFn)
    .addFunctionBranch('sms', 'SendSMS', smsFn)
    .addFunctionBranch('push', 'SendPush', pushFn)
    .end()
  .addFunction('ConfirmDelivery', confirmFn);
```

### 4. Dynamic Execution

```
Test 1: { email: true, sms: true, push: true }
  → Executes: SendEmail, SendSMS, SendPush (all 3)

Test 2: { email: true, sms: false, push: true }
  → Executes: SendEmail, SendPush (2 of 3)

Test 3: { email: false, sms: true, push: false }
  → Executes: SendSMS (1 of 3)
```

## Run It

```bash
npx ts-node -r tsconfig-paths/register -P demo/tsconfig.json demo/src/4-selector/index.ts
```

## Expected Output

```
=== Selector Demo (Multi-Choice Parallel) ===

--- Test 1: {"email":true,"sms":true,"push":true} ---

  [Analyze] Checking user notification preferences...
  [Selector] Selected channels: email, sms, push
  [Email] Sending email notification...
  [SMS] Sending SMS notification...
  [Push] Sending push notification...
  [Confirm] Confirming delivery...

--- Test 2: {"email":true,"sms":false,"push":true} ---

  [Analyze] Checking user notification preferences...
  [Selector] Selected channels: email, push
  [Email] Sending email notification...
  [Push] Sending push notification...
  [Confirm] Confirming delivery...

--- Test 3: {"email":false,"sms":true,"push":false} ---

  [Analyze] Checking user notification preferences...
  [Selector] Selected channels: sms
  [SMS] Sending SMS notification...
  [Confirm] Confirming delivery...

✓ Selector demo complete!
```

## Real-World Use Cases

- **Notification Systems**: Send to user's preferred channels
- **Tool Execution**: Run multiple LLM tools in parallel
- **Feature Flags**: Execute features based on user permissions
- **A/B Testing**: Run selected experiment variants

## Next Steps

→ [Demo 5: Composed](../5-composed/) - Learn to compose entire apps as nodes
