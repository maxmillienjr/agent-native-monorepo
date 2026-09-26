import type { AbortError, CompletedTrial, EvalAbort, Trial } from '../types.js';

/** A finished trial, as an abort file lists it. */
export function completedTrial(trial: Trial<unknown>): CompletedTrial {
  return {
    taskId: trial.taskId,
    index: trial.index,
    runId: trial.transcript.runId,
    passed: trial.passed,
    failedGraders: trial.results
      .filter((result) => result.score.label === 'fail')
      .map((result) => result.grader),
  };
}

/**
 * Whatever was thrown, as an `AbortError`.
 *
 * `status` and `errorDetails` are read off the object because that is where
 * both model clients put them. Nothing else on the error is copied: a client
 * error can carry a request, and the abort file is uploaded as an artifact.
 * Redacting key-shaped strings is the caller's, which is the side that already
 * depends on `@repo/agent-cassette`'s redaction; this package does not.
 */
export function abortError(error: unknown): AbortError {
  if (!(error instanceof Error)) return { name: 'NonError', message: String(error) };

  const extra = error as { status?: unknown; errorDetails?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof extra.status === 'number' ? { status: extra.status } : {}),
    ...(extra.errorDetails === undefined ? {} : { errorDetails: extra.errorDetails }),
  };
}

export function renderAbortJson(abort: EvalAbort): string {
  return `${JSON.stringify(abort, null, 2)}\n`;
}

/** A fence longer than any run of backticks in the text, so a message cannot close it. */
function fence(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The job-summary Markdown for a run that did not complete.
 *
 * The heading says `aborted` and the page carries no rate, because there is
 * none: a reader skimming a list of job summaries must not be able to mistake
 * this page for a failed suite, whose rate means something changed. The error
 * is printed whole — for a `CassetteMissError` the message is the diff that
 * says which prompt moved.
 */
export function renderAbortSummary(abort: EvalAbort): string {
  const lines: string[] = [
    `## Eval — aborted`,
    '',
    `**Suite:** \`${abort.suite}\` · ` +
      (abort.axes === undefined
        ? '**axes not detected**'
        : `**Axes:** model \`${abort.axes.model}\`, memory \`${abort.axes.memory}\``) +
      ' · the suite did not complete, so there is no pass rate.',
  ];

  if (abort.replay !== undefined) {
    lines.push(
      '',
      `**Replaying ${abort.replay.cassettes} cassette(s)** recorded ` +
        `\`${abort.replay.recordedAt}\` at \`${abort.replay.gitSha}\`.`,
    );
  }

  if (abort.cause !== undefined) {
    lines.push('', `**Cause (\`${abort.cause.code}\`):** ${abort.cause.summary}`);
    if (abort.cause.remedy !== undefined) lines.push('', `**To fix:** ${abort.cause.remedy}`);
  }

  const message = abort.error.message;
  const status = abort.error.status === undefined ? '' : ` (status ${abort.error.status})`;
  lines.push(
    '',
    `**\`${abort.error.name}\`**${status}`,
    '',
    fence(message) + 'text',
    message,
    fence(message),
  );

  lines.push('', '### Trials completed before the abort', '');
  if (abort.completedTrials.length === 0) {
    lines.push('None. The run stopped before its first trial finished.');
  } else {
    lines.push(
      '| Task | Trial | Passed | Failed graders |',
      '| ---- | ----- | ------ | -------------- |',
    );
    for (const trial of abort.completedTrials) {
      const failed = trial.failedGraders.map((grader) => `\`${grader}\``).join(', ') || '—';
      lines.push(
        `| \`${trial.taskId}\` | ${trial.index + 1} | ${trial.passed ? '✅' : '❌'} | ${failed} |`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
}
