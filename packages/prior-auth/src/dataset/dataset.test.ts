import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PolicyCatalogue, loadPayer } from '../policy.js';
import { coverageActiveOn, readSubmission, resolveReference } from '../request.js';
import { authorDataset } from './author.js';
import { PRIOR_AUTH_DATASET_DIR } from './location.js';
import { STRATA } from './scenarios.js';

const payer = loadPayer();
const catalogue = PolicyCatalogue.load();
const dataset = authorDataset(payer, catalogue.all());

describe('the committed prior-authorization dataset', () => {
  it('is exactly what scenarios.ts authors, so the readable copy is the real one', () => {
    const committed = new Map<string, string>();
    for (const file of readdirSync(PRIOR_AUTH_DATASET_DIR).filter((f) => f.endsWith('.json'))) {
      committed.set(file, readFileSync(join(PRIOR_AUTH_DATASET_DIR, file), 'utf8'));
    }
    const bundles = join(PRIOR_AUTH_DATASET_DIR, 'bundles');
    for (const file of readdirSync(bundles).filter((f) => f.endsWith('.json'))) {
      committed.set(`bundles/${file}`, readFileSync(join(bundles, file), 'utf8'));
    }

    expect([...committed.keys()].sort()).toEqual([...dataset.files.keys()].sort());
    for (const [path, contents] of dataset.files) {
      expect(committed.get(path), path).toBe(contents);
    }
  });

  it('holds six strata for each of the four policies', () => {
    expect(dataset.tasks).toHaveLength(24);
    for (const policy of catalogue.all()) {
      const strata = dataset.tasks
        .filter((task) => task.hcpcs === policy.hcpcs)
        .map((t) => t.stratum);
      expect([...strata].sort()).toEqual([...STRATA].sort());
    }
  });

  it('labels two approvals and four referrals per policy', () => {
    for (const policy of catalogue.all()) {
      const kinds = Object.values(dataset.labels)
        .filter((label) => label.hcpcs === policy.hcpcs)
        .map((label) => label.disposition);
      expect(kinds.filter((kind) => kind === 'automated-approval')).toHaveLength(2);
      expect(kinds.filter((kind) => kind === 'refer-to-clinician')).toHaveLength(4);
    }
  });

  it('reads every bundle as a $submit the surface can process', () => {
    for (const task of dataset.tasks) {
      const bundle: unknown = JSON.parse(dataset.files.get(task.bundle) ?? '');
      const submission = readSubmission(bundle, payer);
      expect(submission.kind, task.id).toBe('ok');
      if (submission.kind !== 'ok') continue;

      expect(submission.request.hcpcs).toBe(task.hcpcs);
      expect(coverageActiveOn(submission.request.coverage, submission.request.serviceDate)).toBe(
        task.stratum !== 'administrative',
      );

      // Every label's evidence names a resource in this bundle.
      for (const criterion of Object.values(dataset.labels[task.id]?.criteria ?? {})) {
        for (const reference of criterion.evidence) {
          expect(resolveReference(submission.request.bundle, reference), reference).toBeDefined();
        }
      }
    }
  });

  it('holds no NPI at all, and an example.org identifier on every practitioner and supplier', () => {
    for (const task of dataset.tasks) {
      const bundle = JSON.parse(dataset.files.get(task.bundle) ?? '') as {
        entry: { resource: { resourceType: string; identifier?: { system?: string }[] } }[];
      };
      for (const { resource } of bundle.entry) {
        for (const identifier of resource.identifier ?? []) {
          expect(identifier.system, resource.resourceType).toMatch(/^https:\/\/example\.org\//);
        }
      }
      expect(dataset.files.get(task.bundle)).not.toContain('us-npi');
    }
  });
});
