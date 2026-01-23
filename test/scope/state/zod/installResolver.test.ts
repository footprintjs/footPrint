// Mock the core registry BEFORE importing the installer
jest.mock('../../../../src/scope/core/resolve', () => ({
  registerScopeResolver: jest.fn(),
}));

describe('zod/installResolvers', () => {
  beforeEach(() => {
    jest.resetModules();
    // Re-require the mock to get fresh mock state
    const { registerScopeResolver } = require('../../../../src/scope/core/resolve');
    (registerScopeResolver as jest.Mock).mockClear();
  });

  function getInstallerAndMock(): { install: (...args: any[]) => void; mockFn: jest.Mock } {
    // Re-import after resetModules to get fresh module state
    const { registerScopeResolver } = require('../../../../src/scope/core/resolve');
    const mod = require('../../../../src/scope/state/installResolvers');
    const cand =
      mod.installResolvers ||
      mod.installDefaultResolvers ||
      mod.installZodResolver ||
      mod.default;
    if (typeof cand !== 'function') {
      throw new Error('No installer function exported from installResolvers.ts');
    }
    return { install: cand as any, mockFn: registerScopeResolver as jest.Mock };
  }

  it('registers the Zod resolver exactly once (idempotent)', () => {
    // First import triggers auto-registration
    const { install, mockFn } = getInstallerAndMock();
    
    // The module auto-calls installDefaultResolvers() on import
    // So it should already be registered once
    expect(mockFn).toHaveBeenCalledTimes(1);

    // Calling again should not register again (idempotent)
    install();
    install();
    expect(mockFn).toHaveBeenCalledTimes(1);

    const arg = mockFn.mock.calls[0]?.[0];
    expect(arg).toBeTruthy();
    expect(typeof arg?.name).toBe('string');
    expect(typeof arg?.canHandle).toBe('function');
    expect(typeof arg?.makeProvider).toBe('function');
  });

  it('exposes a callable installer function', () => {
    const { install } = getInstallerAndMock();
    expect(typeof install).toBe('function');
  });
});
