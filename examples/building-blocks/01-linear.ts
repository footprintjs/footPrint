/**
 * Flowchart: Linear Pipeline
 *
 * The simplest flow — stages execute one after another.
 *
 *   FetchUser -> EnrichProfile -> SendWelcomeEmail
 *
 * In the playground, edit the INPUT panel to change the user data.
 * Try it: https://footprintjs.github.io/footprint-playground/samples/linear
 */

import { flowChart,  FlowChartExecutor } from 'footprintjs';

declare const INPUT: any;

interface UserState {
  user: { username: string; email: string; joinedAt: string };
  displayName: string;
  memberDays: number;
  tier: string;
  emailSent: boolean;
  greeting: string;
}

(async () => {

const input: { userId: number } =
  (typeof INPUT !== 'undefined' && INPUT) || { userId: 42 };

const userDB = new Map([
  [42, { username: 'alice', email: 'alice@example.com', joinedAt: '2024-01-15' }],
  [99, { username: 'bob', email: 'bob@example.com', joinedAt: '2025-06-01' }],
]);

const emailLog: string[] = [];

const chart = flowChart<UserState>('FetchUser', async (scope) => {
  const { userId } = scope.$getArgs<{ userId: number }>();
  const user = userDB.get(userId);
  if (!user) throw new Error(`User #${userId} not found`);
  scope.user = user;
}, 'fetch-user')

  .addFunction('EnrichProfile', async (scope) => {
    const displayName = scope.user.username.charAt(0).toUpperCase() + scope.user.username.slice(1);
    const daysSinceJoin = Math.floor(
      (Date.now() - new Date(scope.user.joinedAt).getTime()) / 86_400_000,
    );
    scope.displayName = displayName;
    scope.memberDays = daysSinceJoin;
    scope.tier = daysSinceJoin > 365 ? 'veteran' : 'newcomer';
  }, 'enrich-profile')
  .addFunction('SendWelcomeEmail', async (scope) => {
    const message = scope.tier === 'veteran'
      ? `Welcome back, ${scope.displayName}! Thanks for being a loyal member.`
      : `Welcome, ${scope.displayName}! We're glad you're here.`;

    emailLog.push(`-> ${scope.user.email}: ${message}`);
    scope.emailSent = true;
    scope.greeting = message;
  }, 'send-welcome-email')
  .build();

const executor = new FlowChartExecutor(chart);
executor.enableNarrative();
await executor.run({ input });

console.log('=== Linear Pipeline ===\n');
executor.getNarrativeEntries().map(e => e.text).forEach((line) => console.log(`  ${line}`));
console.log('\n--- Email Log ---');
emailLog.forEach((line) => console.log(`  ${line}`));
})().catch(console.error);
