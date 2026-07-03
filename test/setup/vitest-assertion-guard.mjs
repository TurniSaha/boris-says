/**
 * test/setup/vitest-assertion-guard.mjs — anti-drift Vitest setup.
 *
 * A passing test that runs ZERO assertions ( `it('passes', () => {})` ) trivially satisfies
 * `numPassedTests > 0`. This setup fails any test whose `expect.getState().assertionCalls === 0`
 * in `afterEach`, so every test must actually assert something.
 *
 * Wired via vitest.config.mjs `test.setupFiles`. There is NO opt-out: a test MUST actually
 * assert. A test that genuinely needs to assert "this does not throw" must do so with a real
 * assertion (e.g. `expect(() => fn()).not.toThrow()`), which DOES increment assertionCalls.
 */
import { afterEach, expect } from 'vitest';

afterEach((ctx) => {
  const state = expect.getState();
  const calls = state.assertionCalls ?? 0;
  // ABSOLUTE: zero assertions in a test body is drift. No opt-out — a passing suite that asserts
  // nothing is exactly what the anti-drift gate must reject.
  if (calls === 0) {
    const name = ctx?.task?.name ?? 'unknown';
    throw new Error(
      `ZERO-ASSERTION test "${name}" ran no expect() — a passing-but-assertion-free test is `
      + `anti-drift drift and is rejected. Add a real assertion.`,
    );
  }
});
