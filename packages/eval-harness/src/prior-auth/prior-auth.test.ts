import { describe, expect, it } from 'vitest';
import type { SuiteReport, Transcript, Trial } from '../types.js';
import { renderMarkdownSummary } from '../reporters/summary.js';
import { loadPriorAuthSuite, type PriorAuthLabel } from './dataset.js';
import { priorAuthFigures } from './figures.js';
import {
  citationsResolve,
  dispositionKind,
  findingAgreement,
  noFalseApproval,
  type PriorAuthOutcome,
} from './graders.js';

const transcript = {} as Transcript;

const label = (overrides: Partial<PriorAuthLabel> = {}): PriorAuthLabel => ({
  hcpcs: 'E0601',
  stratum: 'one-missing',
  disposition: 'refer-to-clinician',
  assessed: true,
  criteria: {
    c1: { status: 'met', evidence: ['Condition/a'] },
    c2: { status: 'insufficient', evidence: [] },
  },
  ...overrides,
});

const outcome = (overrides: Partial<PriorAuthOutcome> = {}): PriorAuthOutcome => ({
  disposition: 'refer-to-clinician',
  assessed: true,
  findings: [
    { criterionId: 'c1', status: 'met' },
    { criterionId: 'c2', status: 'insufficient' },
  ],
  citations: ['Condition/a'],
  resourceIds: ['Condition/a', 'DocumentReference/b'],
  ...overrides,
});

describe('loadPriorAuthSuite', () => {
  const suite = loadPriorAuthSuite();

  it('loads 24 tasks, each with the four graders and a requirement for a real model', () => {
    expect(suite.tasks).toHaveLength(24);
    for (const task of suite.tasks) {
      expect(task.graders.map((grader) => grader.name)).toEqual([
        'disposition_kind',
        'no_false_approval',
        'finding_agreement',
        'citations_resolve',
      ]);
      expect(task.requires).toEqual({ model: ['live', 'replay'] });
      expect((task.input as { resourceType: string }).resourceType).toBe('Bundle');
    }
  });

  it('names the labels file by its sha256', () => {
    expect(suite.labels.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the prior-authorization graders', () => {
  it('disposition_kind compares the kind with the label', async () => {
    expect((await dispositionKind(label()).grade(transcript, outcome())).label).toBe('pass');
    const approved = outcome({ disposition: 'automated-approval' });
    expect((await dispositionKind(label()).grade(transcript, approved)).label).toBe('fail');
  });

  it('no_false_approval fails an approval of a referral-labelled request, and is vacuous otherwise', async () => {
    const approved = outcome({ disposition: 'automated-approval' });
    expect((await noFalseApproval(label()).grade(transcript, approved)).label).toBe('fail');
    const approvalLabel = label({ disposition: 'automated-approval' });
    expect((await noFalseApproval(approvalLabel).grade(transcript, outcome())).label).toBe('pass');
  });

  it('finding_agreement passes at the threshold and fails below it', async () => {
    const half = outcome({ findings: [{ criterionId: 'c1', status: 'met' }] });
    expect((await findingAgreement(label(), 0.5).grade(transcript, half)).label).toBe('pass');
    expect((await findingAgreement(label(), 0.75).grade(transcript, half)).label).toBe('fail');
  });

  it('finding_agreement on an unassessed label passes only when nothing was assessed', async () => {
    const unassessed = label({ assessed: false, stratum: 'administrative' });
    const skipped = outcome({ assessed: false, findings: [], citations: [] });
    expect((await findingAgreement(unassessed, 0.75).grade(transcript, skipped)).label).toBe(
      'pass',
    );
    expect((await findingAgreement(unassessed, 0.75).grade(transcript, outcome())).label).toBe(
      'fail',
    );
  });

  it('citations_resolve fails a citation of a resource the bundle does not hold', async () => {
    const stray = outcome({ citations: ['Condition/a', 'Observation/elsewhere'] });
    expect((await citationsResolve().grade(transcript, stray)).label).toBe('fail');
    expect((await citationsResolve().grade(transcript, outcome())).label).toBe('pass');
  });
});

describe('priorAuthFigures', () => {
  const suite = loadPriorAuthSuite();

  it('says the figures were not measured when the stub axis skipped every task', () => {
    const report: SuiteReport<PriorAuthOutcome> = {
      suite: 'prior-auth',
      startedAt: '',
      finishedAt: '',
      axes: { model: 'stub', memory: 'unconfigured' },
      trialsPerTask: 1,
      tasks: [],
      passRate: 0,
      skipped: suite.tasks.map((task) => ({
        taskId: task.id,
        problems: ['needs model live or replay'],
      })),
      uncalibratedGraders: [],
      genAiSemconvCommit: '',
      budgetBreaches: 0,
      usage: { checked: false, reason: 'model `stub` has no inference spans', trials: [] },
    };
    const figures = priorAuthFigures(report, suite.labels);
    expect(figures[0]?.value).toBe('not measured: 0 of 24 tasks ran on model `stub`');

    const summary = renderMarkdownSummary({ ...report, figures });
    expect(summary).toContain('**Wrongful approval count:** not measured: 0 of 24 tasks');
    expect(summary).toContain('over 0 of 24 tasks');
  });

  it('counts a wrongful approval and an unnecessary referral against their denominators', () => {
    const trial = (taskId: string, disposition: PriorAuthOutcome['disposition']) =>
      ({
        taskId,
        index: 0,
        transcript,
        outcome: outcome({ disposition }),
        results: [],
        passed: false,
        budgets: [],
        withinBudget: true,
      }) as Trial<PriorAuthOutcome>;
    const report = {
      suite: 'prior-auth',
      axes: { model: 'replay', memory: 'live' },
      skipped: [],
      tasks: [
        {
          taskId: 'pa-e0601-one-missing',
          trials: [trial('pa-e0601-one-missing', 'automated-approval')],
        },
        {
          taskId: 'pa-e0601-all-met-structured',
          trials: [trial('pa-e0601-all-met-structured', 'refer-to-clinician')],
        },
      ],
    } as unknown as SuiteReport<PriorAuthOutcome>;

    const figures = priorAuthFigures(report, suite.labels);
    expect(figures[0]?.value).toBe('1 of 1 referral-labelled trial(s)');
    expect(figures[1]?.value).toBe('1/1 (100%) of approval-labelled trials');
  });
});
