import type { INestApplicationContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPriorAuthSuite } from '@repo/eval-harness';
import { InMemoryCaseRepository } from '@repo/memory-core';
import { PriorAuthService } from '../fhir/prior-auth.service.js';
import { RunsService } from '../runs/runs.service.js';
import { PriorAuthHarness } from './prior-auth-harness.js';

/**
 * The prior-auth adapter on the stub model axis: what it hands the graders
 * from a referral, from an administrative referral, and from an approval.
 */
describe('PriorAuthHarness', () => {
  const key = process.env['GOOGLE_API_KEY'];
  const suite = loadPriorAuthSuite();
  const task = (id: string) => {
    const found = suite.tasks.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`no task ${id}`);
    return found;
  };

  let runs: RunsService;
  let harness: PriorAuthHarness;

  beforeAll(() => {
    delete process.env['GOOGLE_API_KEY'];
    runs = new RunsService(null, null, null, null, null, null);
    const service = new PriorAuthService(
      runs,
      null,
      {
        now: () => new Date('2026-09-22T10:00:00Z'),
      },
      null,
      new InMemoryCaseRepository(),
    );
    const context = { close: async () => {} } as unknown as INestApplicationContext;
    harness = new PriorAuthHarness(context, service, runs);
  });

  afterAll(() => {
    if (key !== undefined) process.env['GOOGLE_API_KEY'] = key;
  });

  async function trial(id: string) {
    await harness.reset(task(id));
    const transcript = await harness.run(task(id));
    return { transcript, outcome: await harness.captureOutcome(task(id), transcript) };
  }

  it('reports a stub referral with every criterion insufficient and nothing cited', async () => {
    const { transcript, outcome } = await trial('pa-e0601-all-met-structured');
    expect(transcript.nodeSequence).toEqual(['intake', 'lookup', 'assess', 'dispose']);
    expect(outcome.disposition).toBe('refer-to-clinician');
    expect(outcome.assessed).toBe(true);
    expect(outcome.findings.map((finding) => finding.status)).toEqual([
      'insufficient',
      'insufficient',
      'insufficient',
      'insufficient',
    ]);
    expect(outcome.citations).toEqual([]);
    expect(outcome.resourceIds).toContain('Claim/claim-e0601-all-met-structured');
  });

  it('reports an administrative referral as not assessed', async () => {
    const { outcome } = await trial('pa-e0601-administrative');
    expect(outcome).toMatchObject({
      disposition: 'refer-to-clinician',
      assessed: false,
      findings: [],
    });
  });

  it('grades a labelled task end to end: the stub refers an approval-labelled request', async () => {
    const graded = task('pa-k0823-all-met-structured');
    const { transcript, outcome } = await trial(graded.id);
    const results = await Promise.all(graded.graders.map((g) => g.grade(transcript, outcome)));
    expect(results.map((r) => r.label)).toEqual(['fail', 'pass', 'fail', 'pass']);
  });
});
