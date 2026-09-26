import {
  compareCells,
  replayCells,
  type GradedReport,
  type ReplayBaseline,
  type ReplayCell,
} from './baseline.js';

/**
 * The replay gate: a snapshot comparison, not a test statistic (P1-D).
 *
 * Trial `i` of a task replays cassette `i` in the baseline run and in this
 * one, so the two share every model decision. A per-cell difference is then
 * −1, 0 or +1 with zero variance, and a bootstrap of it returns `[d, d]`: any
 * flip is certain evidence that the code changed. So every cell is compared
 * exactly, and every difference blocks — there is no multiple-comparisons
 * problem in twenty-one exact comparisons, and no noise to set a margin
 * against.
 */

/**
 * Why a cell, or the whole set, differs from the baseline.
 *
 * `improved` blocks as well as `regressed`. If it did not, the baseline would
 * keep an expected `fail`, and a later regression back to `fail` would match
 * it. Accepting any of these is `EVAL_GATE=update` and a reviewed diff.
 */
export const REPLAY_DIFFERENCE_KINDS = [
  'stale-digest',
  'regressed',
  'improved',
  'value-moved',
  'missing',
  'unbaselined',
] as const;
export type ReplayDifferenceKind = (typeof REPLAY_DIFFERENCE_KINDS)[number];

export type ReplayDifference =
  | {
      readonly kind: 'stale-digest';
      /** The digest the baseline was written against, and the one on disk. */
      readonly baseline: string;
      readonly current: string;
    }
  | {
      readonly kind: 'regressed' | 'improved' | 'value-moved';
      readonly cell: Pick<ReplayCell, 'task' | 'trial' | 'grader'>;
      readonly baseline: Pick<ReplayCell, 'label' | 'value'>;
      readonly run: Pick<ReplayCell, 'label' | 'value'>;
    }
  | {
      /** In the baseline, not produced by the run: a skipped task, a deleted assertion. */
      readonly kind: 'missing';
      readonly cell: Pick<ReplayCell, 'task' | 'trial' | 'grader'>;
      readonly baseline: Pick<ReplayCell, 'label' | 'value'>;
    }
  | {
      /** Produced by the run, not in the baseline: a new task, trial or assertion. */
      readonly kind: 'unbaselined';
      readonly cell: Pick<ReplayCell, 'task' | 'trial' | 'grader'>;
      readonly run: Pick<ReplayCell, 'label' | 'value'>;
    };

export interface ReplayComparison {
  readonly verdict: 'match' | 'differs';
  /** Cells in the run and in the baseline, so a reader can see what "match" was over. */
  readonly runCells: number;
  readonly baselineCells: number;
  readonly differences: readonly ReplayDifference[];
}

/**
 * Compares a completed replayed run with the committed baseline, cell by cell.
 *
 * `cassetteDigest` is the digest of the set on disk now. A baseline written
 * against a different set is `stale-digest` whatever its cells say: a
 * re-recorded set can reproduce every label and still be a different
 * recording, and the snapshot must be regenerated beside it so that the two
 * are reviewed together.
 */
export function compareReplay(
  report: GradedReport,
  baseline: ReplayBaseline,
  cassetteDigest: string,
): ReplayComparison {
  const run = replayCells(report);
  const expected = [...baseline.cells].sort(compareCells);
  const differences: ReplayDifference[] = [];

  if (baseline.cassetteDigest !== cassetteDigest) {
    differences.push({
      kind: 'stale-digest',
      baseline: baseline.cassetteDigest,
      current: cassetteDigest,
    });
  }

  // A merge over two sorted lists, so each difference comes out in cell order.
  let i = 0;
  let j = 0;
  while (i < expected.length || j < run.length) {
    const want = expected[i];
    const got = run[j];
    const order = want === undefined ? 1 : got === undefined ? -1 : compareCells(want, got);

    if (order < 0) {
      differences.push({ kind: 'missing', cell: key(want!), baseline: result(want!) });
      i += 1;
    } else if (order > 0) {
      differences.push({ kind: 'unbaselined', cell: key(got!), run: result(got!) });
      j += 1;
    } else {
      const kind =
        want!.label === 'pass' && got!.label === 'fail'
          ? 'regressed'
          : want!.label === 'fail' && got!.label === 'pass'
            ? 'improved'
            : want!.value !== got!.value
              ? 'value-moved'
              : undefined;
      if (kind !== undefined) {
        differences.push({ kind, cell: key(want!), baseline: result(want!), run: result(got!) });
      }
      i += 1;
      j += 1;
    }
  }

  return {
    verdict: differences.length === 0 ? 'match' : 'differs',
    runCells: run.length,
    baselineCells: expected.length,
    differences,
  };
}

const key = (cell: ReplayCell): Pick<ReplayCell, 'task' | 'trial' | 'grader'> => ({
  task: cell.task,
  trial: cell.trial,
  grader: cell.grader,
});

const result = (cell: ReplayCell): Pick<ReplayCell, 'label' | 'value'> => ({
  label: cell.label,
  value: cell.value,
});

/** How many differences of each kind, in the fixed order the summary prints them. */
export function countDifferences(
  differences: readonly ReplayDifference[],
): Record<ReplayDifferenceKind, number> {
  const counts = Object.fromEntries(REPLAY_DIFFERENCE_KINDS.map((kind) => [kind, 0])) as Record<
    ReplayDifferenceKind,
    number
  >;
  for (const difference of differences) counts[difference.kind] += 1;
  return counts;
}
