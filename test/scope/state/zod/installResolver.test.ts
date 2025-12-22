// Mock the core registry BEFORE importing the installer
jest.mock('../../../../src/scope/core/resolve', () => ({
  registerScopeResolver: jest.fn(),
}));

import { registerScopeResolver } from '../../../../src/scope/core/resolve';
import * as mod from '../../../../src/scope/state/installResolvers';

describe('zod/installResolvers', () => {
  function getInstaller(): (...args: any[]) => void {
    // tolerate any export name you chose
    const cand =
      (mod as any).installResolvers ||
      (mod as any).installDefaultResolvers ||
      (mod as any).installZodResolver ||
      (mod as any).default;
    if (typeof cand !== 'function') {
      throw new Error('No installer function exported from installResolvers.ts');
    }
    return cand as any;
  }

  beforeEach(() => {
    (registerScopeResolver as jest.Mock).mockClear();
  });

  it('registers the Zod resolver exactly once (idempotent)', () => {
    const install = getInstaller();

    install();
    install(); // call twice on purpose

    expect(registerScopeResolver).toHaveBeenCalledTimes(1);

    const arg = (registerScopeResolver as jest.Mock).mock.calls[0]?.[0];
    expect(arg).toBeTruthy();
    expect(typeof arg?.name).toBe('string');
    expect(typeof arg?.canHandle).toBe('function');
    expect(typeof arg?.makeProvider).toBe('function');
  });

  it('exposes a callable installer function', () => {
    const install = getInstaller();
    expect(typeof install).toBe('function');
  });
});
