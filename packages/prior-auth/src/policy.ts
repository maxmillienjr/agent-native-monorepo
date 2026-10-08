import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * `data/` resolves the same from `src/` under Vitest and from `dist/` in the
 * built package, because both sit one level below the package root. It is the
 * same move as `EVAL_DATASETS_DIR` in `@repo/eval-harness`.
 */
export const PRIOR_AUTH_DATA_DIR = fileURLToPath(new URL('../data', import.meta.url));

/**
 * HCPCS Level II outside the D range, which is the ADA's CDT (ADR 0008). A
 * five-digit code is Level I, which is CPT, and never parses here.
 */
export const HcpcsLevelIICodeSchema = z.string().regex(/^[A-CE-V][0-9]{4}$/);

export const PolicyCriterionSchema = z
  .object({
    /** The key a `CriterionFinding.criterionId` must name. */
    id: z.string().min(1),
    /** Shown to the requester in a `ClaimResponse`. It is fixed text, never model output. */
    title: z.string().min(1),
    /** What the model is asked to check. */
    requirement: z.string().min(1),
  })
  .strict();
export type PolicyCriterion = z.infer<typeof PolicyCriterionSchema>;

/**
 * One fictional medical policy, keyed by the HCPCS Level II code it covers.
 *
 * `disclaimer` is required, so a policy file cannot be added without saying
 * that it is invented: ADR 0003 forbids medical policy text carried over from
 * a real payer, and a paraphrase of one is still that.
 */
export const PolicySchema = z
  .object({
    id: z.string().min(1),
    hcpcs: HcpcsLevelIICodeSchema,
    /** The CMS long descriptor, unchanged. */
    service: z.string().min(1),
    title: z.string().min(1),
    version: z.string().min(1),
    effective: z.string().date(),
    /** How long an automated approval's `preAuthPeriod` runs from the service date. */
    approvalPeriodDays: z.number().int().positive(),
    disclaimer: z.string().min(40),
    criteria: z.array(PolicyCriterionSchema).min(1),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const ids = policy.criteria.map((criterion) => criterion.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'criterion ids must be unique' });
    }
  });
export type Policy = z.infer<typeof PolicySchema>;

export const PayerSchema = z
  .object({
    disclaimer: z.string().min(40),
    notice: z.string().min(40),
    payer: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        identifier: z.object({ system: z.string().url(), value: z.string().min(1) }).strict(),
      })
      .strict(),
    plans: z
      .array(
        z
          .object({
            id: z.string().min(1),
            name: z.string().min(1),
            regime: z.literal('CMS-0057-F'),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type Payer = z.infer<typeof PayerSchema>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The fictional payer every committed request is addressed to. */
export function loadPayer(dataDir: string = PRIOR_AUTH_DATA_DIR): Payer {
  return PayerSchema.parse(readJson(join(dataDir, 'payer.json')));
}

/**
 * The policy catalogue, keyed by HCPCS code.
 *
 * Every `.json` under `data/policies/` is one policy. Two files claiming one
 * code is an error rather than a last-wins overwrite, because which criteria
 * a request is read against would then depend on directory order.
 */
export class PolicyCatalogue {
  private readonly byCode: ReadonlyMap<string, Policy>;

  constructor(policies: readonly Policy[]) {
    const byCode = new Map<string, Policy>();
    for (const policy of policies) {
      if (byCode.has(policy.hcpcs)) {
        throw new Error(`two policies cover HCPCS ${policy.hcpcs}`);
      }
      byCode.set(policy.hcpcs, policy);
    }
    this.byCode = byCode;
  }

  static load(dataDir: string = PRIOR_AUTH_DATA_DIR): PolicyCatalogue {
    const dir = join(dataDir, 'policies');
    const files = readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort();
    return new PolicyCatalogue(files.map((file) => PolicySchema.parse(readJson(join(dir, file)))));
  }

  forCode(hcpcs: string): Policy | undefined {
    return this.byCode.get(hcpcs);
  }

  all(): Policy[] {
    return [...this.byCode.values()];
  }
}
