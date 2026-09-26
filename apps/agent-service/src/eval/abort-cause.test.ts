import { describe, expect, it } from 'vitest';
import { CassetteMissError } from '@repo/agent-cassette';
import { RE_RECORD_COMMAND, explainAbort } from './abort-cause.js';

const noTrials = { completed: [] };

describe('explainAbort', () => {
  it('names a cassette miss and gives the re-record command', () => {
    const cause = explainAbort(
      new CassetteMissError('plan.callLlm', undefined, 'abc123', '- old\n+ new'),
      noTrials,
    );

    expect(cause?.code).toBe('cassette-miss');
    expect(cause?.remedy).toContain(`\`${RE_RECORD_COMMAND}\``);
  });

  it('is the README command, so the two cannot drift apart unnoticed', () => {
    expect(RE_RECORD_COMMAND).toBe('EVAL_CASSETTE_MODE=record EVAL_TRIALS=1 yarn eval');
  });

  it('has no named cause for an error it cannot act on', () => {
    expect(explainAbort(new Error('connect ECONNREFUSED'), noTrials)).toBeUndefined();
    expect(explainAbort('a string', noTrials)).toBeUndefined();
  });
});
