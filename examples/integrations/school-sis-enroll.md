---
name: School SIS — Enroll Student
group: Use Cases
guide: https://footprintjs.github.io/footPrint/guides/patterns/real-world-composition/
---

# School SIS — Enroll Student

Student enrollment is one of those workflows where **every decision leaves a consequence**. A missed prerequisite means a failed class. A waitlisted student means an angry parent. A wrongly approved override means an audit finding.

A footprintjs flowchart turns the enrollment process into a narrative trace that answers every question a counselor, parent, or accreditation reviewer might ask — six months later, from the logs alone.

```
ReceiveRequest → ValidateStudent → CheckPrerequisites → CheckCapacity
                                                              ↓
                                                         Classify (decider)
                                                              ├── reject   → SendRejectionLetter  ($break)
                                                              ├── waitlist → AddToWaitlist        ($break)
                                                              └── enroll   → AssignSection → NotifyParent
```

## Why this matters for SIS

Compare the traces:

**Traditional SIS log:**
> `2026-04-16T10:42:11 INFO  EnrollmentService: Request rejected`

**footprintjs narrative:**
> 1. [Stage: ReceiveRequest] Process began. Student stu-103, course MATH-401.
> 2. [Stage: ValidateStudent] Student found.
> 3. [Stage: CheckPrerequisites] Required MATH-201, MATH-301. Completed: none. Missing: MATH-201, MATH-301.
> 4. [Stage: CheckCapacity] 28/30 enrolled, seats available.
> 5. [Stage: Classify] Decider evaluated 4 rules:
>    - Rule 2 'Missing prerequisites' matched → reject
> 6. [Stage: SendRejectionLetter] Rejection sent. Execution stopped due to break.

A parent appeals? The counselor has the full story. The auditor asks *"why was stu-103 rejected?"* — every fact and every rule is right there.

## What this showcases

- **Typed state** (`EnrollmentState`) — compile-time safety across 8 fields, from `studentId` to `assignedSectionId`.
- **Sequential validation** — ValidateStudent → CheckPrerequisites → CheckCapacity. Each stage runs ONLY if prior stages wrote the data it needs.
- **`decide()` with first-match semantics** — rejection reasons take priority over waitlist, which takes priority over enroll. Order of rules = order of business logic.
- **`$break` for terminal paths** — rejected and waitlisted students don't flow into AssignSection. No flag-carrying or if-guards needed.
- **Stage descriptions** — each `.addFunction(..., 'description')` teaches the next reader (or LLM) what the stage does, without reading the code.

## Anatomy

```typescript
flowChart<EnrollmentState>('ReceiveRequest', ...)
  .addFunction('ValidateStudent', ...)          // lookup student
  .addFunction('CheckPrerequisites', ...)       // compare transcript to requirements
  .addFunction('CheckCapacity', ...)            // open seats?
  .addDeciderFunction('Classify', (scope) =>
    decide(scope, [
      { when: (s) => !s.validStudent,   then: 'reject',   label: 'Student record not found' },
      { when: (s) => !s.course,         then: 'reject',   label: 'Course not found' },
      { when: (s) => !s.prereqsMet,     then: 'reject',   label: 'Missing prerequisites' },
      { when: (s) => !s.seatsAvailable, then: 'waitlist', label: 'Course is full' },
    ], 'enroll'))
    .addFunctionBranch('reject',   'SendRejectionLetter', ...)   // $break
    .addFunctionBranch('waitlist', 'AddToWaitlist',       ...)   // $break
    .addFunctionBranch('enroll',   'AssignSection',       ...)
    .setDefault('enroll')
    .end()
  .addFunction('NotifyParent', ...)             // only enroll reaches here
  .build();
```

## Playing with it

Try different INPUT values to trigger each branch:

```json
// Default: enroll — stu-101 has all prereqs, MATH-401 has seats
{}

// Reject: stu-103 has no completed courses
{ "studentId": "stu-103", "studentName": "Jordan Lee", "courseCode": "MATH-401", "termId": "fall-2026" }

// Waitlist: CS-501 is full (25/25)
{ "studentId": "stu-102", "studentName": "Sam Patel", "courseCode": "CS-501", "termId": "fall-2026" }
```

Then open **Inspector → Data Trace** and click `NotifyParent` — you'll see the full backward chain: NotifyParent came from AssignSection came from Classify's decision came from CheckCapacity + CheckPrerequisites, etc. Every causal link, visible.

## Real-world extensions

- **Counselor override** with `.addPausableFunction` — when prereqs are missing, pause for an authorized counselor to approve/reject the override. Checkpoint is JSON-safe (Redis-storable).
- **Multi-section scheduling** — replace `AssignSection`'s "pick first" strategy with a real scheduling subflow that considers the student's existing schedule.
- **Email delivery via recorder** — move email side-effects out of stages and into a `FlowRecorder.onDecision` listener, so business logic stays pure.
- **Redaction for PII** — wrap the executor with `setRedactionPolicy({ keys: ['parentEmail', 'gpa'] })` before shipping traces to any external audit system.

## Related

- **[Decider (Conditional)](../building-blocks/03-decider.md)** — the primitive powering the reject/waitlist/enroll decision.
- **[Loan Application](./loan-application.ts)** — a similar shape for a very different domain.
- **[Causal Chain](../post-execution/causal-chain/01-linear.md)** — trace any output value back to the inputs that produced it.
