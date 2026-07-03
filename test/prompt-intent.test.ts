/**
 * prompt-intent.test.ts — M1 relevance overhaul: the pure prompt-intent classifier.
 *
 * The GOAL.md relevance invariant's prompt-intent gate: read-only / investigative prompts
 * ("check X", "look at Y", "why does Z…") must suppress change-directed nudges. This module
 * is the DETECTOR only — pure, deterministic, transcript-blind, zero LLM. The two-sided
 * contract pinned here:
 *   - 'read_only' fires ONLY on a leading investigative shape AND no change-directed token
 *     anywhere (precision over recall: when in doubt → 'unknown').
 *   - 'unknown' is INERT — it never suppresses and never triggers anything. Terse expert
 *     prompts, mixed intent, and empty input all land here.
 */
import { describe, it, expect } from 'vitest';
import { classifyPromptIntent } from '../src/brain/prompt-intent.js';

describe('classifyPromptIntent — read_only positives (leading investigative shape, no veto)', () => {
  it('THE LIVE SPECIMEN: "check the deploy webhook config in the repo" → read_only', () => {
    // The prompt that received the irrelevant L34b prune nudge. "deploy" here is a NOUN
    // modifier ("the deploy webhook config"), not a change-directed verb.
    expect(classifyPromptIntent('check the deploy webhook config in the repo')).toBe('read_only');
  });

  it.each([
    'why does the login test fail intermittently',
    'look at the queue consumer and explain the retry logic',
    'show me where the rate limiter is configured',
    'how does the session store expire keys',
    'what does the 20260630 migration do',
  ])('%s → read_only', (prompt) => {
    expect(classifyPromptIntent(prompt)).toBe('read_only');
  });

  it('is case/punctuation robust: "Check the CI config?" → read_only', () => {
    expect(classifyPromptIntent('Check the CI config?')).toBe('read_only');
  });
});

describe('classifyPromptIntent — unknown on any change-directed token (the veto)', () => {
  it('mixed intent: "check the webhook config and fix the timeout" → unknown', () => {
    expect(classifyPromptIntent('check the webhook config and fix the timeout')).toBe('unknown');
  });

  it.each([
    'add a null check to the parser',
    'refactor the retry logic',
    'investigate and patch the leak',
    'why is this slow — optimize it',
  ])('%s → unknown', (prompt) => {
    expect(classifyPromptIntent(prompt)).toBe('unknown');
  });
});

describe('classifyPromptIntent — unknown on everything else (UNKNOWN is inert)', () => {
  it.each([
    '', //                                 empty
    '   ', //                              whitespace-only
    'the tests are red, why', //           non-leading question
    'now wire the export button to the new endpoint', // change-directed imperative
  ])('%j → unknown', (prompt) => {
    expect(classifyPromptIntent(prompt)).toBe('unknown');
  });
});
