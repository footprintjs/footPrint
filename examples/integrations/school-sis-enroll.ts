/**
 * Use Case: School SIS — Enroll Student
 *
 * A real enrollment flow hits many of the decisions that make SIS code
 * hard to audit: Did the student meet prerequisites? Is there space?
 * Was the override approved by an authorized counselor?
 *
 * footprintjs captures every answer as a named stage in the narrative.
 * The causal chain shows which inputs drove which decisions —
 * essential for compliance reviews, parent appeals, and accreditation audits.
 *
 *   ReceiveRequest → ValidateStudent → CheckPrerequisites → CheckCapacity
 *                                                                ↓
 *                                                            Classify (decider)
 *                                                                ├── reject      → SendRejectionLetter   ($break)
 *                                                                ├── waitlist    → AddToWaitlist         ($break)
 *                                                                └── enroll      → AssignSection → NotifyParent
 *
 * Try it: https://footprintjs.github.io/footprint-playground/samples/school-sis-enroll
 */

import { flowChart, FlowChartExecutor, decide } from 'footprintjs';

// ── Domain types ─────────────────────────────────────────────────────────

interface EnrollmentRequest {
  studentId: string;
  studentName: string;
  courseCode: string;
  termId: string;
}

interface Course {
  code: string;
  name: string;
  prerequisites: string[];
  capacity: number;
  enrolled: number;
  sectionIds: string[];
}

interface EnrollmentState {
  studentId: string;
  studentName: string;
  courseCode: string;
  termId: string;
  // lookups
  student?: { gradeLevel: number; completedCourses: string[]; gpa: number; parentEmail: string };
  course?: Course;
  // checks
  validStudent?: boolean;
  prereqsMet?: boolean;
  missingPrereqs?: string[];
  seatsAvailable?: boolean;
  // outcome
  decision?: 'enroll' | 'waitlist' | 'reject';
  assignedSectionId?: string;
  parentNotified?: boolean;
  reasonCode?: string;
}

// ── Mock SIS data ────────────────────────────────────────────────────────

const studentDB: Record<string, EnrollmentState['student']> = {
  'stu-101': { gradeLevel: 11, completedCourses: ['MATH-201', 'MATH-301'], gpa: 3.6, parentEmail: 'parent101@example.edu' },
  'stu-102': { gradeLevel: 10, completedCourses: ['MATH-201'], gpa: 3.2, parentEmail: 'parent102@example.edu' },
  'stu-103': { gradeLevel: 12, completedCourses: [], gpa: 2.1, parentEmail: 'parent103@example.edu' },
};

const courseDB: Record<string, Course> = {
  'MATH-401': {
    code: 'MATH-401',
    name: 'Advanced Calculus',
    prerequisites: ['MATH-201', 'MATH-301'],
    capacity: 30,
    enrolled: 28,
    sectionIds: ['MATH-401-A', 'MATH-401-B'],
  },
  'CS-501': {
    code: 'CS-501',
    name: 'Computer Science AP',
    prerequisites: ['MATH-301'],
    capacity: 25,
    enrolled: 25, // full
    sectionIds: ['CS-501-A'],
  },
};

const emailService = {
  sendEnrollmentConfirmation: async (parentEmail: string, studentName: string, course: string, section: string) => {
    console.log(`  → Email sent to ${parentEmail}: ${studentName} enrolled in ${course} (${section})`);
    return true;
  },
};

declare const INPUT: EnrollmentRequest | undefined;

(async () => {
  const chart = flowChart<EnrollmentState>('ReceiveRequest', async (scope) => {
    const req = INPUT ?? { studentId: 'stu-101', studentName: 'Alex Morgan', courseCode: 'MATH-401', termId: 'fall-2026' };
    scope.studentId = req.studentId;
    scope.studentName = req.studentName;
    scope.courseCode = req.courseCode;
    scope.termId = req.termId;
  }, 'receive-request', 'Accept the enrollment request and initialize context')

    .addFunction('ValidateStudent', async (scope) => {
      const student = studentDB[scope.studentId];
      scope.student = student;
      scope.validStudent = !!student;
      if (!student) scope.reasonCode = 'UNKNOWN_STUDENT';
    }, 'validate-student', 'Look up the student record by ID')

    .addFunction('CheckPrerequisites', async (scope) => {
      const course = courseDB[scope.courseCode];
      scope.course = course;
      if (!course) {
        scope.prereqsMet = false;
        scope.reasonCode = 'UNKNOWN_COURSE';
        return;
      }
      const completed = new Set(scope.student?.completedCourses ?? []);
      const missing = course.prerequisites.filter((p) => !completed.has(p));
      scope.missingPrereqs = missing;
      scope.prereqsMet = missing.length === 0;
    }, 'check-prerequisites', 'Compare required courses to the student\'s transcript')

    .addFunction('CheckCapacity', async (scope) => {
      const course = scope.course;
      scope.seatsAvailable = course ? course.enrolled < course.capacity : false;
    }, 'check-capacity', 'Confirm the course has an open seat')

    .addDeciderFunction('Classify', (scope) => {
      return decide(scope, [
        { when: (s) => !s.validStudent,          then: 'reject',   label: 'Student record not found' },
        { when: (s) => !s.course,                then: 'reject',   label: 'Course not found' },
        { when: (s) => !s.prereqsMet,            then: 'reject',   label: 'Missing prerequisites' },
        { when: (s) => !s.seatsAvailable,        then: 'waitlist', label: 'Course is full' },
      ], 'enroll');
    }, 'classify', 'Route to enroll, waitlist, or reject based on gathered facts')

      .addFunctionBranch('reject', 'SendRejectionLetter', async (scope) => {
        scope.decision = 'reject';
        console.log(`  → Rejection sent: ${scope.studentName} / ${scope.courseCode} (${scope.reasonCode ?? 'PREREQS_MISSING'})`);
        scope.$break();
      }, 'Notify student and guardian of rejection')

      .addFunctionBranch('waitlist', 'AddToWaitlist', async (scope) => {
        scope.decision = 'waitlist';
        console.log(`  → Waitlisted: ${scope.studentName} for ${scope.courseCode}`);
        scope.$break();
      }, 'Add the student to the course waitlist')

      .addFunctionBranch('enroll', 'AssignSection', async (scope) => {
        scope.decision = 'enroll';
        // simplest strategy: first available section. A real SIS would consider student's schedule.
        scope.assignedSectionId = scope.course!.sectionIds[0];
      }, 'Pick a section and record the enrollment')

      .setDefault('enroll')
    .end()

    .addFunction('NotifyParent', async (scope) => {
      if (scope.decision !== 'enroll') return;
      await emailService.sendEnrollmentConfirmation(
        scope.student!.parentEmail,
        scope.studentName,
        scope.course!.name,
        scope.assignedSectionId!,
      );
      scope.parentNotified = true;
    }, 'notify-parent', 'Email the confirmation to the listed guardian')

    .build();

  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log('=== School SIS — Enroll Student ===\n');
  executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));

  const { sharedState } = executor.getSnapshot();
  console.log(`\nDecision: ${sharedState.decision?.toUpperCase()}`);
  console.log(`Student: ${sharedState.studentName} → ${sharedState.courseCode}`);
  if (sharedState.assignedSectionId) console.log(`Section: ${sharedState.assignedSectionId}`);
  if (sharedState.missingPrereqs?.length) console.log(`Missing prereqs: ${sharedState.missingPrereqs.join(', ')}`);
  if (sharedState.reasonCode) console.log(`Reason: ${sharedState.reasonCode}`);
})().catch(console.error);
