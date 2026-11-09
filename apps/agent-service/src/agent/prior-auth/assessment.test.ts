import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IO_RETRY } from '../graph/retry.js';
import {
  ASSESS_PROMPT,
  AssessmentFormatError,
  assessmentPrompt,
  parseAssessment,
  stubAssessment,
} from './assessment.js';

const criteria = [
  { id: 'c1', title: 'First', requirement: 'Synthetic requirement one.' },
  { id: 'c2', title: 'Second', requirement: 'Synthetic requirement two.' },
];

describe('parseAssessment', () => {
  it('reads a finding per criterion', () => {
    const findings = parseAssessment(
      JSON.stringify({
        findings: [
          { criterionId: 'c1', status: 'met', evidence: ['Condition/a'], rationale: 'r' },
          { criterionId: 'c2', status: 'insufficient', evidence: [], rationale: 'r' },
        ],
      }),
    );
    expect(findings.map((finding) => finding.status)).toEqual(['met', 'insufficient']);
  });

  it('throws a retryable error on prose or a wrong shape', () => {
    for (const content of ['The request should be approved.', '{"findings":[{"status":"yes"}]}']) {
      let error: unknown;
      try {
        parseAssessment(content);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AssessmentFormatError);
      expect(error).not.toBeInstanceOf(z.ZodError);
      expect(IO_RETRY.retryOn?.(error)).toBe(true);
    }
  });

  it('refuses a finding that recommends an outcome', () => {
    expect(() =>
      parseAssessment(
        JSON.stringify({
          findings: [{ criterionId: 'c1', status: 'deny', evidence: [], rationale: 'r' }],
        }),
      ),
    ).toThrow(AssessmentFormatError);
  });
});

describe('assessmentPrompt', () => {
  it('is stable for the same request, which is what a cassette is keyed on', () => {
    const evidence = [{ reference: 'DocumentReference/d', text: 'A synthetic note.' }];
    expect(assessmentPrompt(criteria, evidence)).toBe(assessmentPrompt(criteria, evidence));
    expect(JSON.parse(assessmentPrompt(criteria, evidence))).toEqual({ criteria, evidence });
  });
});

describe('stubAssessment', () => {
  it('finds every criterion insufficient, so the stub axis refers everything', async () => {
    const findings = await stubAssessment.assessCriteria(criteria, []);
    expect(findings.map((finding) => finding.status)).toEqual(['insufficient', 'insufficient']);
  });
});

describe('ASSESS_PROMPT', () => {
  const BUNDLES = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    '..',
    'packages',
    'eval-harness',
    'datasets',
    'prior-auth',
    'bundles',
  );

  interface Resource {
    resourceType: string;
    content?: { attachment: { data?: string } }[];
  }

  /** Every DocumentReference's text, in every committed prior-auth bundle. */
  function noteTexts(): { bundles: number; texts: string[] } {
    const files = readdirSync(BUNDLES).filter((file) => file.endsWith('.bundle.json'));
    const texts = files.flatMap((file) => {
      const bundle = JSON.parse(readFileSync(join(BUNDLES, file), 'utf8')) as {
        entry: { resource: Resource }[];
      };
      return bundle.entry
        .map((entry) => entry.resource)
        .filter((resource) => resource.resourceType === 'DocumentReference')
        .flatMap((resource) => resource.content ?? [])
        .flatMap(({ attachment }) =>
          attachment.data === undefined ? [] : [Buffer.from(attachment.data, 'base64').toString()],
        );
    });
    return { bundles: files.length, texts };
  }

  /** Runs of four words, lowercased, with anything not a letter or digit a word break. */
  function fourWordRuns(text: string): Set<string> {
    const words = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word !== '');
    const runs = new Set<string>();
    for (let i = 0; i + 4 <= words.length; i += 1) runs.add(words.slice(i, i + 4).join(' '));
    return runs;
  }

  // P3-G: the prompt names the class of hedged evidence, not the bundles' words,
  // so a later edit cannot fix a task by quoting its fixture.
  it('shares no run of four words with any prior-auth bundle’s note text', () => {
    const { bundles, texts } = noteTexts();
    expect(bundles).toBe(24);

    const inNotes = new Set(texts.flatMap((text) => [...fourWordRuns(text)]));
    expect(inNotes.size).toBeGreaterThan(1000);
    expect([...fourWordRuns(ASSESS_PROMPT)].filter((run) => inNotes.has(run))).toEqual([]);
  });
});
