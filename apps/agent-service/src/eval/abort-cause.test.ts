import { describe, expect, it } from 'vitest';
import { CassetteIncompatibleError, CassetteMissError } from '@repo/agent-cassette';
import { RE_RECORD_COMMAND, UPDATE_BASELINE_COMMAND, explainAbort } from './abort-cause.js';

const noTrials = { completed: [] };

describe('explainAbort', () => {
  it('names a cassette miss and gives the re-record command', () => {
    const cause = explainAbort(
      new CassetteMissError('plan.callLlm', undefined, 'abc123', '- old\n+ new'),
      noTrials,
    );

    expect(cause?.code).toBe('cassette-miss');
    expect(cause?.remedy).toContain(`\`${RE_RECORD_COMMAND}\``);
    expect(cause?.remedy).toContain(`\`${UPDATE_BASELINE_COMMAND}\``);
  });

  it('names a set the player refuses, and gives the same two commands', () => {
    const cause = explainAbort(
      new CassetteIncompatibleError(['formatVersion is 1, this player reads 2']),
      noTrials,
    );

    expect(cause?.code).toBe('cassette-incompatible');
    expect(cause?.summary).toContain('before any store was reset');
    expect(cause?.remedy).toContain(`\`${RE_RECORD_COMMAND}\``);
    expect(cause?.remedy).toContain(`\`${UPDATE_BASELINE_COMMAND}\``);
  });

  it('is the README command, so the two cannot drift apart unnoticed', () => {
    expect(RE_RECORD_COMMAND).toBe('EVAL_CASSETTE_MODE=record EVAL_TRIALS=1 yarn eval');
  });

  it('has no named cause for an error it cannot act on', () => {
    expect(explainAbort(new Error('connect ECONNREFUSED'), noTrials)).toBeUndefined();
    expect(explainAbort('a string', noTrials)).toBeUndefined();
  });
});
