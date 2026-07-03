import { defineConfig } from 'vitest/config';

/**
 * Root Vitest config. `setupFiles` wires the anti-drift assertion guard
 * (test/setup/vitest-assertion-guard.mjs) into every test run so a passing test that
 * makes zero assertions FAILS — closing the "zero-assertion test still passes" drift gap.
 */
export default defineConfig({
  test: {
    setupFiles: ['./test/setup/vitest-assertion-guard.mjs'],
    passWithNoTests: false,
  },
});
