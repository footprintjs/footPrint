/**
 * Flowchart: Lazy Subflow Resolution (Graph-of-Services Pattern)
 *
 * When building a "graph of services" (e.g., microservice orchestrator),
 * each service is its own flowchart (subflow). With eager mounting
 * (`addSubFlowChartBranch`), ALL service trees are cloned at build time --
 * even services that never run. At 50+ services, this is wasteful.
 *
 * `addLazySubFlowChartBranch` stores a factory function instead. The engine
 * calls it only when the branch is selected at runtime. Unselected services
 * pay zero cost -- no tree cloning, no registration.
 *
 * Visual difference:
 *   - Build-time spec: lazy nodes have `isLazy: true` -> dashed border + cloud icon
 *   - After execution: resolved nodes look identical to eager subflows
 *
 * This example: a request router with 3 lazy service branches.
 * The selector picks 2 of 3 -- only those 2 resolve.
 *
 *   Router -> Selector -> [Auth, Payment, Notification] -> Response
 *             picks ['auth','payment']
 *             -> Auth resolves + executes
 *             -> Payment resolves + executes
 *             -> Notification: never resolved (zero cost)
 */

import {
  flowChart,
  
  FlowChartBuilder,
  FlowChartExecutor,
  ManifestFlowRecorder,
  type TypedScope,
} from 'footprintjs';

// -- State interfaces ---------------------------------------------------------

interface AuthState {
  tokenValid: boolean;
  authorized: boolean;
}

interface PaymentState {
  chargeId: string;
  paymentStatus: string;
}

interface NotificationState {
  emailSent: boolean;
  smsSent: boolean;
}

interface OrchestratorState {
  requiredServices: string[];
  requestId: string;
  tokenValid?: boolean;
  authorized?: boolean;
  chargeId?: string;
  paymentStatus?: string;
  emailSent?: boolean;
  smsSent?: boolean;
  responseStatus: number;
  responseBody: { success: boolean };
}

(async () => {

// -- Define services as standalone flowcharts ---------------------------------

const authService = new FlowChartBuilder<any, TypedScope<AuthState>>()
  .start(
    'Validate Token',
    (scope) => {
      scope.tokenValid = true;
    },
    'validate-token',
    'Validate the JWT and extract claims',
  )
  .addFunction(
    'Check Permissions',
    (scope) => {
      scope.authorized = true;
    },
    'check-perms',
    'Verify user has required permissions',
  )
  .build();

const paymentService = new FlowChartBuilder<any, TypedScope<PaymentState>>()
  .start(
    'Create Charge',
    (scope) => {
      scope.chargeId = 'ch_' + Date.now();
    },
    'create-charge',
    'Create a payment charge via Stripe',
  )
  .addFunction(
    'Confirm Payment',
    (scope) => {
      scope.paymentStatus = 'confirmed';
    },
    'confirm-payment',
    'Wait for payment confirmation webhook',
  )
  .build();

const notificationService = new FlowChartBuilder<any, TypedScope<NotificationState>>()
  .start(
    'Send Email',
    (scope) => {
      scope.emailSent = true;
    },
    'send-email',
    'Send transactional email via SendGrid',
  )
  .addFunction(
    'Send SMS',
    (scope) => {
      scope.smsSent = true;
    },
    'send-sms',
    'Send SMS notification via Twilio',
  )
  .build();

// -- Track which resolvers are called -----------------------------------------

const resolverLog: string[] = [];

// -- Orchestrator -- lazy selector with 3 service branches --------------------

const chart = flowChart<OrchestratorState>(
  'Parse Request',
  (scope) => {
    scope.requiredServices = ['auth', 'payment'];
    scope.requestId = 'req-' + Date.now();
  },
  'parse-request',
  undefined,
  'Parse incoming request and determine required services',
)
  .addSelectorFunction(
    'Route Services',
    (scope): string[] => {
      return scope.requiredServices;
    },
    'route-services',
    'Select which services to invoke based on request type',
  )
    // All three branches are LAZY -- no tree cloning at build time
    .addLazySubFlowChartBranch('auth', () => {
      resolverLog.push('auth');
      return authService;
    }, 'Auth Service')
    .addLazySubFlowChartBranch('payment', () => {
      resolverLog.push('payment');
      return paymentService;
    }, 'Payment Service')
    .addLazySubFlowChartBranch('notification', () => {
      resolverLog.push('notification');
      return notificationService;
    }, 'Notification Service')
    .end()
  .addFunction(
    'Build Response',
    (scope) => {
      scope.responseStatus = 200;
      scope.responseBody = { success: true };
    },
    'build-response',
    'Aggregate service results into HTTP response',
  )

  .build();

// -- Inspect build-time spec -- lazy nodes are stubs --------------------------

console.log('=== Lazy Subflow Resolution (Graph-of-Services) ===\n');

const spec = chart.buildTimeStructure;
const routeSpec = spec.next!;
const children = routeSpec.children!;

console.log('Build-time spec children:');
for (const child of children) {
  console.log(`  ${child.name}: isLazy=${child.isLazy}, subflowStructure=${child.subflowStructure ? 'present' : 'none'}`);
}

console.log(`\nSubflows registered at build time: ${chart.subflows ? Object.keys(chart.subflows).length : 0} (expected: 0)`);

// -- Execute ------------------------------------------------------------------

const executor = new FlowChartExecutor(chart);
executor.attachFlowRecorder(new ManifestFlowRecorder());
await executor.run();

// -- Results ------------------------------------------------------------------

console.log(`\nResolvers called: [${resolverLog.join(', ')}] (notification was NOT called)`);

console.log('\nNarrative:');
executor.getNarrative().forEach((line) => console.log(`  ${line}`));

const snap = executor.getSnapshot();
console.log('\nScope (selected services wrote their data):');
console.log(`  tokenValid: ${snap?.sharedState?.tokenValid}`);
console.log(`  chargeId: ${snap?.sharedState?.chargeId}`);
console.log(`  paymentStatus: ${snap?.sharedState?.paymentStatus}`);
console.log(`  emailSent: ${snap?.sharedState?.emailSent ?? 'undefined (never ran)'}`);
console.log(`  responseStatus: ${snap?.sharedState?.responseStatus}`);

console.log(`\nSubflow results: ${executor.getSubflowResults().size} (auth + payment)`);

})().catch(console.error);
