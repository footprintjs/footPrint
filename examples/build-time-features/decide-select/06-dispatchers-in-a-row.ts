/**
 * decide() then select() — two dispatchers in a row
 *
 * `.end()` closes a decider or a selector and leaves the chain on it, so the
 * next `.addDeciderFunction()` / `.addSelectorFunction()` starts a NEW
 * dispatcher right after it. Every chosen branch of the first converges on
 * the second, which then picks from its own branches. Any order works:
 * decider → decider, decider → selector, selector → selector,
 * selector → decider. (Before footprintjs 10.0.1 the builder refused all but
 * the last.)
 *
 * Here a support ticket is routed to ONE queue (decide), then the people to
 * tell are picked — as MANY as the rules match (select). The narrative carries
 * the evidence for both choices.
 *
 * Run: npx tsx examples/build-time-features/decide-select/06-dispatchers-in-a-row.ts
 */

import { decide, flowChart, FlowChartExecutor, select } from 'footprintjs';

interface TicketState {
  severity: number;
  customerTier: string;
  affectsBilling: boolean;
  queue: string;
}

const chart = flowChart<TicketState>('ReceiveTicket', async (scope) => {
  scope.severity = 8;
  scope.customerTier = 'enterprise';
  scope.affectsBilling = true;
}, 'receive-ticket')

  // Dispatcher 1 — a decider: exactly one queue.
  .addDeciderFunction('PickQueue', (scope) => {
    return decide(scope, [
      { when: { severity: { gte: 7 } }, then: 'urgent', label: 'Severity 7 or higher' },
    ], 'standard');
  }, 'pick-queue', 'Route the ticket to one queue')
    .addFunctionBranch('urgent', 'UrgentQueue', async (scope) => {
      scope.queue = 'urgent';
    })
    .addFunctionBranch('standard', 'StandardQueue', async (scope) => {
      scope.queue = 'standard';
    })
    .setDefault('standard')
    .end()

  // Dispatcher 2 — a selector, straight after the decider: every match runs.
  .addSelectorFunction('PickNotifications', (scope) => {
    return select(scope, [
      { when: { customerTier: { eq: 'enterprise' } }, then: 'account-manager', label: 'Enterprise customer' },
      { when: { affectsBilling: { eq: true } }, then: 'billing', label: 'Billing is affected' },
      { when: { severity: { gte: 9 } }, then: 'on-call', label: 'Severity 9 or higher' },
    ]);
  }, 'pick-notifications', 'Tell everyone the ticket concerns')
    .addFunctionBranch('account-manager', 'NotifyAccountManager', async () => {
      console.log('  notified: account manager');
    })
    .addFunctionBranch('billing', 'NotifyBilling', async () => {
      console.log('  notified: billing team');
    })
    .addFunctionBranch('on-call', 'PageOnCall', async () => {
      console.log('  notified: on-call engineer');
    })
    .end()

  .addFunction('Acknowledge', async (scope) => {
    console.log(`  ticket acknowledged in the ${scope.queue} queue`);
  }, 'acknowledge')
  .build();

(async () => {
  const executor = new FlowChartExecutor(chart);
  executor.enableNarrative();
  await executor.run();

  console.log('\nNarrative (evidence for both choices):');
  executor.getNarrativeEntries().map((e) => e.text).forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
