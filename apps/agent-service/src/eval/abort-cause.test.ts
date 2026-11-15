import { describe, expect, it } from 'vitest';
import { CassetteIncompatibleError, CassetteMissError } from '@repo/agent-cassette';
import { explainAbort, reRecordCommand, updateBaselineCommand } from './abort-cause.js';

const noTrials = { completed: [] };

describe('explainAbort', () => {
  it('names a cassette miss and gives the re-record command', () => {
    const cause = explainAbort(
      new CassetteMissError('plan.callLlm', undefined, 'abc123', '- old\n+ new'),
      noTrials,
      'memory-recall',
    );

    expect(cause?.code).toBe('cassette-miss');
    expect(cause?.remedy).toContain(`\`${reRecordCommand('memory-recall')}\``);
    expect(cause?.remedy).toContain(`\`${updateBaselineCommand('memory-recall')}\``);
  });

  it('names the suite that was running, so the commands refresh its set and not the default', () => {
    const cause = explainAbort(
      new CassetteMissError('assess.criteria', undefined, 'abc123', '- old\n+ new'),
      noTrials,
      'prior-auth',
    );

    expect(cause?.remedy).toContain(
      '`EVAL_SUITE=prior-auth EVAL_CASSETTE_MODE=record EVAL_TRIALS=1 yarn eval`',
    );
    expect(cause?.remedy).toContain(
      '`EVAL_SUITE=prior-auth EVAL_CASSETTE_MODE=replay EVAL_GATE=update yarn eval`',
    );
  });

  it('names a set the player refuses, and gives the same two commands', () => {
    const cause = explainAbort(
      new CassetteIncompatibleError(['formatVersion is 2, this player reads 3']),
      noTrials,
      'red-team',
    );

    expect(cause?.code).toBe('cassette-incompatible');
    expect(cause?.summary).toContain('before any store was reset');
    expect(cause?.remedy).toContain(`\`${reRecordCommand('red-team')}\``);
    expect(cause?.remedy).toContain(`\`${updateBaselineCommand('red-team')}\``);
  });

  it('has no named cause for an error it cannot act on', () => {
    expect(
      explainAbort(new Error('connect ECONNREFUSED'), noTrials, 'memory-recall'),
    ).toBeUndefined();
    expect(explainAbort('a string', noTrials, 'memory-recall')).toBeUndefined();
  });
});
