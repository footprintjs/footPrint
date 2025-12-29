/**
 * Demo 4: Multi-Choice Parallel (Selector Pattern)
 *
 * Shows dynamic multi-choice branching with addSelector().
 */

import { FlowChartBuilder, BaseState } from '@amzn/tree-of-functions';

// Simple scope factory
const scopeFactory = (ctx: any, stageName: string, readOnly?: unknown) => {
  return new BaseState(ctx, stageName, readOnly);
};

// Helper
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Current test preferences (set before each run)
let currentPrefs = { email: true, sms: true, push: true };

// Stage functions
const analyzeNotificationPrefs = async (scope: BaseState) => {
  console.log('  [Analyze] Checking user notification preferences...');
  scope.setObject(['pipeline'], 'prefs', currentPrefs);
  return { prefs: currentPrefs, analyzed: true };
};

const sendEmail = async () => {
  console.log('  [Email] Sending email notification...');
  await sleep(100);
  return { channel: 'email', sent: true, to: 'user@example.com' };
};

const sendSMS = async () => {
  console.log('  [SMS] Sending SMS notification...');
  await sleep(80);
  return { channel: 'sms', sent: true, to: '+1234567890' };
};

const sendPush = async () => {
  console.log('  [Push] Sending push notification...');
  await sleep(60);
  return { channel: 'push', sent: true, deviceId: 'device-abc' };
};

const confirmDelivery = async () => {
  console.log('  [Confirm] Confirming delivery...');
  return { confirmed: true, timestamp: Date.now() };
};

// Selector function - returns array of branch IDs to execute
const notificationSelector = (output: any): string[] => {
  const channels: string[] = [];
  const prefs = output?.prefs || {};

  if (prefs.email) channels.push('email');
  if (prefs.sms) channels.push('sms');
  if (prefs.push) channels.push('push');

  console.log(`  [Selector] Selected channels: ${channels.join(', ') || 'none'}`);
  return channels;
};

// Build the selector flow
export function buildSelectorFlow() {
  return new FlowChartBuilder()
    .start('AnalyzePrefs', analyzeNotificationPrefs)
    .addSelector(notificationSelector)
      .addFunctionBranch('email', 'SendEmail', sendEmail)
      .addFunctionBranch('sms', 'SendSMS', sendSMS)
      .addFunctionBranch('push', 'SendPush', sendPush)
      .end()
    .addFunction('ConfirmDelivery', confirmDelivery)
    .build();
}

// Execute the demo
async function main() {
  console.log('\n=== Selector Demo (Multi-Choice Parallel) ===\n');

  // Test with different preference combinations
  const testCases = [
    { email: true, sms: true, push: true },   // All channels
    { email: true, sms: false, push: true },  // Email + Push only
    { email: false, sms: true, push: false }, // SMS only
  ];

  for (let i = 0; i < testCases.length; i++) {
    currentPrefs = testCases[i];
    console.log(`\n--- Test ${i + 1}: ${JSON.stringify(currentPrefs)} ---\n`);

    const builder = new FlowChartBuilder()
      .start('AnalyzePrefs', analyzeNotificationPrefs)
      .addSelector(notificationSelector)
        .addFunctionBranch('email', 'SendEmail', sendEmail)
        .addFunctionBranch('sms', 'SendSMS', sendSMS)
        .addFunctionBranch('push', 'SendPush', sendPush)
        .end()
      .addFunction('ConfirmDelivery', confirmDelivery);

    const result = await builder.execute(scopeFactory);
    console.log('  Result:', JSON.stringify(result, null, 2));
  }

  console.log('\n✓ Selector demo complete!');
}

main().catch(console.error);
