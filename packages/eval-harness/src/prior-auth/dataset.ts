import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { EVAL_DATASETS_DIR } from '../dataset.js';
import { AxisRequirementsSchema, TaskSeedsSchema, type Suite, type Task } from '../types.js';
import {
  citationsResolve,
  dispositionKind,
  findingAgreement,
  noFalseApproval,
  type PriorAuthOutcome,
} from './graders.js';

/**
 * The prior-authorization suite (P3-D): 24 requests, six strata per policy,
 * each with a labelled correct disposition.
 *
 * This package does not depend on `@repo/prior-auth`. A task's input is the
 * request bundle as JSON, which `Task.input` already types as `unknown`, and
 * the outcome the graders read is the small shape in `graders.ts` that the
 * service's adapter fills in.
 */
export const PRIOR_AUTH_SUITE = 'prior-auth';
export const PRIOR_AUTH_DATASET_DIR = join(EVAL_DATASETS_DIR, 'prior-auth');

export const STATUS = z.enum(['met', 'not-met', 'insufficient']);
export const DISPOSITION_KIND = z.enum(['automated-approval', 'refer-to-clinician']);

export const PriorAuthTaskSpecSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    hcpcs: z.string().min(1),
    stratum: z.string().min(1),
    /** Relative to the dataset directory. */
    bundle: z.string().min(1),
    requires: AxisRequirementsSchema.optional(),
    /** The share of criteria whose status must match the label. */
    findingAgreementMin: z.number().min(0).max(1),
  })
  .strict();
export type PriorAuthTaskSpec = z.infer<typeof PriorAuthTaskSpecSchema>;

export const PriorAuthLabelSchema = z
  .object({
    hcpcs: z.string(),
    stratum: z.string(),
    disposition: DISPOSITION_KIND,
    assessed: z.boolean(),
    criteria: z.record(z.object({ status: STATUS, evidence: z.array(z.string()) }).strict()),
  })
  .strict();
export type PriorAuthLabel = z.infer<typeof PriorAuthLabelSchema>;

export const PriorAuthLabelsFileSchema = z
  .object({ description: z.string(), labels: z.record(PriorAuthLabelSchema) })
  .strict();

export interface PriorAuthLabels {
  readonly labels: Readonly<Record<string, PriorAuthLabel>>;
  /** The sha256 of `bundles/labels.json`, printed in the report. */
  readonly sha256: string;
}

export function loadPriorAuthLabels(datasetDir: string = PRIOR_AUTH_DATASET_DIR): PriorAuthLabels {
  const raw = readFileSync(join(datasetDir, 'bundles', 'labels.json'));
  return {
    labels: PriorAuthLabelsFileSchema.parse(JSON.parse(raw.toString('utf8'))).labels,
    sha256: createHash('sha256').update(raw).digest('hex'),
  };
}

/**
 * Loads every top-level `.json` in the dataset directory as a task, the way
 * `loadSuite` does, and joins each to its label. A task with no label, or a
 * label with no task, is an error: an unlabelled task cannot be graded, and an
 * orphaned label means a request was removed without anyone deciding to.
 */
export function loadPriorAuthSuite(
  trialsPerTask = 1,
  datasetDir: string = PRIOR_AUTH_DATASET_DIR,
): Suite<PriorAuthOutcome> & { readonly labels: PriorAuthLabels } {
  const labels = loadPriorAuthLabels(datasetDir);
  const files = readdirSync(datasetDir)
    .filter((file) => file.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new Error(`eval suite "${PRIOR_AUTH_SUITE}" loaded no tasks from ${datasetDir}`);
  }

  const tasks: Task<PriorAuthOutcome>[] = files.map((file) => {
    const spec = PriorAuthTaskSpecSchema.parse(
      JSON.parse(readFileSync(join(datasetDir, file), 'utf8')),
    );
    const label = labels.labels[spec.id];
    if (label === undefined) throw new Error(`task ${spec.id} has no label in labels.json`);

    return {
      id: spec.id,
      description: spec.description,
      input: JSON.parse(readFileSync(join(datasetDir, spec.bundle), 'utf8')) as unknown,
      // No seeds: the graph reads the bundle and nothing else. Parsed from the
      // schema so a seed tier added later defaults to empty here too.
      seeds: TaskSeedsSchema.parse({}),
      graders: [
        dispositionKind(label),
        noFalseApproval(label),
        findingAgreement(label, spec.findingAgreementMin),
        citationsResolve(),
      ],
      ...(spec.requires === undefined ? {} : { requires: spec.requires }),
    };
  });

  const taskIds = new Set(tasks.map((task) => task.id));
  const orphans = Object.keys(labels.labels).filter((id) => !taskIds.has(id));
  if (orphans.length > 0)
    throw new Error(`labels.json labels tasks that do not exist: ${orphans.join(', ')}`);

  return { name: PRIOR_AUTH_SUITE, tasks, trialsPerTask, labels };
}
