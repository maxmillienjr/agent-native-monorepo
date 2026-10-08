import { canonicalJson } from '@repo/agent-cassette';
import type { ReplayReport } from './replay-run.js';

/** The report a person reads. `--json` is the one a program reads. */
export function render(report: ReplayReport): string {
  const lines: string[] = [`audit:replay ${report.runId}`];
  const record = report.record;

  if (record !== undefined) {
    lines.push(
      `  graph      ${record.graph}, model ${record.modelAxis}, outcome ${record.outcome ?? '(never closed)'}`,
      `  received   ${record.startedAt.toISOString()}`,
      `  commit     ${record.gitSha ?? '(none)'}${record.gitDirty === true ? ' (recorded from a dirty tree: the sha does not name the code exactly)' : ''}`,
      `  this build ${report.buildSha ?? '(none)'}`,
    );
  }
  if (report.request !== undefined) lines.push(`  request    ${canonicalJson(report.request)}`);

  if (report.verdict === 'refused') {
    lines.push('', `refused: ${report.reason ?? ''}`, 'verdict: refused (exit 2)', '');
    return lines.join('\n');
  }

  lines.push('', '  step  node        checkpoint  decisions served          channels changed');
  for (const step of report.steps) {
    const match = step.match === null ? '-' : step.match ? 'match' : 'DIVERGED';
    lines.push(
      `  ${String(step.step).padStart(4)}  ${step.node.padEnd(10)}  ${match.padEnd(10)}  ` +
        `${(step.decisions.join(', ') || '-').padEnd(24)}  ${step.changed.join(', ') || '-'}`,
    );
  }

  lines.push('');
  if (report.verdict === 'reconstructed') {
    lines.push(
      `  ${report.recordedCheckpoints} checkpoints and ${report.decisions.recorded} decisions, ` +
        'read without re-executing; decisions are attributed by the seams each node owns.',
      'verdict: reconstructed (exit 0)',
      '',
    );
    return lines.join('\n');
  }

  const matched = report.steps.filter((step) => step.match === true).length;
  lines.push(
    `  ${matched} of ${report.recordedCheckpoints} recorded checkpoints match; ` +
      `the replay left ${report.replayedCheckpoints}.`,
    `  ${report.decisions.consumed} of ${report.decisions.recorded} recorded decisions consumed.`,
  );
  if (report.decisions.unconsumed.length > 0) {
    lines.push(
      `  unconsumed: ${report.decisions.unconsumed.map((entry) => entry.seam).join(', ')}`,
    );
  }
  if (report.replayError !== undefined) lines.push(`  the replay threw: ${report.replayError}`);

  if (report.writes.length > 0) {
    lines.push(
      '',
      '  memory writes the run made (derived from the replay, not read from a store):',
    );
    for (const write of report.writes) lines.push(`    ${describeWrite(write)}`);
  }

  if (report.divergence !== undefined) {
    lines.push(
      '',
      `first divergent step: ${report.divergence.step} (${report.divergence.node}), ` +
        `channels ${report.divergence.channels.join(', ')}`,
      report.divergence.diff,
    );
  }
  if (report.reason !== undefined) lines.push('', report.reason);
  lines.push(`verdict: ${report.verdict} (exit ${report.exitCode})`, '');
  return lines.join('\n');
}

function describeWrite(write: ReplayReport['writes'][number]): string {
  switch (write.store) {
    case 'episodes':
      return `episodes        session ${write.sessionId} turn ${write.turnIndex}`;
    case 'neo4j.concept':
      return `neo4j :Concept  ${write.id}`;
    case 'neo4j.relationship':
      return `neo4j :RELATES_TO ${write.fromId} -[${write.type}]-> ${write.toId}`;
    case 'neo4j.fact':
      return `neo4j :Fact     ${write.contentHash}`;
    case 'semantic_facts':
      return `semantic_facts  ${write.contentHash}`;
  }
}
